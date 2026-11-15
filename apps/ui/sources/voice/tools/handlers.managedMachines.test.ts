import { describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineProvisionerOptionsFixture, createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { createVoiceToolHandlers } from './handlers';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';

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
      await home.dispose();
      storage.setState({ settings: previousSettings });
    }
  });

  it.each([
    ['ui', 'machines.work.summary.get'], ['voice', 'machines.work.summary.get'],
    ['ui', 'machines.terminal.list'], ['voice', 'machines.terminal.list'],
  ] as const)('reads physical-machine data through the real %s %s executor and owning transport', async (surface, actionId) => {
    const settings = { experiments: true, featureToggles: { voice: true }, voice: { canApproveRequests: false } };
    const output = actionId === 'machines.work.summary.get'
      ? { kind: 'current', requesters: [{ accountId: 'requester', displayName: 'Requester', sessions: 2, tasks: 1, terminals: 3 }] }
      : { ok: true, terminals: [{ terminalId: 'terminal', terminalKey: 'project-shell', cwd: '/workspace', ended: false, exit: null }] };
    const method = actionId === 'machines.work.summary.get' ? RPC_METHODS.MACHINES_WORK_SUMMARY_GET : RPC_METHODS.DAEMON_TERMINAL_LIST;
    const journey = `${actionId.replaceAll('.', '-')}-${surface}`;
    const homeId = `srv_physical_${journey.replaceAll('-', '_')}`;
    const serverUrl = `https://par-${journey}.test`;
    const boundary = actionId === 'machines.terminal.list' ? await createExternalActionAccountHttpBoundary({
      serverUrl, serverIdentityId: homeId, accountId: 'owner', machineId: 'machine', actionId, tokenEpoch: 0,
      execute: (input, context) => {
        expect(input).toEqual({ serverId: homeId, machineId: 'machine' });
        expect(context.invocation).toMatchObject({ surface,
          authority: surface === 'ui' ? 'present_user' : 'account_automation' });
        return output;
      },
    }) : null;
    const machine = boundary?.machine ?? createPlainMachineRowFixture({ id: 'machine', accountId: 'owner' });
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: homeId } } });
    const home = await serveActionHomes({ homes: [
      { key: 'compute', serverUrl, serverIdentityId: homeId, accountId: 'owner', settings, currentAccount: true },
      { key: 'focused', serverUrl: `https://par-focused-${journey}.test`, accountId: 'other' },
    ], route: async request => {
      if (request.path === '/v1/features') return Response.json(request.home === 'compute' ? features : createRootLayoutFeaturesResponse());
      if (request.home !== 'compute') return undefined;
      if (boundary) return await boundary.handle(request.url, { method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) ?? undefined;
      if (request.path === '/v1/machines') return Response.json([machine]);
      if (request.path === '/v1/machines/read-batch' && request.method === 'POST') {
        return createMachineReadBatchResponseFixture(request.body, id => id === machine.id ? machine : null);
      }
      return request.path === '/v1/machines/machine' ? Response.json({ machine }) : undefined;
    } });
    const previousSettings = storage.getState().settings;
    const requests: Array<{ serverUrl: string | undefined; method: string; input: unknown }> = [];
    const neighboringAcks = createSocketIoBoundaryStub().socket.emitWithAck;
    installDisconnectedServerSocketBoundary((socket, serverUrl) => {
      configureConnectedServerSocketBoundary(socket);
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
      expect(await getServerFeaturesSnapshot({ serverId })).toMatchObject({ status: 'ready', serverIdentityId: homeId });
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
      expect(requests).toEqual(actionId === 'machines.work.summary.get' ? [{ serverUrl: home.homes.compute!.serverUrl,
        method: `${machine.id}:${method}`, input }] : []);
      expect(home.requests.filter(request => request.path.startsWith('/v1/actions/')).map(request => request.path))
        .toEqual(actionId === 'machines.terminal.list'
          ? ['/v1/actions/machines.terminal.list/execution-authorization', '/v1/actions/machines.terminal.list'] : []);
      expect(home.requests.filter(request => request.path === '/v1/machines/read-batch').map(request => ({
        home: request.home, accountId: request.accountId, body: request.body,
      }))).toEqual([{
        home: 'compute', accountId: 'owner', body: { machineIds: [machine.id] },
      }]);
    } finally {
      await serverScopedRpcSocketPool.stopAll();
      await home.dispose();
      resetScopedMachineTransportCacheForTests();
      installDisconnectedServerSocketBoundary();
      storage.setState({ settings: previousSettings });
    }
  });

  it('keeps Voice automation authority through foreign terminal-list admission', async () => {
    const homeId = 'srv_voice_foreign_terminals';
    const settings = { experiments: true, featureToggles: { voice: true }, voice: { canApproveRequests: false } };
    const output = { ok: true, terminals: [] };
    const boundary = await createExternalActionAccountHttpBoundary({
      serverUrl: 'https://voice-foreign-terminals.test', serverIdentityId: homeId,
      accountId: 'requester', custodian: { accountId: 'custodian', displayName: 'Custodian' },
      machineId: 'machine', actionId: 'machines.terminal.list', tokenEpoch: 0,
      execute: (input, context) => {
        expect(input).toEqual({ serverId: homeId, machineId: 'machine' });
        expect(context.invocation).toMatchObject({ surface: 'voice', authority: 'account_automation' });
        expect(context.requestHeaders.get(AUTHORITY_CEILING_HEADER_V1)).toBe('account_automation');
        return output;
      },
    });
    const machine = boundary.machine;
    const home = await serveActionHomes({ homes: [
      { key: 'compute', serverUrl: 'https://voice-foreign-terminals.test', serverIdentityId: homeId,
        accountId: 'requester', settings, currentAccount: true },
    ], route: async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
        capabilities: { serverIdentity: { serverIdentityId: homeId } },
      }));
      return await boundary.handle(request.url, { method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) ?? undefined;
    } });
    const previousSettings = storage.getState().settings;
    storage.setState({ settings: settingsParse(settings) });
    try {
      expect(await getServerFeaturesSnapshot({ serverId: home.homes.compute!.id })).toMatchObject({ status: 'ready', serverIdentityId: homeId });
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      expect(JSON.parse(await handlers.machines_terminal_list!({ serverId: homeId, machineId: machine.id }, { serverId: homeId })))
        .toEqual(output);
      expect(home.requests.filter(request => request.path.startsWith('/v1/actions/')).map(request => request.path))
        .toEqual(['/v1/actions/machines.terminal.list/execution-authorization', '/v1/actions/machines.terminal.list']);
    } finally {
      await home.dispose();
      storage.setState({ settings: previousSettings });
    }
  });

  it.each(['ui', 'voice'] as const)('reads presets through the named %s Home instead of the focused Home', async surface => {
    const homeId = `srv_par_recipes_${surface}`;
    const features = createRootLayoutFeaturesResponse({ features: { machines: { pools: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
    const preset = createPlainManagedMachinePresetFixture({ id: 'preset', homeId, revision: 1, name: 'Guest recipe', owner: { kind: 'account', accountId: 'owner' },
      launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: { cores: 2 } },
      controller: { machineId: 'machine', installationId: 'installation' } });
    const presets = { kind: 'listed', presets: [preset] };
    const managed = { id: 'managed', homeId, custodianAccountId: 'owner', controller: preset.controller,
      launch: preset.opened.launch, resource: { contributionRef: preset.opened.launch!.provider, schemaVersion: 1, value: {} },
      desired: 'stop', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    const poolId = '06986bf6-681b-46f1-8d68-bb619ac0c7f0';
    const pool = { kind: 'resolved', poolId, machineId: 'machine', priorityTier: 1 };
    const settings = { experiments: true, featureToggles: { voice: true } };
    const home = await serveActionHomes({ homes: [
      { key: 'compute', serverUrl: `https://par-recipes-${surface}.test`, accountId: 'owner', settings },
      { key: 'focused', serverUrl: `https://par-recipes-focused-${surface}.test`, accountId: 'other' },
    ], route: request => request.home === 'compute' && request.path === '/v1/features' ? Response.json(features)
      : request.home === 'compute' && request.path === '/v1/machines/presets/list' ? Response.json(presets)
      : request.home === 'compute' && request.path === '/v1/machines/managed/actions/get' ? Response.json(managed)
      : request.home === 'compute' && request.path === '/v1/machines/pools/resolve' ? Response.json(pool) : undefined });
    try {
      // Discover the Home identity through the real metadata producer before capturing its Action lifetime.
      expect(await getServerFeaturesSnapshot({ serverId: home.homes.compute!.id })).toMatchObject({ status: 'ready', serverIdentityId: homeId });
      const context = { surface, serverId: homeId };
      if (surface === 'ui') {
        expect(await createDefaultActionExecutor().execute('machines.presets.list', { homeId }, context))
          .toEqual({ ok: true, result: presets });
      } else {
        const name = getActionSpec('machines.presets.list').bindings?.voiceClientToolName;
        expect(name).toBeTruthy();
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        expect(JSON.parse(await handlers[name!]!({ homeId }, { serverId: homeId })))
          .toEqual({ ok: true, ...presets });
      }
      const input = { poolId, requestKey: 'par-ui-pool', purpose: 'session' };
      // Pools do not advertise Voice; exercise their existing UI owner only.
      if (surface === 'ui') expect(await createDefaultActionExecutor().execute('machines.pools.resolve', input, context))
        .toEqual({ ok: true, result: pool });
      // Account-backed managed reads use the same captured Home on Voice.
      const managedInput = { homeId, managedId: managed.id };
      if (surface === 'ui') expect(await createDefaultActionExecutor().execute('machines.managed.get',
        managedInput, context)).toEqual({ ok: true, result: managed });
      else {
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        expect(JSON.parse(await handlers.machines_managed_get!(managedInput, { serverId: homeId })))
          .toEqual({ ok: true, ...managed });
      }
      expect(home.requests.filter(request => request.path.startsWith('/v1/machines/')).map(request => ({
        home: request.home, accountId: request.accountId, path: request.path, body: request.body,
      }))).toEqual([
        { home: 'compute', accountId: 'owner', path: '/v1/machines/presets/list', body: { homeId } },
        ...(surface === 'ui' ? [{ home: 'compute', accountId: 'owner', path: '/v1/machines/pools/resolve', body: input }] : []),
        { home: 'compute', accountId: 'owner', path: '/v1/machines/managed/actions/get', body: managedInput },
      ]);
    } finally {
      await home.dispose();
    }
  });

  it.each(['machines.provisioners.options', 'machines.managed.acquire', 'machines.managed.power.set'] as const)(
    'requests managed Voice %s with automation authority at the native approval owner', async actionId => {
      const homeId = `srv_voice_${actionId.replaceAll('.', '_')}`;
      const controller = { machineId: 'controller', installationId: 'installation' };
      const contribution = { pluginId: 'happier.machine.lima', localId: 'lima' };
      const launch = { provider: contribution, schemaVersion: 1, name: 'Guest', choices: {} };
      const managedId = 'managed';
      const managed = ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse({
        id: managedId, homeId, custodianAccountId: 'owner', controller, launch,
        resource: { contributionRef: contribution, schemaVersion: 1, value: {} },
        desired: 'stop', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      });
      const input = ManagedMachineActionInputSchemasV1[actionId].parse(actionId === 'machines.provisioners.options'
        ? { homeId, controller, contribution, selectors: {} }
        : actionId === 'machines.managed.acquire' ? { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'one-off', homeId, controller, launch,
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }
        : { homeId, managedId, expectedRevision: 1, intent: 'stop', when: 'now' });
      const output = actionId === 'machines.provisioners.options'
        ? ManagedMachineActionOutputSchemasV1[actionId].parse(createMachineProvisionerOptionsFixture({ base: { launch: {} } }))
        : { kind: 'approval_request_created', actionId, artifactId: 'native-ask' };
      const settings = { experiments: true, featureToggles: { voice: true }, voice: { canApproveRequests: false } };
      const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: homeId } } });
      const serverUrl = `https://voice-native-${actionId.replaceAll('.', '-')}.test`;
      const execute = (received: unknown, context: Readonly<{ requestHeaders: Headers;
        target: Readonly<{ kind: 'machine'; machineId: string }>;
        invocation?: Readonly<{ surface: string; authority: string }> }>) => {
        expect(received).toEqual(input);
        expect(context.target).toEqual({ kind: 'machine', machineId: controller.machineId });
        expect(context.requestHeaders.get(AUTHORITY_CEILING_HEADER_V1)).toBe('account_automation');
        if (actionId === 'machines.provisioners.options') {
          expect(context.invocation).toMatchObject({ surface: 'voice', authority: 'account_automation' });
        }
        return output;
      };
      const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId,
        accountId: 'owner', machineId: controller.machineId, installationId: controller.installationId,
        actionId, tokenEpoch: 0, requesterInvocation: actionId === 'machines.provisioners.options' ? 'required' : 'none', execute });
      let managedReadUnavailable = false;
      const home = await serveActionHomes({ homes: [
        { key: 'compute', serverUrl, accountId: 'owner', settings, currentAccount: true },
        { key: 'focused', serverUrl: `https://voice-focused-${actionId.replaceAll('.', '-')}.test`, accountId: 'other', settings, currentAccount: true },
      ], route: async request => {
        if (request.home !== 'compute') return undefined;
        if (request.path === '/v1/features') return Response.json(features);
        if (request.path === '/v1/machines/managed/actions/get') return managedReadUnavailable
          ? Response.json({ error: 'unsupported' }, { status: 404 }) : Response.json(managed);
        return await boundary.handle(request.url, { method: request.method, headers: request.headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) ?? undefined;
      } });
      const enabledSettings = storage.getState().settings;
      try {
        expect(await getServerFeaturesSnapshot({ serverId: home.homes.compute!.id })).toMatchObject({ status: 'ready', serverIdentityId: homeId });
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        const toolName = actionId.replaceAll('.', '_');
        expect(handlers[toolName]).toBeTypeOf('function');
        const policyContext = { surface: 'voice' as const, authority: 'account_automation' as const };
        expect(isApprovalRequiredByActionsSettings(actionId, { v: 1, actions: {} }, policyContext))
          .toBe(actionId !== 'machines.provisioners.options');
        expect(JSON.parse(await handlers[toolName]!(input, { serverId: homeId }))).toEqual({ ok: true, ...output });
        const nativeRequests = home.requests.filter(request => request.path === `/v1/actions/${actionId}`);
        expect(nativeRequests).toEqual([expect.objectContaining({ home: 'compute', accountId: 'owner' })]);
        expect(home.requests.filter(request => request.path.startsWith('/v1/actions/')).map(request => request.path))
          .toEqual(actionId === 'machines.provisioners.options'
            ? [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`] : [`/v1/actions/${actionId}`]);
        // Tool parameters cannot substitute another Account or supply authority/approval custody.
        if (actionId === 'machines.provisioners.options') {
          expect(JSON.parse(await handlers[toolName]!({ ...input, accountId: 'other', authority: 'present_user', bypassApprovals: true },
            { serverId: homeId }))).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        }
        // A retained tool obeys current Voice availability even after discovery.
        if (actionId === 'machines.managed.acquire') {
          storage.setState({ settings: settingsParse({ ...settings, featureToggles: { voice: false } }) });
          expect(JSON.parse(await handlers[toolName]!(input, { serverId: homeId })))
            .toMatchObject({ ok: false, errorCode: 'action_disabled' });
        }
        // A refused controller preflight settles at the existing typed Action boundary.
        if (actionId === 'machines.managed.power.set') {
          managedReadUnavailable = true;
          expect(JSON.parse(await handlers[toolName]!(input, { serverId: homeId })))
            .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        }
        expect(home.requests.filter(request => request.path === `/v1/actions/${actionId}`)).toHaveLength(1);
      } finally {
        await home.dispose();
        storage.setState({ settings: enabledSettings });
      }
    });
});
