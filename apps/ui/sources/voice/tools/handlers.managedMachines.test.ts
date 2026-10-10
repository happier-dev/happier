import { describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { createVoiceToolHandlers } from './handlers';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

describe('Machines advertised UI and eligible Voice execution', () => {
  it.each(['ui', 'voice'] as const)('reads permission-scoped sharing through the existing %s executor', async surface => {
    const settings = { experiments: true, featureToggles: { voice: true } };
    const output = { machineId: 'machine', custodian: { accountId: 'owner', displayName: 'Owner' },
      access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] };
    const home = await serveActionHomes({ homes: [
      { key: 'compute', serverUrl: 'https://par-compute.test', accountId: 'owner', settings },
      { key: 'focused', serverUrl: 'https://par-focused.test', accountId: 'other' },
    ], route: request => request.home === 'compute' && request.path === '/v1/machines/machine/access'
      && request.method === 'GET' ? Response.json(output) : undefined });
    const previousSettings = storage.getState().settings;
    storage.setState({ settings: settingsParse(settings) });
    try {
      const serverId = home.homes.compute!.id;
      const input = { serverId, machineId: 'machine' };
      if (surface === 'ui') {
        expect(await createDefaultActionExecutor().execute('machines.access.grants.list', input, { surface, serverId }))
          .toEqual({ ok: true, result: output });
      } else {
        const name = getActionSpec('machines.access.grants.list').bindings?.voiceClientToolName;
        expect(name).toBeTruthy();
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        expect(JSON.parse(await handlers[name!]!(input, { serverId }))).toEqual({ ok: true, ...output });
        expect(JSON.parse(await handlers[name!]!({ ...input, accountId: 'other' }, { serverId })))
          .toMatchObject({ ok: false });
      }
      expect(home.requests.filter(request => request.path.endsWith('/access')).map(request => ({
        home: request.home, accountId: request.accountId, method: request.method,
      }))).toEqual([{ home: 'compute', accountId: 'owner', method: 'GET' }]);
    } finally {
      storage.setState({ settings: previousSettings });
      home.dispose();
    }
  });

  it.each([
    ['ui', 'machines.work.summary.get'], ['voice', 'machines.work.summary.get'],
    ['ui', 'machines.terminal.list'], ['voice', 'machines.terminal.list'],
  ] as const)('reads physical-machine data through the real %s %s executor and scoped Socket RPC', async (surface, actionId) => {
    const settings = { experiments: true, featureToggles: { voice: true } };
    const output = actionId === 'machines.work.summary.get'
      ? { kind: 'current', requesters: [{ accountId: 'requester', displayName: 'Requester', sessions: 2, tasks: 1, terminals: 3 }] }
      : { ok: true, terminals: [{ terminalId: 'terminal', terminalKey: 'project-shell', cwd: '/workspace', ended: false, exit: null }] };
    const method = actionId === 'machines.work.summary.get' ? RPC_METHODS.MACHINES_WORK_SUMMARY_GET : RPC_METHODS.DAEMON_TERMINAL_LIST;
    const machine = createPlainMachineRowFixture({ id: 'machine', accountId: 'owner' });
    const features = createRootLayoutFeaturesResponse();
    const journey = `${actionId.replaceAll('.', '-')}-${surface}`;
    const home = await serveActionHomes({ homes: [
      { key: 'compute', serverUrl: `https://par-${journey}.test`, accountId: 'owner', settings },
      { key: 'focused', serverUrl: `https://par-focused-${journey}.test`, accountId: 'other' },
    ], route: request => request.path === '/v1/features' ? Response.json(features)
      : request.home === 'compute' && request.path === '/v1/machines/machine' ? Response.json({ machine }) : undefined });
    const previousSettings = storage.getState().settings;
    const requests: Array<{ serverUrl: string | undefined; method: string; input: unknown }> = [];
    const neighboringAcks = createSocketIoBoundaryStub().socket.emitWithAck;
    installDisconnectedServerSocketBoundary((socket, serverUrl) => {
      socket.connected = true;
      socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return await neighboringAcks(event, payload);
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
          throw new Error('Malformed machine Socket RPC request');
        }
        const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        requests.push({ serverUrl, method: payload.method, input: request.params });
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, output, request.callId) };
      });
    });
    storage.setState({ settings: settingsParse(settings) });
    try {
      const serverId = home.homes.compute!.id;
      const input = { serverId, machineId: machine.id };
      if (surface === 'ui') {
        expect(await createDefaultActionExecutor().execute(actionId, input, { surface, serverId }))
          .toEqual({ ok: true, result: output });
      } else {
        const name = getActionSpec(actionId).bindings?.voiceClientToolName;
        expect(name).toBeTruthy();
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        expect(JSON.parse(await handlers[name!]!(input, { serverId }))).toEqual({ ok: true, ...output });
      }
      expect(requests).toEqual([{ serverUrl: home.homes.compute!.serverUrl,
        method: `${machine.id}:${method}`, input: actionId === 'machines.work.summary.get' ? input : {} }]);
      expect(home.requests.filter(request => request.path === '/v1/machines/machine').map(request => ({ home: request.home, accountId: request.accountId })))
        .toEqual([{ home: 'compute', accountId: 'owner' }]);
    } finally {
      await serverScopedRpcSocketPool.stopAll();
      resetScopedMachineTransportCacheForTests();
      installDisconnectedServerSocketBoundary();
      storage.setState({ settings: previousSettings });
      home.dispose();
    }
  });

  it('reads presets and resolves a pool through the named UI Home instead of the focused Home', async () => {
    const homeId = 'srv_par_recipes';
    const features = createRootLayoutFeaturesResponse({ features: { machines: { pools: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
    const preset = { id: 'preset', homeId, revision: 1, name: 'Guest recipe', owner: { kind: 'account', accountId: 'owner' },
      recipe: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: { cores: 2 } },
      controller: { machineId: 'machine', installationId: 'installation' } };
    const presets = { kind: 'listed', presets: [preset] };
    const poolId = '06986bf6-681b-46f1-8d68-bb619ac0c7f0';
    const pool = { kind: 'resolved', poolId, machineId: 'machine', priorityTier: 1 };
    const home = await serveActionHomes({ homes: [
      { key: 'compute', serverUrl: 'https://par-recipes.test', accountId: 'owner' },
      { key: 'focused', serverUrl: 'https://par-recipes-focused.test', accountId: 'other' },
    ], route: request => request.home === 'compute' && request.path === '/v1/features' ? Response.json(features)
      : request.home === 'compute' && request.path === '/v1/machines/presets/list' ? Response.json(presets)
      : request.home === 'compute' && request.path === '/v1/machines/pools/resolve' ? Response.json(pool) : undefined });
    try {
      // Discover the Home identity through the real metadata producer before capturing its Action lifetime.
      expect(await getServerFeaturesSnapshot({ serverId: home.homes.compute!.id })).toMatchObject({ status: 'ready', serverIdentityId: homeId });
      const context = { surface: 'ui', serverId: homeId } as const;
      expect(await createDefaultActionExecutor().execute('machines.presets.list', { homeId }, context))
        .toEqual({ ok: true, result: presets });
      const input = { poolId, requestKey: 'par-ui-pool', purpose: 'session' };
      expect(await createDefaultActionExecutor().execute('machines.pools.resolve', input, context))
        .toEqual({ ok: true, result: pool });
      expect(home.requests.filter(request => request.path.startsWith('/v1/machines/')).map(request => ({
        home: request.home, accountId: request.accountId, path: request.path, body: request.body,
      }))).toEqual([
        { home: 'compute', accountId: 'owner', path: '/v1/machines/presets/list', body: { homeId } },
        { home: 'compute', accountId: 'owner', path: '/v1/machines/pools/resolve', body: input },
      ]);
    } finally {
      home.dispose();
    }
  });
});
