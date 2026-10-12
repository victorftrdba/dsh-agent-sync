// Smoke tests for the dsh-agent-sync host module.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { name, inject, apply } from './index.mjs'

test('module shape', () => {
  assert.equal(name, 'dsh-agent-sync')
  assert.ok(Array.isArray(inject))
  assert.equal(typeof apply, 'function')
})

test('apply registers tools and returns a disposer', () => {
  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    get: () => undefined,
    logger: { warn: () => {} },
  }
  const dispose = apply(ctx)
  assert.equal(typeof dispose, 'function')
  assert.ok(registered.length >= 5, `expected >=5 tools, got ${registered.length}`)
  const toolNames = registered.map((t) => t.name)
  for (const expected of ['agent_sync_scan', 'agent_sync_do', 'agent_sync_status', 'agent_sync_remove', 'agent_sync_sources']) {
    assert.ok(toolNames.includes(expected), `missing tool ${expected}`)
  }
  dispose() // must not throw
})

function fixture(files, requests, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-test-'))
  const dsh = join(home, '.dsh')
  for (const [path, content] of Object.entries(files)) {
    const target = join(home, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, (typeof content === 'string' ? content : JSON.stringify(content)).replaceAll('__FIXTURE_HOME__', home))
  }
  const script = `
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    import { join } from 'node:path'
    if (process.env.TEST_RENAME_FAILURE) {
      const original = fs.rename
      fs.rename = async (source, target) => {
        if (target === join(process.env.DSH_HOME, 'agent-sync/state.json')) {
          if (process.env.TEST_ROLLBACK_CONFLICT) await fs.writeFile(join(process.env.DSH_HOME, 'profiles/headless/cordis.patch.yml'), '- insert: []\\n# concurrent edit\\n')
          throw new Error('hostile-secret-transaction-error')
        }
        return original(source, target)
      }
      syncBuiltinESMExports()
    }
    const { apply } = await import('./index.mjs')
    const tools = new Map()
    const dispose = apply({ tools: { register: tool => tools.set(tool.name, tool) }, get: () => undefined, logger: { warn: () => {} } })
    const requests = JSON.parse(process.env.TEST_REQUESTS)
    const invoke = async request => JSON.parse(await tools.get(request.name).execute(request.args))
    const results = process.env.TEST_CONCURRENT ? await Promise.all(requests.map(invoke)) : []
    if (!process.env.TEST_CONCURRENT) for (const request of requests) results.push(await invoke(request))
    dispose()
    console.log(JSON.stringify(results))
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dirname(new URL(import.meta.url).pathname), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, DSH_HOME: dsh, TEST_REQUESTS: JSON.stringify(requests),
      TEST_RENAME_FAILURE: options.renameFailure ? '1' : '', TEST_ROLLBACK_CONFLICT: options.rollbackConflict ? '1' : '',
      TEST_CONCURRENT: options.concurrent ? '1' : '' },
  })
  try {
    assert.equal(child.status, 0, child.stderr)
    const results = JSON.parse(child.stdout)
    return { home, results, read: (path) => readFileSync(join(home, path), 'utf8'),
      clean: () => rmSync(home, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
}

const scan = (sources) => ({ name: 'agent_sync_scan', args: { sources } })
const sync = (sources, names = ['all']) => ({ name: 'agent_sync_do', args: { sources, mcp: names } })
const profiles = {
  '.dsh/profiles/headless/cordis.patch.yml': '- insert: []\n',
  '.dsh/profiles/web/cordis.patch.yml': '- insert: []\n',
}

test('TOML multiline argv, quoted keys, commas, escapes and comments round-trip to both profiles', () => {
  const run = fixture({
    ...profiles,
    '.codex/config.toml': `
[mcp_servers."quoted.name"]
command = "node"
args = [
  "a,b", # comment
  "a#b",
  "line\\nnext",
  'literal\\path',
  "\\\"quoted\\\"",
  "", "雪", "line\\u2028end"
]
env = { TOKEN = "hostile-secret-config-value" }
`,
  }, [scan(['codex']), sync(['codex'])])
  try {
    const argv = ['a,b', 'a#b', 'line\nnext', 'literal\\path', '"quoted"', '', '雪', 'line\u2028end']
    assert.deepEqual(run.results[0].codex.mcp[0].args, argv)
    assert.deepEqual(run.results[0].codex.mcp[0].envKeys, ['TOKEN'])
    assert.ok(!JSON.stringify(run.results[0]).includes('hostile-secret-config-value'))
    for (const profile of ['headless', 'web']) {
      const documents = parse(run.read(`.dsh/profiles/${profile}/cordis.patch.yml`))
      const entry = documents.flatMap((row) => row.insert || []).find((row) => row.name === '@deepseek-ai/dsh-mcp-client')
      assert.deepEqual(entry.config.args, argv)
      assert.equal(entry.config.command, 'node')
    }
    assert.equal(run.results[1].ok, true)
    assert.equal(run.results[1].mcp.profiles.length, 2)
  } finally { run.clean() }
})

test('YAML block/flow argv, folded scalars, nested env and HTTP mappings survive canonical scan/do', () => {
  const run = fixture({ ...profiles, '.hermes/config.yaml': `
mcp_servers:
  block:
    command: node
    args:
      - "a,b"
      - "line\\nnext"
      - >-
        folded
        value
    env: { TOKEN: hostile-secret-yaml-value }
  flow: {command: node, args: ["quoted,comma", "#literal"]}
  remote:
    type: streamable-http
    url: https://example.test/mcp
    headers: {Authorization: hostile-secret-header-value}
` }, [scan(['hermes']), sync(['hermes'])])
  try {
    const entries = run.results[0].hermes.mcp
    assert.deepEqual(entries.find((entry) => entry.name === 'block').args, ['a,b', 'line\nnext', 'folded value'])
    assert.deepEqual(entries.find((entry) => entry.name === 'flow').args, ['quoted,comma', '#literal'])
    assert.deepEqual(entries.find((entry) => entry.name === 'remote').headerKeys, ['Authorization'])
    assert.ok(!JSON.stringify(run.results[0]).includes('hostile-secret'))
    const patch = parse(run.read('.dsh/profiles/headless/cordis.patch.yml')).flatMap((row) => row.insert || [])
    assert.equal(patch.length, 3)
    assert.deepEqual(patch.find((entry) => entry.id === 'mcp-block').config.args, ['a,b', 'line\nnext', 'folded value'])
  } finally { run.clean() }
})

test('malformed no-final-newline TOML and YAML return safe numeric errors without hanging or partial entries', () => {
  for (const [source, path, text, format] of [
    ['codex', '.codex/config.toml', '[mcp_servers.good]\ncommand="node"\nargs=["hostile-secret-parse-value",', 'toml'],
    ['hermes', '.hermes/config.yaml', 'mcpServers: {good: {command: node, args: [hostile-secret-parse-value}', 'yaml'],
  ]) {
    const run = fixture({ ...profiles, [path]: text }, [scan([source]), sync([source])])
    try {
      const result = run.results[0][source]
      assert.deepEqual(result.mcp, [])
      assert.equal(result.errors[0].source, source)
      assert.equal(result.errors[0].format, format)
      assert.equal(typeof result.errors[0].line, 'number')
      assert.equal(typeof result.errors[0].column, 'number')
      assert.deepEqual(Object.keys(result.errors[0]).sort(), ['column', 'format', 'line', 'source'])
      assert.ok(!JSON.stringify(run.results).includes('hostile-secret-parse-value'))
      assert.equal(run.results[1].mcp.errors[0].format, format)
      assert.deepEqual(run.results[1].mcp.synced, [])
    } finally { run.clean() }
  }
})

test('source-relative cwd and pathlike commands resolve while bare PATH commands and argv stay exact', () => {
  const run = fixture({ ...profiles, '.codex/config.toml': `
[mcp_servers.relative]
command = "./bin/tool"
cwd = "./work"
args = ["../argument,unchanged"]
[mcp_servers.base]
command = "./bin/tool"
[mcp_servers.bare]
command = "node"
cwd = "./work"
[mcp_servers.absolute]
command = "/absolute/bin/tool"
cwd = "/absolute/work"
` }, [scan(['codex']), sync(['codex'])])
  try {
    const entries = Object.fromEntries(run.results[0].codex.mcp.map((entry) => [entry.name, entry]))
    assert.equal(entries.relative.cwd, resolve(run.home, '.codex/work'))
    assert.equal(entries.relative.command, resolve(run.home, '.codex/work/bin/tool'))
    assert.deepEqual(entries.relative.args, ['../argument,unchanged'])
    assert.equal(entries.base.command, resolve(run.home, '.codex/bin/tool'))
    assert.equal(entries.bare.command, 'node')
    assert.equal(entries.absolute.command, '/absolute/bin/tool')
    const state = JSON.parse(run.read('.dsh/agent-sync/state.json'))
    assert.equal(state.mcp.relative.config.cwd, entries.relative.cwd)
  } finally { run.clean() }
})

test('invalid argv/command/cwd and explicitly disabled entries report errors without disabling valid siblings', () => {
  const servers = {
    valid: { command: 'node', args: ['a,b', ''] },
    stringArgs: { command: 'node', args: 'one two' },
    numericArgs: { command: 'node', args: [42] },
    objectArgs: { command: 'node', args: [{}] },
    invalidCommand: { command: {} },
    invalidCwd: { command: 'node', cwd: 42 },
    disabled: { command: './nonexistent', enabled: false },
    invalidSibling: null,
  }
  const run = fixture({ ...profiles, '.gemini/settings.json': { mcpServers: servers } }, [scan(['gemini']), sync(['gemini'])])
  try {
    assert.equal(run.results[0].gemini.mcp.filter((entry) => entry.error).length, 7)
    assert.equal(run.results[0].gemini.mcp.find((entry) => entry.name === 'disabled').error.code, 'source_disabled')
    assert.deepEqual(run.results[1].mcp.synced, ['valid'])
    assert.equal(run.results[1].mcp.errors.length, 7)
    const state = JSON.parse(run.read('.dsh/agent-sync/state.json'))
    assert.equal(state.mcp.valid.enabled, true)
    assert.deepEqual(Object.keys(state.mcp), ['valid'])
  } finally { run.clean() }
})

test('custom JSON/YAML/TOML sources carry their own absolute path base and retain valid siblings', () => {
  const run = fixture({
    ...profiles,
    '.dsh/agent-sync/sources.json': [
      { id: 'local-json', kind: 'json', path: '__FIXTURE_HOME__/json/config.json' },
      { id: 'local-yaml', kind: 'yaml', path: '__FIXTURE_HOME__/yaml/config.yaml' },
      { id: 'local-toml', kind: 'toml', path: '__FIXTURE_HOME__/toml/config.toml' },
      { id: 'invalid-yaml', kind: 'yaml', path: '__FIXTURE_HOME__/broken/config.yaml' },
    ],
    'json/config.json': { mcpServers: { json: { command: './tool', cwd: '.' } } },
    'yaml/config.yaml': 'mcpServers: {yaml: {command: ./tool, args: ["a,b"]}}',
    'toml/config.toml': '[mcp_servers.toml]\ncommand="./tool"\ncwd="./work"',
    'broken/config.yaml': 'mcpServers: [hostile-secret-malformed-custom',
  }, [scan(['custom']), sync(['custom'])])
  try {
    const entries = Object.fromEntries(run.results[0].custom.mcp.map((entry) => [entry.name, entry]))
    assert.equal(entries.json.command, resolve(run.home, 'json/tool'))
    assert.equal(entries.yaml.command, resolve(run.home, 'yaml/tool'))
    assert.deepEqual(entries.yaml.args, ['a,b'])
    assert.equal(entries.toml.command, resolve(run.home, 'toml/work/tool'))
    assert.deepEqual(run.results[1].mcp.synced, ['json', 'yaml', 'toml'])
    assert.equal(run.results[1].mcp.errors[0].source, 'invalid-yaml')
    assert.ok(!JSON.stringify(run.results).includes('hostile-secret-malformed-custom'))
  } finally { run.clean() }
  const second = fixture({
    ...profiles,
    '.kimi/config.toml': '[mcp.servers.kimi]\ncommand="node"\nargs=["a,b"]',
    '.cursor/mcp.json': { mcpServers: { cursor: { command: './bin/tool', cwd: '.' } } },
    '.claude/settings.json': { mcpServers: { claude: { command: './bin/tool', cwd: '.' } } },
  }, [scan(['kimi', 'cursor', 'claude'])])
  try {
    assert.deepEqual(second.results[0].kimi.mcp[0].args, ['a,b'])
    assert.equal(second.results[0].cursor.mcp[0].command, resolve(second.home, '.cursor/bin/tool'))
    assert.equal(second.results[0].claude.mcp[0].command, resolve(second.home, '.claude/bin/tool'))
  } finally { second.clean() }
})

test('failed state publication rolls back both profile patches and exact pre-existing state', () => {
  const oldState = '{"mcp":{},"skills":{"preserved":{"enabled":true}}}\n'
  const run = fixture({ ...profiles, '.dsh/agent-sync/state.json': oldState,
    '.codex/config.toml': '[mcp_servers.test]\ncommand="node"\nargs=["a,b"]' },
  [sync(['codex'])], { renameFailure: true })
  try {
    assert.equal(run.results[0].ok, false)
    assert.deepEqual(run.results[0].mcp.synced, [])
    assert.deepEqual(run.results[0].mcp.errors, [{ code: 'sync_write_failed', rollback: 'complete' }])
    assert.equal(run.read('.dsh/agent-sync/state.json'), oldState)
    for (const [path, original] of Object.entries(profiles)) assert.equal(run.read(path), original)
    for (const directory of ['agent-sync', 'profiles/headless', 'profiles/web']) {
      assert.ok(!readdirSync(join(run.home, '.dsh', directory)).some((name) => /\.(pending|rollback)$/.test(name)))
    }
    assert.ok(!JSON.stringify(run.results).includes('hostile-secret-transaction-error'))
  } finally { run.clean() }
})

test('rollback conflict preserves concurrent edits and exclusive private recovery preimages', () => {
  const run = fixture({ ...profiles, '.dsh/agent-sync/state.json': '{"mcp":{},"skills":{}}',
    '.codex/config.toml': '[mcp_servers.test]\ncommand="node"' },
  [sync(['codex'])], { renameFailure: true, rollbackConflict: true })
  try {
    assert.equal(run.results[0].ok, false)
    assert.equal(run.results[0].mcp.errors[0].rollback, 'incomplete')
    assert.equal(run.read('.dsh/profiles/headless/cordis.patch.yml'), '- insert: []\n# concurrent edit\n')
    const directory = join(run.home, '.dsh/profiles/headless')
    const preimage = readdirSync(directory).find((name) => name.endsWith('.rollback'))
    assert.ok(preimage)
    assert.equal(statSync(join(directory, preimage)).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(directory, preimage), 'utf8'), profiles['.dsh/profiles/headless/cordis.patch.yml'])
  } finally { run.clean() }
})

test('invalid existing state and profile conflicts fail before publishing prospective changes', () => {
  for (const files of [
    { '.dsh/agent-sync/state.json': 'hostile-secret-invalid-state' },
    { '.dsh/profiles/web/cordis.patch.yml': '- id: mcp-test\n  name: external\n' },
  ]) {
    const all = { ...profiles, ...files, '.codex/config.toml': '[mcp_servers.test]\ncommand="node"' }
    const run = fixture(all, [sync(['codex'])])
    try {
      assert.equal(run.results[0].ok, false)
      assert.deepEqual(run.results[0].mcp.synced, [])
      for (const path of Object.keys(profiles)) assert.equal(run.read(path), all[path])
      assert.ok(!JSON.stringify(run.results).includes('hostile-secret-invalid-state'))
    } finally { run.clean() }
  }
})

test('concurrent sync requests serialize prospective state and preserve both selections', () => {
  const run = fixture({ ...profiles, '.codex/config.toml': '[mcp_servers.first]\ncommand="node"\n[mcp_servers.second]\ncommand="node"' },
    [sync(['codex'], ['first']), sync(['codex'], ['second'])], { concurrent: true })
  try {
    assert.ok(run.results.every((result) => result.ok))
    assert.deepEqual(Object.keys(JSON.parse(run.read('.dsh/agent-sync/state.json')).mcp).sort(), ['first', 'second'])
  } finally { run.clean() }
})

test('sync preserves existing unrelated state and managed disabled selection', () => {
  const kept = { source: 'manual', entryId: 'mcp-kept', enabled: true,
    config: { serverName: 'kept', transport: 'stdio', command: 'node', args: ['preserved'], env: {} } }
  const disabled = { source: 'codex', entryId: 'mcp-disabled', enabled: false,
    config: { serverName: 'disabled', transport: 'stdio', command: 'node', args: [], env: {} } }
  const run = fixture({ ...profiles, '.dsh/agent-sync/state.json': { mcp: { kept, disabled }, skills: { preserved: { enabled: true } } },
    '.codex/config.toml': '[mcp_servers.disabled]\ncommand="node"\nargs=["updated"]\n[mcp_servers.fresh]\ncommand="node"' },
  [sync(['codex'])])
  try {
    const state = JSON.parse(run.read('.dsh/agent-sync/state.json'))
    assert.deepEqual(state.mcp.kept, kept)
    assert.equal(state.mcp.disabled.enabled, false)
    assert.deepEqual(state.mcp.disabled.config.args, ['updated'])
    assert.deepEqual(state.skills, { preserved: { enabled: true } })
    const entries = parse(run.read('.dsh/profiles/headless/cordis.patch.yml')).flatMap((row) => row.insert || [])
    assert.deepEqual(entries.map((entry) => entry.id).sort(), ['mcp-fresh', 'mcp-kept'])
  } finally { run.clean() }
})
