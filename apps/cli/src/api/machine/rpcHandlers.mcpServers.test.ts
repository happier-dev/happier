import axios from 'axios';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonMcpServersTestResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { McpServerCatalogRowMutationV1Schema, McpServerCatalogV1Schema, openMcpServerCatalogContentV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { projectMcpToolLaunchPolicyV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { openRealCodexMcpSession } from '../../../../../packages/plugins/codex/src/agent/mcpToolPolicy.realVendor.test-support';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import * as executableBoundary from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import type { RpcHandler } from '@/api/rpc/types';
import { createMcpOwnerRpcContext, MCP_TEST_HOME_ID } from './mcpServers.testkit';

// Only the Home HTTP/cache I/O boundaries are simulated. Reach, materialization,
// the SDK probe and catalog CAS run their production implementations.
vi.mock('axios', () => ({ default: { defaults: {}, get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/api/client/serverHttpBaseUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => 'https://home.example.test',
}));

const fixture = String.raw`
if (process.env.API_KEY) process.stderr.write(process.env.API_KEY + '\n');
if (process.env.API_KEY?.startsWith('prefix-')) process.stderr.write(process.env.API_KEY.slice('prefix-'.length) + '\n');
if (process.env.API_KEY?.startsWith('Bearer ') && process.env.TOKEN) process.stderr.write(process.env.TOKEN + '\n');
process.stderr.write('Authorization: Bearer fixture-private-token\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'fixture', version: '2.0.0' }, instructions: 'Read before writing.'
  } : request.method === 'tools/call' ? (() => {
    if (process.env.R39_CALL_RECEIPT) require('node:fs').appendFileSync(process.env.R39_CALL_RECEIPT, 'called\n');
    return { content: [{ type: 'text', text: 'R39_NATIVE_TOOL_CALLED' }] };
  })() : { tools: [{ name: 'read_records', title: 'Read records', description: 'Lists records.',
    annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] };
  if (request.method === 'tools/list' && process.env.MI1_MCP_TOOLS_RECEIPT) {
    require('node:fs').writeFileSync(process.env.MI1_MCP_TOOLS_RECEIPT, 'completed');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;
const server: McpServerCatalogEntryV1 = { id: 'server', name: 'fixture', transport: 'stdio',
  stdio: { command: process.execPath, args: ['-e', fixture] }, env: {}, createdAt: 1, updatedAt: 1 };
const catalog = { v: 1 as const, servers: [server], bindings: [{ id: 'on', serverId: server.id,
  enabled: true, target: { t: 'allMachines' as const }, createdAt: 1, updatedAt: 1 }] };

function register(conflict = false, env: NodeJS.ProcessEnv = process.env, storedCatalog: McpServerCatalogV1 = catalog,
  machineIsCurrent: () => boolean = () => true) {
  const writes: unknown[] = [];
  const committed: McpServerCatalogV1[] = [];
  let held = storedCatalog;
  let revision = 3;
  vi.mocked(axios.get).mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: {
      status: 'present', revision, content: { t: 'plain', v: held } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
  vi.mocked(axios.post).mockImplementation(async (_url, body) => {
    writes.push(body);
    const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
    if (conflict && revision === 3) {
      held = { ...held, servers: held.servers.map(entry => ({ ...entry,
        stdio: { ...entry.stdio!, args: ['changed-while-probing'] }, updatedAt: 2 })) };
      revision += 1;
    }
    if (mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
    const opened = openMcpServerCatalogContentV1({ content: mutation.content, mode: 'plain', material: null });
    if (opened.status !== 'opened') throw new Error('Expected current catalog write');
    held = opened.catalog;
    committed.push(held);
    revision += 1;
    return { status: 200, data: { status: 'updated', revision, cursor: revision } };
  });
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  registerMachineMcpServersRpcHandlers({
    rpcHandlerManager: { registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => {
      handlers.set(method, async raw => handler(raw, { ...createMcpOwnerRpcContext(),
        verifyMachineAdmissionCurrent: async () => machineIsCurrent() }));
    } } as never,
    deps: { env, hostHomeServerIdentityId: MCP_TEST_HOME_ID, readCredentials: async () => ({ token: 'rpc-mcp-account', encryption: null }),
      bootstrapAccountSettingsContext: input => bootstrapAccountSettingsContext({ ...input,
        honorAccountSettingsModeEnv: false, deps: { resolveCachePath: resolveAccountSettingsCachePath,
          readCache: async () => null, writeCache: async () => undefined,
          fetchFromServer: async () => ({ settingsVersion: 4, settingsContent: { t: 'plain', v: {} } }),
        } }),
    },
  });
  return { writes, committed, readStoredCatalog: () => held, test: async (request: unknown) => DaemonMcpServersTestResponseSchema.parse(
    await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!(request)) };
}

describe('Machine MCP Test pipeline', () => {
  it('decodes a real remote Bearer challenge as the typed sign-in repair without writing a tool snapshot', async () => {
    const remote = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://issuer.example.test/metadata"' });
      response.end();
    });
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    try {
      const owner = register(false, process.env, { ...catalog, servers: [{ id: 'server', name: 'fixture',
        transport: 'http', remote: { url: `http://127.0.0.1:${address.port}/mcp`, headers: {} },
        env: {}, createdAt: 1, updatedAt: 1 }] });
      const result = await owner.test({ t: 'byId', machineId: 'm1', directory: tmpdir(), serverId: 'server' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_required' });
      expect(owner.writes).toEqual([]);
    } finally { await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())); }
  }, 60_000);

  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests(); vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset();
    // Exercise the moving source in every native bridge child, including workspace exports.
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --conditions=happier-source`);
  });
  afterEach(() => { resetInMemoryAccountSettingsContextForTests(); vi.unstubAllEnvs(); });

  it.each(['draft', 'byId'] as const)('retains %s admission when its later verifier changes during the credential read', async t => {
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    let current = true;
    let reads = 0;
    let rechecks = 0;
    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager: { registerHandler(method: string, handler: RpcHandler<unknown, unknown>) { handlers.set(method, handler); } } as never,
      deps: { hostHomeServerIdentityId: MCP_TEST_HOME_ID,
        // Persistent credential-file I/O is the only substituted boundary.
        // No Account/catalog or materialization owner is mocked.
        readCredentials: async () => { reads++; await Promise.resolve(); current = false; return null; },
      },
    });
    const request = t === 'draft' ? { t, machineId: 'm1', directory: tmpdir(), server, binding: null }
      : { t, machineId: 'm1', directory: tmpdir(), serverId: server.id };
    const test = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    if (!test) throw new Error('Missing registered MCP Test');
    await expect(test(request, { ...createMcpOwnerRpcContext(), verifyMachineAdmissionCurrent: async () => { rechecks++; return current; } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'missing_credentials' });
    expect(reads).toBe(1);
    expect(rechecks).toBe(0);
  });

  it('refuses a requester without original Machine admission before reading credentials', async () => {
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    let reads = 0;
    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager: { registerHandler(method: string, handler: RpcHandler<unknown, unknown>) { handlers.set(method, handler); } } as never,
      deps: { hostHomeServerIdentityId: MCP_TEST_HOME_ID, readCredentials: async () => { reads++; return null; } },
    });
    const test = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    if (!test) throw new Error('Missing registered MCP Test');
    await expect(test({ t: 'byId', serverId: server.id, machineId: 'm1', directory: tmpdir() }, {
      ...createMcpOwnerRpcContext(), machineAdmission: undefined, verifyMachineAdmissionCurrent: undefined,
    })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
    expect(reads).toBe(0);
  });

  it('writes metadata and token estimates through the captured catalog CAS', async () => {
    const { test, writes } = register();
    const result = await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory: tmpdir() });
    expect(result).toMatchObject({ ok: true, toolCount: 1, tools: [{ name: 'read_records', title: 'Read records',
      annotations: { readOnlyHint: true }, tokens: 11 }], serverInfo: { name: 'fixture', version: '2.0.0' },
      instructions: 'Read before writing.', protocolVersion: expect.any(String), stderrTail: expect.stringContaining('[REDACTED]') });
    expect(writes).toEqual([expect.objectContaining({ expectedRevision: 3, content: { t: 'plain', v: {
      ...catalog, servers: [{ ...server, updatedAt: expect.any(Number), toolsSnapshot: expect.objectContaining({ machineId: 'machine',
        checkedAt: expect.any(Number), tools: [{ name: 'read_records', title: 'Read records', description: 'Lists records.',
          annotations: { readOnlyHint: true }, tokens: 11 }] }) }],
    } } })]);
    expect(JSON.stringify(result)).not.toContain('fixture-private-token');
  });

  it('finishes an admitted healthy probe and tools CAS after later Machine withdrawal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-mcp-cas-withdrawal-'));
    const marker = join(directory, 'probe-completed');
    let current = true;
    let withdrew = false;
    const { test, writes, readStoredCatalog } = register(false, { ...process.env, MI1_MCP_TOOLS_RECEIPT: marker }, catalog, () => current);
    const homeGet = vi.mocked(axios.get).getMockImplementation()!;
    // Home Account-currentness HTTP is a genuine system boundary. Retire the
    // original Machine admission only after the useful OS probe has completed.
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const response = await homeGet(...args);
      if (new URL(String(args[0])).pathname === '/v1/account/encryption/currentness'
        && await readFile(marker, 'utf8').catch(() => null) === 'completed') {
        // The handler's captured operation checks its retained Account lifetime
        // locally. This fresh HTTP observation is inside the real store.
        current = false;
        withdrew = true;
      }
      return response;
    });
    try {
      const outcome = await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory })
        .then(result => ({ result }), (error: unknown) => ({ error }));
      // Prove withdrawal happened after the real probe, then preserve the
      // admitted finite operation's result and authoritative tools snapshot.
      expect(await readFile(marker, 'utf8')).toBe('completed');
      expect(withdrew).toBe(true);
      expect(writes).toHaveLength(1);
      expect(outcome).toMatchObject({ result: { ok: true, toolCount: 1 } });
      expect(readStoredCatalog().servers[0]?.toolsSnapshot).toMatchObject({ machineId: 'machine', tools: [{ name: 'read_records' }] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses a configuration change committed while a healthy probe is in flight', async () => {
    const { test, writes, readStoredCatalog } = register(true);
    expect(await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory: tmpdir() }))
      .toMatchObject({ ok: false, errorCode: 'materialization_failed', error: 'mcp_tools_snapshot_conflict' });
    expect(writes).toHaveLength(1);
    expect(readStoredCatalog().servers[0]).toMatchObject({ stdio: { args: ['changed-while-probing'] } });
    expect(readStoredCatalog().servers[0]?.toolsSnapshot).toBeUndefined();
  });

  it('persists all three concurrent healthy machine observations from the same catalog CAS', async () => {
    const { test, writes, committed, readStoredCatalog } = register();
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let arrivals = 0;
    let release = () => {};
    const allProbed = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      arrivals += 1;
      if (arrivals === 3) release();
      await allProbed;
      return post(...args);
    });
    const machineIds = ['first-machine', 'second-machine', 'third-machine'];
    const results = await Promise.all(machineIds.map(machineId => test({
      t: 'byId', serverId: server.id, machineId, directory: tmpdir(),
    })));
    expect(results).toEqual([expect.objectContaining({ ok: true, toolCount: 1 }),
      expect.objectContaining({ ok: true, toolCount: 1 }), expect.objectContaining({ ok: true, toolCount: 1 })]);
    const mutations = writes.map(value => McpServerCatalogRowMutationV1Schema.parse(value));
    expect(mutations.slice(0, 3).map(value => value.expectedRevision)).toEqual([3, 3, 3]);
    expect(committed.map(value => value.servers[0]?.toolsSnapshot?.machineId).sort()).toEqual([...machineIds].sort());
    expect(readStoredCatalog().servers[0]?.toolsSnapshot).toEqual(committed.at(-1)?.servers[0]?.toolsSnapshot);
    expect(readStoredCatalog().servers[0]?.toolsSnapshot?.tools).toMatchObject([{ name: 'read_records' }]);
  });

  it.each(['ruleless', 'off'] as const)('checks an explicitly selected %s server without enabling its reach', async reach => {
    const storedCatalog: McpServerCatalogV1 = { ...catalog,
      servers: [{ ...server, tools: { default: 'allow_read_only', overrides: {} } }],
      bindings: reach === 'ruleless' ? [] : [{ ...catalog.bindings[0]!, enabled: false }],
    };
    const { test, writes } = register(false, process.env, storedCatalog);
    const result = await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory: tmpdir() });
    expect(result).toMatchObject({ ok: true, tools: [{ name: 'read_records', annotations: { readOnlyHint: true } }] });
    expect(writes).toHaveLength(1);
    // The Home request is a JSON system boundary; parse its real producer output
    // through the catalog consumed by Session tool-policy projection.
    const checked = McpServerCatalogV1Schema.parse(JSON.parse(JSON.stringify(writes[0])).content.v);
    expect(checked.bindings).toEqual(storedCatalog.bindings);
    expect(projectMcpToolLaunchPolicyV1({ policy: checked.servers[0]?.tools,
      snapshot: checked.servers[0]?.toolsSnapshot, permissionMode: 'read-only' }))
      .toEqual({ unlisted: 'deny', tools: { read_records: 'allow' } });
  });

  it.skipIf(!process.env.HAPPIER_MCP_CODEX_BIN).each([
    { permissionMode: 'read-only', checkBeforeAdd: true },
    { permissionMode: 'default', checkBeforeAdd: false },
  ] as const)('advertises and invokes a newly added MCP tool after real native resume ($permissionMode, checked=$checkBeforeAdd)', async ({ permissionMode, checkBeforeAdd }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-r39-native-'));
    const receipt = join(home, 'calls');
    const observer = createAgentLaunchObserver({ home });
    const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
    const approvedTools: string[] = [];
    const readProviderSessionId = () => observer.observeLaunch().runtimeEvents
      .map(event => AgentSessionRuntimeEventSchema.parse(event))
      .flatMap(event => event.kind === 'provider-session-id' ? [event.providerSessionId] : []).at(-1);
    // The person/UI response is a system boundary. Approve only this fixture's
    // one read tool; native configuration, discovery, dispatch and MCP stay real.
    const interactions: NonNullable<Parameters<typeof openRealCodexMcpSession>[1]['interactions']> = {
      requestApproval: async request => {
        if (request.subject.kind !== 'tool' || request.subject.name !== 'mcp__fixture__read_records') {
          throw new Error('Unexpected native approval');
        }
        approvedTools.push(request.subject.name);
        return { requestId: 'r39-own-tool', kind: 'approval', status: 'approved' };
      },
      askQuestions: async () => { throw new Error('Unexpected native question'); },
    };
    const configuration = AgentSessionConfigurationSnapshotV1Schema.parse({
      mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture', updatedAtMs: 1 }, options: {},
      permissionIntent: { value: permissionMode, updatedAtMs: 1 },
    });
    const storedCatalog: McpServerCatalogV1 = { ...catalog, bindings: [],
      servers: [{ ...server, tools: { default: 'allow_read_only', overrides: {} } }],
    };
    const events: AgentSessionRuntimeEvent[] = [];
    const send = async (session: AgentSessionRuntime, turnId: string) => {
      const done = new Promise<void>((resolve, reject) => {
        const subscription = session.watch(event => {
          events.push(event);
          if (!('turnId' in event) || event.turnId !== turnId) return;
          if (event.kind === 'turn-complete') { subscription.dispose(); resolve(); }
          if (event.kind === 'turn-failed' || event.kind === 'turn-cancelled') {
            subscription.dispose(); reject(new Error('Native fixture turn failed'));
          }
        });
      });
      expect(await session.send({ inputIds: [turnId],
        input: { text: JSON.stringify({ server: 'fixture', tool: 'read_records', arguments: {} }) },
        delivery: { kind: 'newTurn', turnId } })).toMatchObject({ status: 'admitted' });
      await done;
    };
    let initial: AgentSessionRuntime | undefined;
    let resumed: AgentSessionRuntime | undefined;
    try {
      initial = await openRealCodexMcpSession({ kind: 'create', sessionId: 'r39-fixture', cwd: home, configuration },
        { home, observer: boundaries, interactions });
      await send(initial, 'before-add');
      const providerSessionId = readProviderSessionId();
      if (typeof providerSessionId !== 'string') throw new Error('Missing native thread identity');
      expect(events.some(event => event.kind === 'tool-call')).toBe(false);
      await initial.dispose(); initial = undefined;
      const { test, writes } = register(false, process.env, storedCatalog);
      if (checkBeforeAdd) await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory: home });
      const checked = writes.length ? McpServerCatalogV1Schema.parse(JSON.parse(JSON.stringify(writes[0])).content.v) : storedCatalog;
      const policy = projectMcpToolLaunchPolicyV1({ policy: checked.servers[0]?.tools,
        snapshot: checked.servers[0]?.toolsSnapshot, permissionMode });
      if (!checkBeforeAdd) expect(policy).toEqual({ unlisted: 'ask', tools: {} });
      resumed = await openRealCodexMcpSession({ kind: 'resume', providerSessionId, sessionId: 'r39-fixture', cwd: home, configuration,
        mcpServers: { fixture: { command: process.execPath, args: ['-e', fixture], env: { R39_CALL_RECEIPT: receipt } } },
        mcpToolPolicy: { fixture: policy },
      }, { home, observer: boundaries, interactions });
      expect(readProviderSessionId()).toBe(providerSessionId);
      expect(observer.observeLaunch().appServerRequests.filter(request => request.method === 'thread/resume'))
        .toEqual([expect.objectContaining({ params: expect.objectContaining({ threadId: providerSessionId }) })]);
      expect(observer.observeLaunch().appServerRequests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      await send(resumed, 'after-add');
      expect(events.filter(event => event.kind === 'tool-result').some(event => JSON.stringify(event).includes('R39_NATIVE_TOOL_CALLED'))).toBe(true);
      expect(await readFile(receipt, 'utf8')).toBe('called\n');
      expect(approvedTools).toContain('mcp__fixture__read_records');
      expect(checked.bindings).toEqual([]);
    } finally { await resumed?.dispose(); await initial?.dispose(); await rm(home, { recursive: true, force: true }); }
  }, 120_000);

  it('reports a missing executable by its configured command', async () => {
    const { test, writes } = register(false, { PATH: '' });
    expect(await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, stdio: { command: 'happier-fixture-missing-command', args: [] },
    } })).toMatchObject({ ok: false, errorCode: 'mcp_connect_failed', runtimeMissing: 'happier-fixture-missing-command' });
    expect(writes).toEqual([]);
  });

  it('preserves a missing child executable through the private env/cwd launcher', async () => {
    // Executable selection is the process boundary: this current-source test
    // must not accidentally execute a worker's older packaged launcher.
    const resolveExecutable = executableBoundary.resolveNodeBackedMcpServerCommand;
    const executable = vi.spyOn(executableBoundary, 'resolveNodeBackedMcpServerCommand')
      .mockImplementation(async input => {
        const invocation = await resolveExecutable({ ...input, preferSourceEntrypoint: true });
        return { ...invocation, args: ['--conditions=happier-source', ...invocation.args] };
      });
    try {
      const { test, writes } = register(false, { ...process.env, PATH: '' });
      const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
        ...server, stdio: { command: 'happier-fixture-missing-command', args: [], cwd: { t: 'path', path: tmpdir() } },
        env: { PRIVATE_KEY: { t: 'literal', v: 'synthetic-fixture-private-value' } },
      } });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'mcp_connect_failed', runtimeMissing: 'happier-fixture-missing-command' });
      expect(writes).toEqual([]);
    } finally { executable.mockRestore(); }
  });

  it('redacts bare configured secret bytes before returning child stderr and leaves drafts unpersisted', async () => {
    const { test, writes } = register();
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'literal', v: 'bare-configured-private-value' } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('bare-configured-private-value');
    expect(JSON.stringify(result)).not.toContain('fixture-private-token');
    expect(writes).toEqual([]);
  });

  it('redacts the used template atom when a child echoes it without the rendered prefix', async () => {
    const { test } = register();
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'template', template: 'prefix-{api_key}',
        vars: { api_key: { t: 'literal', v: 'template-atom-private-value' } } } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('template-atom-private-value');
  });

  it('redacts the consumed machine-env atom when a literal expands to a composite value', async () => {
    const { test } = register(false, { ...process.env, TOKEN: 'machine-env-private-atom' });
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'literal', v: 'Bearer ${TOKEN}' } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('machine-env-private-atom');
  });

  it('redacts configured values before the existing stderr tail bound can split them', async () => {
    const { test } = register();
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'literal', v: 'private-fragment-'.repeat(1100) } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('private-fragment');
  });
});
