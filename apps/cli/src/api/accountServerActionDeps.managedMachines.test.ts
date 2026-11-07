import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { AccountSettingsSchema, ActionIdSchema, FeaturesResponseSchema, normalizeActionsSettingsV1, type ActionId } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { fixture as managedFixture, pluginId as managedPluginId } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { executeCliManagedAccountPower } from '@/machines/managed/accountPower';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import axios from '@/api/client/credentialAxios';

import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const socketBoundary = vi.hoisted(() => ({
  connections: [] as Array<{ serverUrl: string; token?: string }>,
  respond: undefined as ((event: string, payload: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('socket.io-client', async () => {
  const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  return { io: (serverUrl: string, options?: { auth?: { token?: string } }) => {
    socketBoundary.connections.push({ serverUrl, token: options?.auth?.token });
    return createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (!socketBoundary.respond) throw new Error(`Unexpected Socket.IO request: ${event}`);
      return socketBoundary.respond(event, payload);
    } });
  } };
});

describe('managed inventory CLI Home adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: policy }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('bound') });
    socketBoundary.respond = undefined;
    socketBoundary.connections.length = 0;
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
    'machines.setup.apply': ['cli', 'agent', 'mcp'],
    'session.stop': ['cli', 'agent', 'mcp'],
    'execution.run.stop': ['cli', 'agent', 'mcp'],
  } });

  function invoke(cli: ReturnType<typeof createCliActionExecutor>, surface: 'cli' | 'agent' | 'mcp', actionId: ActionId, input: unknown,
    defaultSessionId = 'cli-global') {
    if (surface === 'cli') return cli.execute(actionId, input, { ...context, actionsSettings: policy });
    return createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy })
      .executeActionByToolName('action_execute', { actionId, input }, defaultSessionId,
        { actionRequestId: `parity-${surface}-${actionId}` });
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

  it('reports unavailable guest diagnostics when Account inspection cannot reach the retained controller', async () => {
    const retained = { ...machine, enrolledMachineId: 'offline-guest' };
    app.post('/v1/machines/managed/actions/get', async () => retained);
    app.post('/v1/machines/managed/actions/inspect', async request => {
      // Guest diagnostics belongs to the executing host, not Home's strict read.
      expect(request.body).toEqual({ homeId: machine.homeId, managedId: machine.id });
      return { machine: retained };
    });
    await app.ready();
    const result = await executor().execute('machines.managed.inspect', {
      homeId: machine.homeId, managedId: machine.id, includeGuestDiagnostics: true,
    }, { ...context, runtimeAccountId: 'owner', actionsSettings: policy });
    expect(result).toMatchObject({ ok: true, result: { machine: { id: machine.id },
      guestDiagnostics: { status: 'unavailable', code: 'provider_unavailable' } } });
  });

  it('reads installed guest diagnostics through the selected Account native exec role', async () => {
    const base = managedFixture({ nativeTransport: true });
    const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
      actions: base.manifest.contributes.actions.map(action => ({ ...action, hostAccess: undefined,
        execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
    } });
    const provisioner = manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: manifest.id, localId: provisioner.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {} };
    const retained: ManagedMachineV1 = { ...machine, controller: undefined, launch, enrolledMachineId: 'guest-account',
      allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
      reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
    app.post('/v1/machines/managed/actions/inspect', async request => {
      expect(request.body).toEqual({ homeId: retained.homeId, managedId: retained.id });
      return { machine: retained };
    });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
      intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      uiArtifacts: [], packageAssets: [],
    }));
    const inspectInput = { homeId: retained.homeId, managedId: retained.id, includeGuestDiagnostics: true };
    const actionContext: ActionExecutorContext = { ...context, actionRequestId: 'guest-log-read', runtimeAccountId: 'owner' };
    const roles: string[] = [];
    actionContext.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.inspect', input: inspectInput,
      context: actionContext, plan: { children: [{ action: { pluginId: provider.pluginId, localId: 'exec' }, role: 'exec' }] },
      // The provider process is the system boundary; selection, private port,
      // credential binding and the managed read owner remain real.
      execute: async body => {
        expect(body).toMatchObject({ action: { pluginId: provider.pluginId, localId: 'exec' }, input: {
          resource: { id: 'same-native' }, argv: ['sh', '-c', expect.stringContaining("'doctor' '--json' '--include-daemon-log'")],
        } });
        roles.push('exec');
        const snapshot = { daemonState: { pid: 1, httpPort: 1, startedAt: 1, startedWithCliVersion: 'guest-version',
          machineId: 'guest-account', hasControlToken: true, daemonLogPath: null }, daemonLogs: [], doctorSnapshot: null,
          stackContext: null, runtime: { cwd: '', platform: 'linux', nodeVersion: '' },
          sessionDiagnostics: { context: { sessionId: '', metadataStatus: 'unavailable' }, logs: [] } };
        return { ok: true, result: { stdoutBase64: Buffer.from(JSON.stringify(snapshot)).toString('base64'), stderrBase64: '',
          stdoutTruncated: false, stderrTruncated: false,
          termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } } };
      } });
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    const result = await deps.managedMachineAction!({ actionId: 'machines.managed.inspect', input: inspectInput, context: actionContext });
    expect(result).toMatchObject({ machine: { id: retained.id }, guestDiagnostics: { status: 'collected',
      snapshot: { daemonState: { machineId: 'guest-account' } } } });
    expect(roles).toEqual(['exec']);
  });

  it.each([['account', false], ['account', true], ['native', false], ['native', true]] as const)(
    'executes the admitted Account power intent rather than treating its Home write as native success (%s consumer, refused=%s)', async (entry, refused) => {
    const service = { pluginId: 'acme.accounts', localId: 'cloud' };
    const disclosed: string[] = [];
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => ({ kind: 'account', account: { service, accountId: 'mutable-default' } }),
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: target.account.accountId } : null,
      materializeAccount: async ({ account }) => { disclosed.push(account.accountId); return { kind: 'environment', env: { TOKEN: account.accountId } }; },
      projectTargetAccounts: async () => { throw new Error('No account listing'); },
      assertTargetAccountMaterializable: async () => { throw new Error('No listed account use'); },
    });
    const base = managedFixture({ credentialOwner: owner });
    const provisioner = base.manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: managedPluginId, localId: provisioner.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
      purpose: { consumer: { pluginId: provider.pluginId, localId: 'power' }, purpose: 'upstream' }, account: { service, accountId: 'selected-account' },
    }] };
    let retained: ManagedMachineV1 = { id: 'retained', homeId: 'srv_home', custodianAccountId: 'owner', launch,
      allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 2,
      resource: { contributionRef: provider, schemaVersion: 1, value: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
      observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    };
    const powerInput = { homeId: retained.homeId, managedId: retained.id, expectedRevision: 2, when: 'now' as const, intent: 'start' as const };
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url); });
    const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
      actions: base.manifest.contributes.actions.map(action => ({ ...action,
        execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
    } });
    const reference = normalizePluginManifestV2({ schemaVersion: 2, id: service.pluginId, version: '1.0.0', displayName: 'Cloud', runtime: { apiVersion: 1 },
      contributes: { connectedAccountDescriptors: [{ id: service.localId, title: 'Cloud', authentication: { defaultModeId: 'token', modes: [{
        id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
      }] } }] } });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
      intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      uiArtifacts: [], packageAssets: [],
    }));
    // A noncustodian cannot borrow an inventory row. The power admission owns
    // the specific refusal and returns the sole native-effect descriptor.
    app.post('/v1/machines/managed/actions/get', async (_request, reply) => refused
      ? reply.code(403).send({ code: 'permission_denied' }) : retained);
    app.post('/v1/machines/managed/controller/admit-control', async (_request, reply) => {
      if (refused) return reply.code(403).send({ code: 'managed_power_required' });
      retained = { ...retained, desired: 'start', intentRevision: 3 };
      return { machine: retained, replayed: false };
    });
    app.post('/v1/machines/managed/controller/submit-intent', async () => ({ machine: retained, submitted: true }));
    app.post('/v1/machines/managed/controller/report-intent', async request => {
      expect(request.body).toMatchObject({ expectedIntentRevision: 3, requestId: 'original-power', result: { kind: 'confirmed' } });
      return { machine: retained };
    });
    const native: string[] = [];
    const runtime = managedFixture({ fixtureManifest: manifest, executionRealm: 'account', credentialOwner: owner, referenceManifests: [reference],
      onNativeRole: role => { native.push(role); }, onInspect: () => { native.push('inspect'); },
      nativeRoleResults: { inspect: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } } });
    const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => ({ registry: runtime.runtimeRegistry,
      source: 'ephemeral', durableRevision: -1, release: async () => {} }), connectedAccountPurposeBindingOwner: owner });
    const actionContext: ActionExecutorContext = { ...context, actionRequestId: 'original-power', runtimeAccountId: refused ? 'other' : 'owner',
      operationAcceptance: { operationId: 'original-operation', accept() {} }, operationOwnerUpdate: { update() {} } };
    // This constructs the consumer's canonical private-port boundary; it is
    // not evidence that production preparation has published the role plan.
    actionContext.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input: powerInput,
      context: actionContext, reviewAdmitted: true,
      plan: { children: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role })) },
      policies: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role, surface: 'cli' })),
      execute: async (body, childContext, actionId) => {
        expect(actionId).toBe('action.invoke');
        if (!body || typeof body !== 'object' || !('action' in body) || !body.action || typeof body.action !== 'object'
          || !('localId' in body.action) || typeof body.action.localId !== 'string') throw new Error('Expected provider Action');
        if (!('input' in body)) throw new Error('Expected provider operand');
        expect(body).toMatchObject({ input: { resource: {} } });
        return invoke({ action: { pluginId: provider.pluginId, localId: body.action.localId }, input: body.input, context: childContext });
      } });
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    const result = entry === 'account'
      ? await deps.managedMachineAction!({ actionId: 'machines.managed.power.set', input: powerInput, context: actionContext })
      : await executeCliManagedAccountPower({ body: powerInput, context: actionContext, credentials: { token: 'bound', encryption: null }, serverUrl: 'http://home.test',
        post: async (suffix, request, schema) => {
          const response = await axios.post(`http://home.test/v1/machines/managed/controller/${suffix}`, request,
            { headers: { Authorization: 'Bearer bound' }, validateStatus: () => true });
          if (response.status >= 400) throw new ManagedMachineControllerError('managed_power_required');
          return schema.parse(response.data);
        } }).catch((error: unknown) => {
          if (error instanceof ManagedMachineControllerError) return { ok: false, errorCode: error.code, error: error.code };
          throw error;
        });
    expect(result).toMatchObject(refused ? { ok: false, errorCode: 'managed_power_required' }
      : { kind: 'accepted', managedId: retained.id, intentRevision: 3 });
    expect(native).toEqual(refused ? [] : ['power', 'inspect']);
    // The native power handler materializes the selected token. The fixture's
    // Inspect returns its observed state without acquiring another token.
    expect(disclosed).toEqual(refused ? [] : ['selected-account']);
    expect(paths.filter(path => path.endsWith('/admit-control'))).toHaveLength(1);
    expect(paths.some(path => path.endsWith('/execution-authorization'))).toBe(false);
  });

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

  it.each(['cli', 'agent', 'mcp'] as const)('retries the exact managed birth read through the real %s Action without listing Sessions', async surface => {
    const actionId = ActionIdSchema.parse('machines.managed.birth.get');
    const seen: string[] = [];
    let runId: string | null = 'run-birth';
    let sessionId: string | null = 'session-birth';
    let refused = false;
    const path = '/v1/machines/managed/actions/birth.get';
    app.post(path, async (request, reply) => {
      seen.push(request.url);
      expect(request.body).toEqual({ homeId: 'srv_home', managedId: machine.id });
      expect(request.headers.authorization).toBe('Bearer bound');
      return refused ? reply.code(403).send({ code: 'permission_denied' })
        : { source: runId ? { kind: 'run', source: { kind: 'workflow_run', runId } }
          : sessionId ? { kind: 'session', sessionId } : null };
    });
    const cli = executor();
    const read = () => invoke(cli, surface, actionId, { homeId: 'srv_home', managedId: machine.id });
    expect(await read()).toEqual({ ok: true, result: { source: { kind: 'run', source: { kind: 'workflow_run', runId } } } });
    expect(seen.splice(0)).toEqual([path]);
    runId = null;
    expect(await read()).toEqual({ ok: true, result: { source: { kind: 'session', sessionId } } });
    expect(seen.splice(0)).toEqual([path]);
    sessionId = null;
    expect(await read()).toEqual({ ok: true, result: { source: null } });
    seen.length = 0;
    refused = true;
    expect(await read()).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    expect(seen).toEqual([path]);
    seen.length = 0;
    expect(await invoke(cli, surface, actionId, { homeId: 'foreign', managedId: machine.id })).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes Home inventory, preset edits, pools and sharing through the real %s adapter', async surface => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const preset = { id: 'preset-1', homeId: 'srv_home', revision: 2, name: 'Changed',
      owner: { kind: 'account', accountId: 'owner' }, launch: machine.launch, controller: machine.controller };
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
    const environment = { homeId: 'srv_home', machineId: 'controller-1', sources: [
      { kind: 'accountPreset', presetId: 'preset-1', presetRevision: 2, setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }],  } },
      { kind: 'direct', setup: {} },
    ] };
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
        if (method === 'machines.setup.apply') return { operationId: 'setup-1', terminalId: 'terminal-1' };
        if (method === RPC_METHODS.DAEMON_TERMINAL_LIST) return terminals;
        throw new Error(`Unexpected daemon method: ${method}`);
      } },
    });
    await expect(invoke(cli, surface, 'machines.setup.apply', environment))
      .resolves.toEqual({ ok: true, result: { operationId: 'setup-1', terminalId: 'terminal-1' } });
    await expect(invoke(cli, surface, 'machines.terminal.list', { serverId: 'route-home', machineId: 'controller-1' }))
      .resolves.toEqual({ ok: true, result: terminals });
    await expect(invoke(cli, surface, 'machines.work.summary.get', { serverId: 'route-home', machineId: 'controller-1' }))
      .resolves.toEqual({ ok: true, result: workSummary });
    await expect(invoke(cli, surface, 'machines.setup.apply', { ...environment, sources: environment.sources.map(source =>
      source.kind === 'accountPreset' ? { ...source, presetRevision: '2' } : source) }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(seen).toEqual([{ method: 'machines.setup.apply', request: environment },
      { method: RPC_METHODS.DAEMON_TERMINAL_LIST, request: {} },
      { method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: { serverId: 'route-home', machineId: 'controller-1' } }]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes Session and Run Stop through the real %s control owners on the captured Home', async surface => {
    const sessionId = 'c111111111111111111111111';
    const runId = 'stop-run';
    const seenHttp: Array<{ url: string; authorization?: string }> = [];
    const seenRpc: Array<{ method: string; request: unknown }> = [];
    app.get('/v2/sessions/:sessionId', async request => {
      seenHttp.push({ url: request.url, authorization: request.headers.authorization });
      return { session: createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify(createTestMetadata({ machineId: 'controller-1' })) }) };
    });
    app.get('/v1/account/encryption/currentness', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return createAccountEncryptionCurrentnessFixture();
    });
    app.get('/v1/machines/controller-1', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return { machine: { id: 'controller-1', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } };
    });
    // Only physical Home HTTP and Socket.IO acknowledgements are substituted.
    // Session resolution, metadata opening, stop policy and Run control remain real.
    socketBoundary.respond = async (event, payload) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      if (!payload || typeof payload !== 'object') throw new Error('Missing Stop RPC request');
      const method: unknown = Reflect.get(payload, 'method');
      if (typeof method !== 'string') throw new Error('Missing Stop RPC method');
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, Reflect.get(payload, 'params'), method);
      seenRpc.push({ method, request: decoded.params });
      const response = method === `controller-1:${RPC_METHODS.STOP_SESSION}` ? { status: 'requested' }
        : method === `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}` ? { ok: true }
        : undefined;
      if (!response) throw new Error(`Unexpected Stop RPC target: ${method}`);
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, response, decoded.callId) };
    };
    const cli = createCliActionExecutor({ token: 'bound', credentials: { token: 'bound', encryption: null },
      sessionId, serverId: 'route-home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null });
    await expect(invoke(cli, surface, 'session.stop', { sessionId }, sessionId)).resolves.toEqual({ ok: true,
      result: { ok: true, sessionId, stopped: false,
        stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'daemon_stop_requested' } } });
    await expect(invoke(cli, surface, 'execution.run.stop', { sessionId, runId }, sessionId))
      .resolves.toEqual({ ok: true, result: surface === 'cli' ? { ok: true } : {} });
    expect(seenRpc).toEqual([
      { method: `controller-1:${RPC_METHODS.STOP_SESSION}`, request: { sessionId } },
      { method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`, request: { runId } },
    ]);
    expect(seenHttp.length).toBeGreaterThan(0);
    expect(seenHttp.every(request => request.url.startsWith(`/v2/sessions/${sessionId}`)
      && request.authorization === 'Bearer bound')).toBe(true);
    expect(socketBoundary.connections.length).toBeGreaterThan(0);
    expect(socketBoundary.connections.every(connection => connection.serverUrl === 'http://home.test'
      && connection.token === 'bound')).toBe(true);
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
