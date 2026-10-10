import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { AccountSettingsSchema, FeaturesResponseSchema, normalizeActionsSettingsV1, type ActionId } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

const socketBoundary = vi.hoisted(() => ({ respond: undefined as ((event: string, payload: unknown) => Promise<unknown>) | undefined }));
vi.mock('socket.io-client', async () => {
  const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  return { io: () => createApiSessionSocketStub({ emitWithAck: (event, payload) => {
    if (!socketBoundary.respond) throw new Error(`Unexpected Socket.IO request: ${event}`);
    return socketBoundary.respond(event, payload);
  } }) };
});

describe('managed inventory CLI Home adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: policy }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('bound') });
    socketBoundary.respond = undefined;
    app = fastify();
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    restore = installAxiosFastifyAdapter({ app, origin: 'http://home.test' });
  });
  afterEach(async () => { restore(); await app.close(); resetActiveAccountSettingsSnapshotForTests(); });

  const machine = {
    id: 'managed-1', homeId: 'srv_home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: { cores: 2 } },
    controller: { machineId: 'controller-1', installationId: 'installation-1' },
    allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  } as const satisfies ManagedMachineV1;
  const context = { surface: 'cli', authority: 'account_automation', serverId: 'route-home' } as const;
  const policy = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
    'machines.presets.update': ['cli', 'agent', 'mcp'],
    'machines.access.grant.remove': ['cli', 'agent', 'mcp'],
    'machines.environment.apply': ['cli', 'agent', 'mcp'],
  } });

  function invoke(cli: ReturnType<typeof createCliActionExecutor>, surface: 'cli' | 'agent' | 'mcp', actionId: ActionId, input: unknown) {
    if (surface === 'cli') return cli.execute(actionId, input, { ...context, actionsSettings: policy });
    return createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy })
      .executeActionByToolName(surface === 'agent' ? 'action_execute' : actionId.replaceAll('.', '_'),
        surface === 'agent' ? { actionId, input } : input, 'cli-global', { actionRequestId: `parity-${surface}-${actionId}` });
  }

  function executor(overrides: Partial<Pick<Parameters<typeof createAccountServerActionDeps>[0],
    'serverIdentityId' | 'resolveServerFeaturesSnapshot' | 'isCredentialCurrent'>> = {}) {
    return createCliActionExecutor({
      token: 'bound', sessionId: 'cli-global', serverId: 'route-home', serverHttpBaseUrl: 'http://home.test',
      mode: 'plain', ctx: null,
      accountServerActionDeps: createAccountServerActionDeps({
        token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test', ...overrides,
      }),
    });
  }

  it('lists and gets retained resources through the real CLI executor without a controller or answering app', async () => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    app.post('/v1/machines/managed/actions/list', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { machines: [machine] };
    });
    app.post('/v1/machines/managed/actions/get', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return machine;
    });
    const cli = executor();
    await expect(cli.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toEqual({ ok: true, result: { machines: [machine] } });
    await expect(cli.execute('machines.managed.get', { homeId: 'srv_home', managedId: machine.id }, context))
      .resolves.toEqual({ ok: true, result: machine });
    expect(seen).toEqual([
      { url: '/v1/machines/managed/actions/list', body: { homeId: 'srv_home' }, authorization: 'Bearer bound' },
      { url: '/v1/machines/managed/actions/get', body: { homeId: 'srv_home', managedId: machine.id }, authorization: 'Bearer bound' },
    ]);
  });

  it('keeps a named managed refusal distinct from an older Home without the endpoint', async () => {
    app.post('/v1/machines/managed/actions/get', async (_request, reply) => reply.code(404).send({ code: 'managed_not_found' }));
    const cli = executor();
    await expect(cli.execute('machines.managed.get', { homeId: 'srv_home', managedId: 'missing' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'managed_not_found' });
    await expect(cli.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes Home inventory, preset edits, pools and sharing through the real %s adapter', async surface => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const preset = { id: 'preset-1', homeId: 'srv_home', revision: 2, name: 'Changed',
      owner: { kind: 'account', accountId: 'owner' }, recipe: machine.launch, controller: machine.controller };
    app.post('/v1/machines/managed/actions/get', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return machine;
    });
    app.post('/v1/machines/presets/update', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { kind: 'saved', preset };
    });
    app.delete('/v1/machines/controller-1/access', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { kind: 'removed', effectiveAccess: 'none' };
    });
    const poolId = '06986bf6-681b-46f1-8d68-bb619ac0c7f0';
    const resolvedPool = { kind: 'resolved', poolId, machineId: 'controller-1', priorityTier: 1 };
    app.post('/v1/machines/pools/resolve', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return resolvedPool;
    });
    const cli = executor();
    await expect(invoke(cli, surface, 'machines.managed.get', { homeId: 'srv_home', managedId: machine.id }))
      .resolves.toEqual({ ok: true, result: machine });
    const edit = { homeId: 'srv_home', id: preset.id, expectedRevision: 1, patch: { name: preset.name } };
    await expect(invoke(cli, surface, 'machines.presets.update', edit))
      .resolves.toEqual({ ok: true, result: { kind: 'saved', preset } });
    const principal = { kind: 'account', accountId: 'recipient' };
    await expect(invoke(cli, surface, 'machines.access.grant.remove', { serverId: 'route-home', machineId: 'controller-1', principal }))
      .resolves.toEqual({ ok: true, result: { kind: 'removed', effectiveAccess: 'none' } });
    const poolInput = { poolId, requestKey: `parity-${surface}`, purpose: 'session' };
    await expect(invoke(cli, surface, 'machines.pools.resolve', poolInput))
      .resolves.toEqual({ ok: true, result: resolvedPool });
    expect(seen).toEqual([
      { url: '/v1/machines/managed/actions/get', body: { homeId: 'srv_home', managedId: machine.id }, authorization: 'Bearer bound' },
      { url: '/v1/machines/presets/update', body: edit, authorization: 'Bearer bound' },
      { url: '/v1/machines/controller-1/access', body: { principal }, authorization: 'Bearer bound' },
      { url: '/v1/machines/pools/resolve', body: poolInput, authorization: 'Bearer bound' },
    ]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes preset setup, terminals and authenticated work summary through the exact-machine %s transport', async surface => {
    const seen: Array<{ method: string; request: unknown }> = [];
    const environment = { homeId: 'srv_home', machineId: 'controller-1', presetId: 'preset-1', presetRevision: 2 };
    const terminals = { ok: true, terminals: [{ terminalId: 'terminal-1', terminalKey: 'setup', cwd: '/workspace', ended: false, exit: null }] };
    const workSummary = { kind: 'current', requesters: [{ accountId: 'recipient', displayName: 'Recipient', sessions: 2, tasks: 1, terminals: 3 }] } satisfies MachineWorkSummaryV1;
    app.get('/v1/machines/controller-1', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return { machine: { id: 'controller-1', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } };
    });
    socketBoundary.respond = async (event, payload) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      if (!payload || typeof payload !== 'object') throw new Error('Missing machine RPC request');
      const method: unknown = Reflect.get(payload, 'method');
      expect(method).toBe(`controller-1:${RPC_METHODS.MACHINES_WORK_SUMMARY_GET}`);
      if (typeof method !== 'string') throw new Error('Missing machine RPC method');
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, Reflect.get(payload, 'params'), method);
      seen.push({ method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: decoded.params });
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, workSummary, decoded.callId) };
    };
    const cli = createCliActionExecutor({ token: 'bound', credentials: { token: 'bound', encryption: null }, sessionId: 'cli-global', serverId: 'route-home', serverIdentityId: 'srv_home',
      serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null,
      // Only the daemon IPC boundary is substituted; the Action/tool executors,
      // exact-target adapter, schema validation and admission remain real.
      machineActionDirectTargetTransport: { machineId: 'controller-1', invoke: async (method, request) => {
        seen.push({ method, request });
        if (method === 'machines.environment.apply') return { operationId: 'setup-1', terminalId: 'terminal-1' };
        if (method === RPC_METHODS.DAEMON_TERMINAL_LIST) return terminals;
        throw new Error(`Unexpected daemon method: ${method}`);
      } },
    });
    await expect(invoke(cli, surface, 'machines.environment.apply', environment))
      .resolves.toEqual({ ok: true, result: { operationId: 'setup-1', terminalId: 'terminal-1' } });
    await expect(invoke(cli, surface, 'machines.terminal.list', { serverId: 'route-home', machineId: 'controller-1' }))
      .resolves.toEqual({ ok: true, result: terminals });
    await expect(invoke(cli, surface, 'machines.work.summary.get', { serverId: 'route-home', machineId: 'controller-1' }))
      .resolves.toEqual({ ok: true, result: workSummary });
    await expect(invoke(cli, surface, 'machines.environment.apply', { ...environment, presetRevision: '2' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(seen).toEqual([{ method: 'machines.environment.apply', request: environment },
      { method: RPC_METHODS.DAEMON_TERMINAL_LIST, request: {} },
      { method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: { serverId: 'route-home', machineId: 'controller-1' } }]);
  });

  it('binds reads to the authenticated Home and withholds retired Account output', async () => {
    let current = true;
    const seen: unknown[] = [];
    app.post('/v1/machines/managed/actions/list', async request => {
      seen.push(request.body);
      current = false;
      return { machines: [machine] };
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
    app.get('/v1/features/authenticated', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return features;
    });
    app.get('/v1/features', async () => features);
    // Only Fetch's HTTP boundary is replaced; feature parsing and provenance
    // come from the same observation owner used by credentialed CLI execution.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe('http://home.test');
      const response = await app.inject({ method: 'GET', url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(response.payload, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    };
    const authenticated = executor({ serverIdentityId: undefined,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', token: 'bound', fetchImpl }),
      isCredentialCurrent: () => current });
    await expect(authenticated.execute('machines.managed.list', { homeId: 'route-home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    const advisory = executor({ serverIdentityId: undefined,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', fetchImpl }) });
    await expect(advisory.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(seen).toEqual([]);
    await expect(authenticated.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    await expect(authenticated.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(seen).toEqual([{ homeId: 'srv_home' }]);
  });
});
