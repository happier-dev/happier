import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { ApiMachineClient } from '@/api/apiMachine';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { executeMachineGuardAction } from '@/api/machine/machineGuard';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createBrowserDaemonRuntimeActionExecutor } from '@/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '@/daemon/browser/featureGate';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServiceLauncherStartTarget } from '@/daemon/local/services/launch/start';
import { createLocalServiceLauncherFeed } from '@/daemon/local/services/launch/feed';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicePreviewRegistry } from '@/daemon/local/services/preview/registry';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ExternalActionIngressOwner } from './externalAction';
import type { RpcActionExecutorContext } from './_actionDispatchAdapter';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineGuardActivityListV1Schema, type MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createGuardRuntime } from '@/daemon/guard/guardRuntime';
import type { GuardOwnership } from '@/daemon/guard/guardPlanner';
import { createGuardWatch } from '@/daemon/guard/view/guardWatch';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createIdleTerminalPolicyFixture } from '@/daemon/guard/idleTerminalPolicy.testkit';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { localServiceProcfsFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createSessionMemoryCeiling } from '@/daemon/platform/linux/sessionMemoryCeiling';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { evaluateSessionEligibility } from '@/daemon/guard/sessionEligibility';
import type { TrackedSession } from '@/daemon/types';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createDaemonMachineRpcRouteAttachmentCache } from '@/daemon/machineRpcRouteAttachments';
import { dispatchActionFromRpc } from './_actionDispatchAdapter';
import { registerDaemonMachineGuardRpcHandlers, type DaemonMachineGuardRoutes } from './daemonMachineGuard';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';

const identity = { serverId: 'home', machineId: 'machine', installationId: 'install', custodianAccountId: 'owner' };
const now = Date.UTC(2026, 9, 10, 12);
const cleanup: Array<() => Promise<void> | void> = [];
// The network dispatch boundary stores heterogeneous request handlers; each real route parses its own input.
type TransportHandler = { invoke(data: unknown, context?: RpcHandlerContext): unknown }['invoke'];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });
function context(actorAccountId = 'owner', role: 'use' | 'manage' = 'manage', admittedIdentity = identity): RpcHandlerContext {
  return { signal: new AbortController().signal, machineAdmission: { ...admittedIdentity, actorAccountId, role, encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true, localActionContext: { surface: 'cli', authority: 'present_user' } };
}
function entry(id: string, patch: Partial<MachineGuardActivityEntryV1> = {}): MachineGuardActivityEntryV1 {
  return { v: 1, id, at: now, kind: 'stopped_session', rule: 'memory_guard', outcome: 'done',
    attribution: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'install' },
    subject: { kind: 'session', sessionId: id, title: `Private ${id}` },
    wayBack: [{ label: 'review_processes', actionId: 'machines.guard.get', input: { machineId: 'machine' } },
      { label: 'resume', actionId: 'session.open', input: { sessionId: id } }], ...patch };
}
async function setup(useDefaultApiOwner = false, withCeilingOwner = false,
  machineTerminalAction?: ActionExecutorDeps['machineTerminalAction'], initialTarget = identity) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-guard-rpc-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  // Native reader and Account metadata transport are system boundaries; all owners beneath them are real.
  const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
    historyStore: await createMinuteHistoryStore({ directory: join(directory, 'history') }) });
  await sampler.start(); cleanup.push(() => sampler.stop());
  const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, nowMs: () => now, onError: error => { throw error; } });
  cleanup.push(() => summary.stop());
  let activityNow = now;
  const activity = await createActivityLog({ activeServerDir: directory, resourceSummary: summary, nowMs: () => activityNow });
  const policy = createMachineResourcesPolicyRuntime({ port: { read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
    compareAndSwap: async () => ({ status: 'unavailable' }) } });
  await policy.reload(); cleanup.push(() => policy.stop());
  const inventory = createManagedActivityInventory({ now: () => now, producers: [] }); cleanup.push(() => inventory.dispose());
  let beforeNativeRead: (() => void) | undefined;
  const procfs = localServiceProcfsFixture([]);
  const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', platform: 'linux', listRoots: () => [],
    censusDependencies: { platform: 'linux', linuxBoundary: { ...procfs, readdir: async path => {
      beforeNativeRead?.(); return procfs.readdir(path);
    } } } });
  const readFacts = async (owners?: GuardOwnership) => ({ ownership: owners ?? await ownership.readOwners({ freshness: 'fresh' }), inventory: await inventory.read(), targets: [] });
  const readPolicy = () => { const read = policy.read(); if (read.status !== 'ready') throw new Error('Policy unavailable'); return read.policy.guard; };
  const runtime = createGuardRuntime({ vitals: sampler, readPolicy, subscribePolicy: policy.subscribe, subscribe: inventory.subscribe,
    readFacts: () => readFacts(), activity, stop: async () => ({ status: 'failed', reason: 'no_process' }), notice: async () => false,
    notifyEpisode: async () => {}, nowMs: () => now, onError: error => { throw error; } });
  let currentTarget = initialTarget;
  const guard = createGuardWatch({ policy, sampler, ownership, readFacts, readTarget: () => currentTarget, activityLog: activity, sessionState: runtime,
    readState: () => ({ v: 1, capabilities: { memoryPressure: { status: 'available' }, ceiling: { status: 'unavailable', reason: 'no_user_manager' },
      keepAwake: { modes: ['off', 'on', 'on_power'] } }, keepAwakeHolding: false }),
    readLeftBehind: () => ({ count: 0, footprintBytes: 0 }), subscribe: runtime.subscribe, nowMs: () => now });
  cleanup.push(() => guard.dispose());
  let output: unknown = { opened: true };
  const opened: string[] = [];
  const serverSnapshot = { status: 'ready' as const, features: FeaturesResponseSchema.parse({ features: {
    browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
    localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true } },
  } }) };
  const browserGate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' }, resolveServerFeaturesSnapshot: () => serverSnapshot });
  const servicesGate = createLocalServicesDaemonFeatureGate({ env: { NODE_ENV: 'test' }, resolveServerFeaturesSnapshot: () => serverSnapshot });
  await Promise.all([browserGate.refresh(), servicesGate.refresh()]);
  const broker = createBrowserDaemonControlBroker();
  // The native adapter is the OS boundary; broker, routes, runtime and Action owners remain real.
  let browserFailed = true;
  broker.registerAdapter({ adapterKind: 'chromiumSidecar', ownsView: () => true, supportsOpenView: () => true,
    dispatchCommand: command => browserFailed
      ? { v: 1, commandId: command.commandId, status: 'failed', error: { code: 'adapter_unavailable', message: 'Native launch failed' } }
      : { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } });
  let clockFailed = false;
  const feed = createLocalServiceLauncherFeed({ machineId: 'machine', inventoryRegistry: createLocalServiceInventoryRegistry(),
    previewRegistry: createLocalServicePreviewRegistry(), now: () => { if (clockFailed) throw new Error('Clock unavailable'); return now; } });
  const services = createLocalServicesDaemonRuntimeActionExecutor({ featureGate: servicesGate,
    routes: { launcherRoutes: { ...feed, startTarget: createLocalServiceLauncherStartTarget({ feed, now: () => now }) } } });
  const browser = createBrowserDaemonRuntimeActionExecutor({ featureGate: browserGate, control: createBrowserDaemonControlRoutes({ broker }), fallback: services });
  const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.open': { approvalRequiredSurfaces: ['agent'] },
    'browser.view.open': { approvalRequiredSurfaces: [] }, 'localServices.launcher.start': { approvalRequiredSurfaces: [] } },
    approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'] } });
  let guardLocalAction: NonNullable<ActionExecutorDeps['machineGuardAction']>;
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    ...(machineTerminalAction ? { machineTerminalAction } : {}),
    sessionOpen: async request => { opened.push(request.sessionId); return output; },
    // Session metadata RPC is the system boundary; the permission/grant admission below is real.
    sessionPermissionModeSet: async () => { opened.push('permission-change'); return { applied: true }; },
    machineGuardAction: args => guardLocalAction(args),
    runtimeActionExecute: browser,
    // Real user policy, not a second approval decision maker.
    isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(id, settings, ctx),
    isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id, settings, ctx),
  });
  let routes: DaemonMachineGuardRoutes = { target: () => currentTarget, guard, activity, nowMs: () => activityNow,
    keepRunning: async input => ({ status: await runtime.keepRunning(input.sessionId ?? '') }),
    dispatchUndoAction: (input, ctx) => dispatchActionFromRpc({ ...ctx, actionId: 'machines.guard.activity.undo', input, executor,
      serverId: currentTarget.serverId, externalActionTarget: { kind: 'machine', machineId: currentTarget.machineId },
      callerAuthority: ctx.callerAuthority, runtimeAccountId: ctx.machineAdmission?.actorAccountId }),
  };
  const ceilingWrites: Array<{ unit: string; bytes: number | null }> = [];
  if (withCeilingOwner) {
    const tracked: TrackedSession = { pid: 42, happySessionId: 'session', startedBy: 'daemon', processStartTimeMs: 20 };
    const unit = createHappierLinuxScopeName('v1.0123456789ab.session.session')!;
    const ceiling = createSessionMemoryCeiling({ activeServerDir: directory, capability: { status: 'available' }, activityLog: activity, readPolicy,
      readSessions: async () => [{ tracked, root: { owner: { kind: 'session', sessionId: 'session' }, pid: 42,
        start: { startTimeMs: 20 }, live: true, ownerCreatedAtMs: 0,
        containment: { kind: 'linux_unit', prefix: `/user.slice/happier-jobs.slice/${unit}` } },
        label: 'Session', metadata: {}, attribution: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'install' } }],
      readEligibility: async runner => evaluateSessionEligibility({ tracked: runner, inventory: { coverage: 'complete', items: [] },
        draft: { status: 'absent' }, resume: { sessionId: 'session', rawSession: { machineId: 'machine', path: '/project' },
          metadata: { machineId: 'machine', path: '/project', flavor: 'codex', codexSessionId: 'native' } } }),
      stopSession: async () => false, notice: async () => true, notify: async () => {},
      // Native systemctl/cgroup observation is the OS boundary. Admission,
      // containment parsing, ceiling state and Activity remain real owners.
      native: { readFile: async path => path.endsWith('memory.events') ? 'high 0\noom_kill 0\n' : '0',
        writeFile: async () => {}, setProperty: async (unit, bytes) => { ceilingWrites.push({ unit, bytes }); },
        watch: () => ({ close() {} }) } });
    routes = { ...routes, setSessionCeiling: (input, _requester, signal) => ceiling.apply(input, signal) };
    cleanup.push(() => ceiling.stop());
  }
  const handlers = new Map<string, TransportHandler>();
  const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
  guardLocalAction = registerDaemonMachineGuardRpcHandlers(rpc, routes);
  let credentialCurrent = true;
  if (useDefaultApiOwner) {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const api = new ApiMachineClient(token, { id: 'machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
      daemonState: null, daemonStateVersion: 0 });
    cleanup.push(() => api.shutdown());
    // Install the real host executor as production composition does. No internal owner behavior is replaced.
    Reflect.set(api, 'externalActionIngressOwner', { currentServerId: 'home', executor,
      resolveTarget: async () => null } satisfies ExternalActionIngressOwner);
    api.registerMachineGuardRoutes({ ...routes, dispatchUndoAction: undefined });
    const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
      isCredentialCurrent: async () => credentialCurrent, machineGuardAction: args => api.executeMachineGuardAction(args) });
    guardLocalAction = args => deps.machineGuardAction!(args);
    // Received transport admission is the network boundary; invoke the actual registered ApiMachine handlers.
    const registered: ReadonlyMap<string, TransportHandler> = Reflect.get(Reflect.get(api, 'rpcHandlerManager'), 'handlers');
    for (const method of handlers.keys()) handlers.set(method, registered.get(`machine:${method}`)!);
  }
  const client = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineGuardAction: async args => executeMachineGuardAction({
    actionId: args.actionId, input: args.input, serverId: 'home', assertCurrent: async () => {},
    // Exact Machine RPC is the network boundary; receiving handlers and child Action owners remain real.
    call: async request => handlers.get(request.method)!(request.input, { ...context('owner', 'manage', initialTarget),
      localActionContext: { surface: args.context.surface, authority: args.context.authority } }),
  }) });
  return { activity, routes, handlers, opened, client, executor, settings, ceilingWrites, setOutput: (value: unknown) => { output = value; },
    setActivityNow: (value: number) => { activityNow = value; },
    beforeNativeRead: (read: () => void) => { beforeNativeRead = read; },
    setCredentialCurrent: (value: boolean) => { credentialCurrent = value; },
    setBrowserFailed: (value: boolean) => { browserFailed = value; }, setClockFailed: (value: boolean) => { clockFailed = value; },
    setTarget: (target: typeof identity) => { currentTarget = target; } };
}

describe('Machine guard current admission and original Action restoration', () => {
  it('parks Activity-only reads on durable appends without Guard census work', async () => {
    const f = await setup(true);
    let censuses = 0;
    f.beforeNativeRead(() => { censuses++; });
    const watch = f.handlers.get('daemon.guard.activity.watch');
    expect(watch).toBeTypeOf('function');
    const input = { machineId: identity.machineId, range: '7d', filter: 'stopped' };
    const first = await watch!(input, context()) as { changed: true; since: number; list: unknown };
    expect(first.changed).toBe(true);
    expect(MachineGuardActivityListV1Schema.parse(first.list).entries).toEqual([]);
    const controller = new AbortController();
    const pending = watch!({ ...input, since: first.since }, { ...context(), signal: controller.signal });
    await f.activity.append(entry('backdated', { at: now - 86_400_000 }));
    const changed = await pending as typeof first;
    expect(changed.since).not.toBe(first.since);
    expect(MachineGuardActivityListV1Schema.parse(changed.list).entries).toMatchObject([{ id: 'backdated' }]);
    const duplicate = watch!({ ...input, since: changed.since }, context());
    await f.activity.markUndone({ id: 'undo', ref: 'backdated', at: now,
      attribution: entry('backdated').attribution });
    expect(MachineGuardActivityListV1Schema.parse((await duplicate as typeof changed).list).entries)
      .toMatchObject([{ id: 'backdated', undoneAt: now }]);
    // Equal timestamps and deterministic repeated receipt IDs are still append edges.
    const afterUndo = (await duplicate as typeof changed).since;
    const repeatedId = watch!({ ...input, since: afterUndo }, context());
    await f.activity.append(entry('backdated', { at: now - 86_400_000 }));
    expect((await repeatedId as typeof changed).since).not.toBe(afterUndo);
    const abort = new AbortController();
    const parked = watch!({ ...input, since: (await repeatedId as typeof changed).since }, { ...context(), signal: abort.signal });
    abort.abort();
    await expect(parked).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    expect(censuses).toBe(0);
  });

  it('filters parked Activity answers for recipients and refuses revoked disclosure', async () => {
    const f = await setup();
    const watch = f.handlers.get(RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH)!;
    const input = { machineId: identity.machineId, range: '7d' };
    const guest = context('guest', 'use');
    const initial = await watch(input, guest) as { since: number };
    const pending = watch({ ...input, since: initial.since }, guest);
    await f.activity.append(entry('private-owner'));
    const answer = await pending as { since: number; list: unknown };
    expect(MachineGuardActivityListV1Schema.parse(answer.list)).toMatchObject({ entries: [], counts: { others: 1 } });
    const own = watch({ ...input, since: answer.since }, guest);
    await f.activity.append(entry('own', { attribution: { serverId: identity.serverId, machineId: identity.machineId,
      installationId: identity.installationId, accountId: 'guest' } }));
    const ownAnswer = await own as typeof answer;
    expect(MachineGuardActivityListV1Schema.parse(ownAnswer.list).entries).toMatchObject([{ id: 'own' }]);
    let current = true;
    const revoked = watch({ ...input, since: ownAnswer.since }, { ...guest, verifyMachineAdmissionCurrent: async () => current });
    current = false;
    await f.activity.append(entry('revoked'));
    await expect(revoked).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
  });

  it('refreshes Activity at UTC midnight, sliding expiry and future-record visibility without appends or census demand', async () => {
    const f = await setup();
    let censuses = 0;
    f.beforeNativeRead(() => { censuses++; });
    const watch = f.handlers.get(RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH)!;
    await f.activity.append(entry('expiring', { at: now - 7 * 86_400_000 + 500 }));
    await f.activity.append(entry('future', { at: now + 1000 }));
    const request = { machineId: identity.machineId, range: '7d' };
    type Answer = { changed: true; since: number; list: unknown };
    const initial = await watch(request, context()) as Answer;
    expect(MachineGuardActivityListV1Schema.parse(initial.list).entries).toMatchObject([{ id: 'expiring' }]);
    f.setActivityNow(now + 500);
    expect((await f.activity.list({ range: '7d' })).entries).toMatchObject([{ id: 'expiring' }]);
    f.setActivityNow(now + 501);
    expect((await f.activity.list({ range: '7d' })).entries).toEqual([]);
    const expired = await watch({ ...request, since: initial.since }, context()) as Answer;
    expect(expired.since).not.toBe(initial.since);
    expect(MachineGuardActivityListV1Schema.parse(expired.list).entries).toEqual([]);
    f.setActivityNow(now + 1000);
    const visible = await watch({ ...request, since: expired.since }, context()) as Answer;
    expect(MachineGuardActivityListV1Schema.parse(visible.list).entries).toMatchObject([{ id: 'future' }]);
    const today = await watch({ ...request, range: 'today' }, context()) as Answer;
    f.setActivityNow(Date.UTC(2026, 9, 11));
    const nextDay = await watch({ ...request, range: 'today', since: today.since }, context()) as Answer;
    expect(nextDay.since).not.toBe(today.since);
    expect(MachineGuardActivityListV1Schema.parse(nextDay.list).entries).toEqual([]);
    expect(censuses).toBe(0);
  });

  it('verifies passive reads at dispatch and disclosure, refusing revocation during real native observation', async () => {
    const f = await setup();
    let current = true;
    let verifications = 0;
    const manager = new RpcHandlerManager({ scopePrefix: identity.machineId, localMachineId: identity.machineId,
      encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: identity.machineId, resolveCustodianAccountId: async () => identity.custodianAccountId,
        resolveInstallationId: () => identity.installationId,
        // Home verification is the network boundary; Guard, Activity and dispatcher remain real.
        verifyMachineAdmission: async () => { verifications++; return current; },
      }) });
    registerDaemonMachineGuardRpcHandlers(manager, f.routes);
    const request = (method: string, params = {}) => ({ method: `${identity.machineId}:${method}`,
      params: { machineId: identity.machineId, ...params }, callerAuthority: 'present_user' as const,
      machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: identity.machineId,
        installationId: identity.installationId, custodianAccountId: identity.custodianAccountId,
        actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' }) });
    f.beforeNativeRead(() => { current = false; });
    expect(await manager.handleRequest(request(RPC_METHODS.MACHINES_GUARD_GET))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(verifications).toBe(2);
    const beforeDenied = verifications;
    expect(await manager.handleRequest(request(RPC_METHODS.MACHINES_GUARD_GET))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(verifications - beforeDenied).toBe(1);
    current = true;
    f.beforeNativeRead(() => {});
    for (const [method, params, expected] of [
      [RPC_METHODS.MACHINES_GUARD_GET, {}, { policyRevision: 1, idle: [] }],
      [RPC_METHODS.DAEMON_GUARD_WATCH, {}, { changed: true, view: { policyRevision: 1, idle: [] } }],
      [RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, { range: 'today' }, { entries: [] }],
      [RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH, { range: 'today' }, { changed: true, list: { entries: [] } }],
    ] as const) {
      const before = verifications;
      const response = await manager.handleRequest(request(method, params));
      expect(response).toMatchObject(expected);
      expect(verifications - before).toBe(2);
    }
  });
  it('reads the paired-owner Guard through a caller-local Home label with current admission', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      await withTempDir('happier-guard-home-', async home => {
        env.patch({ HAPPIER_HOME_DIR: home }); reloadConfiguration();
        const profile = await addServerProfile({ name: 'stack_resources__id_default', serverUrl: 'https://qa.example.test', webappUrl: 'https://qa.example.test' });
        const homeId = 'srv_resources_qa';
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
          v: 1, homeServerIdentityId: homeId, canonicalServerUrl: profile.serverUrl, revision: 1,
          endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        const f = await setup(); f.setTarget({ ...identity, serverId: profile.id });
        const get = f.handlers.get(RPC_METHODS.MACHINES_GUARD_GET)!;
        const input = { machineId: identity.machineId, serverId: 'browser-home' };
        await expect(get(input, { ...context(), verifyMachineAdmissionCurrent: async () => false })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(get(input, { ...context(), machineAdmission: { ...context().machineAdmission!, installationId: 'stale' } }))
          .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(await get(input, context())).toMatchObject({ policyRevision: 1, idle: [], recentActivity: [] });
        const watch = f.handlers.get(RPC_METHODS.DAEMON_GUARD_WATCH)!;
        await expect(watch(input, { ...context(), verifyMachineAdmissionCurrent: async () => false })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(watch(input, { ...context(), machineAdmission: { ...context().machineAdmission!, installationId: 'stale' } }))
          .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(await watch(input, context())).toMatchObject({ changed: true, view: { policyRevision: 1, idle: [] } });
      });
    } finally { env.restore(); reloadConfiguration(); }
  });
  it('cancels and reanchors the actual pending PTY warning through the terminal-target Action', async () => {
    const f = await setup();
    const terminal = await createIdleTerminalPolicyFixture(cleanup);
    terminal.enable(); terminal.foreground(102);
    const target = { ...identity, installationId: 'installation' };
    await terminal.terminals.ensure({ terminalKey: 'command', cwd: '/project',
      custody: { ...target, requesterAccountId: 'owner', kind: 'machine', rootPath: '/project' } });
    terminal.now(90_000); await (await terminal.readPlan()).run?.();
    expect(terminal.terminals.list()[0]).toHaveProperty('terminalGuardStateV1');
    registerDaemonMachineGuardRpcHandlers({ registerHandler: (method, handler) => { f.handlers.set(method, handler); } },
      { ...f.routes, target: () => target,
        keepRunning: (input, requester, signal) => terminal.owner.keepRunning({ terminalKey: input.terminalKey! }, requester, signal) });
    const client = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineGuardAction: args => executeMachineGuardAction({
      actionId: args.actionId, input: args.input, serverId: 'home', assertCurrent: async () => {},
      call: async request => f.handlers.get(request.method)!(request.input, { ...context(),
        machineAdmission: { ...context().machineAdmission!, installationId: 'installation' } }),
    }) });
    expect(await client.execute('machines.guard.idleStop.keepRunning', { machineId: 'machine', terminalKey: 'command' },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: { status: 'kept' } });
    expect(terminal.terminals.list()[0]).not.toHaveProperty('terminalGuardStateV1');
    expect(terminal.readPolicy().idleTerminals.afterMs).toBe(120_000);
    expect(terminal.terminals.readGuardResources()[0]?.lastActivityAtMs).toBe(terminal.nowMs());
    expect((await terminal.readPlan()).nextAt).toBe(terminal.nowMs() + terminal.readPolicy().idleTerminals.afterMs - terminal.readPolicy().idleTerminals.warnBeforeMs);
    terminal.now(120_000); await (await terminal.readPlan()).run?.();
    expect(terminal.processes[0]?.kills).toBe(0);
  });
  it('applies and removes a Session ceiling through canonical Action and actual native owner', async () => {
    const f = await setup(true, true);
    for (const bytes of [2048, null]) expect(await f.client.execute('machines.guard.sessionCeiling.set',
      { machineId: 'machine', sessionId: 'session', bytes }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'applied', appliesAt: 'now' } });
    expect(f.ceilingWrites.map(write => write.bytes)).toEqual([2048, null]);
    expect(new Set(f.ceilingWrites.map(write => write.unit)).size).toBe(1);
  });
  it('fails the ceiling Action closed when its native and Session owner is unavailable', async () => {
    const f = await setup(true);
    expect(await f.client.execute('machines.guard.sessionCeiling.set', { machineId: 'machine', sessionId: 'session', bytes: 1024 },
      { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(f.opened).toEqual([]);
    await expect(f.handlers.get(RPC_METHODS.MACHINES_GUARD_SESSION_CEILING_SET)!({ machineId: 'machine', sessionId: 'session', bytes: null }, context('reader', 'manage')))
      .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
  });
  it('restores the original UI-only Browser Action through CLI Undo without changing caller exposure', async () => {
    const f = await setup(true); f.setBrowserFailed(false);
    const wayBack = [{ label: 'reopen', actionId: 'browser.view.open', input: { commandId: 'cli-reopen', browserSessionId: 'browser-session',
      viewId: 'view', kind: 'openView', platform: 'desktop', target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test/' } } }] satisfies NonNullable<MachineGuardActivityEntryV1['wayBack']>;
    await f.activity.append(entry('cli-browser', { kind: 'closed_browser', subject: { kind: 'browser' },
      wayBack }));
    expect(await f.client.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: 'cli-browser' },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: true, result: { status: 'dispatched' } });
    expect((await f.activity.read('cli-browser'))?.undoneAt).toBe(now);
    expect(await f.executor.execute('browser.view.open', wayBack[0]!.input,
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    await f.activity.append(entry('retired-credential', { kind: 'closed_browser', subject: { kind: 'browser' },
      wayBack }));
    f.setCredentialCurrent(false);
    // The raw core translates the CLI dependency's currentness exception to its canonical Action failure.
    expect(await f.client.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: 'retired-credential' },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'action_failed' });
    expect((await f.activity.read('retired-credential'))?.undoneAt).toBeUndefined();
    f.setCredentialCurrent(true);
    const mismatchedAccount: RpcActionExecutorContext = { ...context(), surface: 'cli', authority: 'present_user',
      serverId: 'home', runtimeAccountId: 'other-account' };
    expect(await f.executor.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: 'retired-credential' }, mismatchedAccount))
      .toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect((await f.activity.read('retired-credential'))?.undoneAt).toBeUndefined();
  });
  it('restores a portable closed-terminal receipt through the invoking Home and canonical child Action', async () => {
    const terminal = await createIdleTerminalPolicyFixture(cleanup);
    const terminalTarget = { ...identity, installationId: 'installation' };
    const terminalEpoch = terminal.nowMs();
    terminal.now(now - terminalEpoch - 120_000);
    terminal.enable();
    expect((await terminal.terminals.ensure({ terminalKey: 'portable-prompt', cwd: '/project',
      custody: { ...terminalTarget, requesterAccountId: 'owner', kind: 'machine', rootPath: '/project' } })).ok).toBe(true);
    terminal.now(now - terminalEpoch); await (await terminal.readPlan()).run?.();
    expect(terminal.terminals.list()).toEqual([]);
    const receipt = (await terminal.activityLog.list({ range: 'today' })).entries.find(row => row.kind === 'closed_terminal');
    if (!receipt) throw new Error('Expected closed-terminal Activity receipt');
    expect(receipt.wayBack?.[0]?.input).not.toHaveProperty('serverId');
    const terminalRequests: Array<Parameters<NonNullable<ActionExecutorDeps['machineTerminalAction']>>[0]> = [];
    // Machine-terminal RPC is the network boundary; receipt storage, Guard and child Action admission remain real.
    const f = await setup(true, false, async request => {
      terminalRequests.push(request);
      return { ok: true, terminalId: 'reopened-terminal', reused: false };
    }, terminalTarget);
    // The original Action's own Account policy permits CLI reopening; Undo's approval is not borrowed.
    if (!f.settings.approvalWaivedSurfaces) throw new Error('Expected fixture approval waivers');
    f.settings.approvalWaivedSurfaces['machines.terminal.open'] = ['cli'];
    await f.activity.append(receipt);
    expect(await f.client.execute('machines.guard.activity.undo', { machineId: identity.machineId, entryId: receipt.id },
      { surface: 'cli', authority: 'present_user', serverId: identity.serverId }))
      .toEqual({ ok: true, result: { ok: true, terminalId: 'reopened-terminal', reused: false } });
    expect(terminalRequests).toMatchObject([{ actionId: 'machines.terminal.open',
      input: { serverId: identity.serverId, machineId: identity.machineId, terminalKey: 'portable-prompt', cwd: '/project' },
      context: { serverId: identity.serverId, runtimeAccountId: 'owner' },
    }]);
    expect((await f.activity.read(receipt.id))?.undoneAt).toBe(now);
  });
  it('retains child policy, approval, grant and exact target bounds without borrowing the outer Undo approval', async () => {
    const f = await setup(); f.setBrowserFailed(false);
    const host: RpcActionExecutorContext = { ...context(), surface: 'cli', authority: 'present_user', serverId: 'home',
      externalActionTarget: { kind: 'machine', machineId: 'machine' }, externalActionCredential: {
        accountId: 'owner', principalId: 'principal', credentialId: 'credential', grant: ApiTokenGrantV1Schema.parse({ v: 1,
          actions: { families: [], ids: ['machines.guard.activity.undo'] }, targets: { machines: ['machine'], sessions: [] },
          approve: false, origins: [], models: null, permissionModes: null, create: null }) } };
    const receipt = entry('bounded-browser', { kind: 'closed_browser', subject: { kind: 'browser' },
      wayBack: [{ label: 'reopen', actionId: 'browser.view.open', input: { commandId: 'bounded', browserSessionId: 'browser-session',
        viewId: 'view', kind: 'openView', platform: 'desktop', target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test/' } } }] });
    await f.activity.append(receipt);
    f.settings.actions['browser.view.open']!.approvalRequiredSurfaces = ['cli'];
    expect(await f.client.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: receipt.id },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    const outerApproval: RpcActionExecutorContext = { ...context(), surface: 'cli', authority: 'present_user', serverId: 'home',
      bypassApprovals: true, presentUserConfirmation: { actionId: 'machines.guard.activity.undo' } };
    expect(await f.executor.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: receipt.id }, outerApproval))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect((await f.activity.read(receipt.id))?.undoneAt).toBeUndefined();
    await f.activity.append(entry('bounded-permission', { wayBack: [{ label: 'resume', actionId: 'session.permission_mode.set',
      input: { sessionId: 'session', permissionMode: 'bypassPermissions' } }] }));
    const permissionHost: RpcActionExecutorContext = { ...host, externalActionCredential: { ...host.externalActionCredential!,
      grant: ApiTokenGrantV1Schema.parse({ ...host.externalActionCredential!.grant,
        actions: { families: [], ids: ['machines.guard.activity.undo', 'session.permission_mode.set'] },
        targets: { machines: ['machine'], sessions: ['session'] }, permissionModes: ['default'] }) } };
    expect(await f.executor.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: 'bounded-permission' }, permissionHost))
      .toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
    expect((await f.activity.read('bounded-permission'))?.undoneAt).toBeUndefined();
    expect(f.opened).toEqual([]);
    f.settings.actions['browser.view.open']!.approvalRequiredSurfaces = [];
    f.settings.actions['browser.view.open']!.enabled = false;
    expect(await f.client.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: receipt.id },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    f.settings.actions['browser.view.open']!.enabled = true;
    expect(await f.executor.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: receipt.id }, host))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect((await f.activity.read(receipt.id))?.undoneAt).toBeUndefined();
    await f.activity.append(entry('wrong-child-target', { kind: 'stopped_service', subject: { kind: 'service', label: 'Service' },
      wayBack: [{ label: 'start_again', actionId: 'localServices.launcher.start', input: { machineId: 'other', targetId: 'missing' } }] }));
    expect(await f.client.execute('machines.guard.activity.undo', { machineId: 'machine', entryId: 'wrong-child-target' },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'machine_target_mismatch' });
    expect((await f.activity.read('wrong-child-target'))?.undoneAt).toBeUndefined();
  });
  it('filters Activity to the exact current recipient and keeps all effects custodian-only', async () => {
    const f = await setup();
    await f.activity.append(entry('own', { attribution: { serverId: 'home', accountId: 'reader', machineId: 'machine', installationId: 'install' } }));
    await f.activity.append(entry('private'));
    await f.activity.append(entry('old-install', { attribution: { serverId: 'home', accountId: 'reader', machineId: 'machine', installationId: 'old' } }));
    const list = f.handlers.get(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)!;
    expect(await list({ machineId: 'machine', range: 'today' }, context('reader', 'use')))
      .toMatchObject({ entries: [{ id: 'own' }], counts: { others: 2 } });
    const full = await list({ machineId: 'machine', range: 'today' }, context());
    expect(full).toMatchObject({ counts: { stopped: 3, others: 0 } });
    for (const [method, input] of [[RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO, { entryId: 'private' }],
      [RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING, { sessionId: 'private' }]] as const) {
      await expect(f.handlers.get(method)!({ machineId: 'machine', ...input }, context('reader', 'manage')))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    }
    const get = f.handlers.get(RPC_METHODS.MACHINES_GUARD_GET)!;
    await expect(get({ machineId: 'other', serverId: 'browser-home' }, context())).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    await expect(get({ machineId: 'machine' }, { ...context(), verifyMachineAdmissionCurrent: async () => false }))
      .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    expect(await f.handlers.get(RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING)!({ machineId: 'machine', sessionId: 'absent' }, context()))
      .toEqual({ status: 'not_pending' });
  });
  it('preserves native browser failure without claiming restoration and records a later successful retry', async () => {
    const f = await setup();
    const viewer = { ...context(), localActionContext: { surface: 'ui' as const, authority: 'present_user' as const } };
    await f.activity.append(entry('browser', { kind: 'closed_browser', subject: { kind: 'browser' },
      wayBack: [{ label: 'reopen', actionId: 'browser.view.open', input: { commandId: 'reopen', browserSessionId: 'browser-session',
        viewId: 'view', kind: 'openView', platform: 'desktop', target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test/' } } }] }));
    const undo = f.handlers.get(RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO)!;
    expect(await undo({ machineId: 'machine', entryId: 'browser' }, viewer)).toMatchObject({
      ok: false, errorCode: 'adapter_unavailable',
      details: { status: 'failed', commandId: 'reopen', error: { code: 'adapter_unavailable' } } });
    expect((await f.activity.read('browser'))?.undoneAt).toBeUndefined();
    f.setBrowserFailed(false);
    expect(await undo({ machineId: 'machine', entryId: 'browser' }, viewer)).toMatchObject({ status: 'dispatched' });
    expect((await f.activity.read('browser'))?.undoneAt).toBe(now);
  });
  it.each(['denied', 'failed'] as const)('preserves a real service start %s result without claiming restoration', async status => {
    const f = await setup();
    const viewer = { ...context(), localActionContext: { surface: 'ui' as const, authority: 'present_user' as const } };
    const undo = f.handlers.get(RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO)!;
    f.setClockFailed(status === 'failed');
    await f.activity.append(entry('service', { kind: 'stopped_service', subject: { kind: 'service', label: 'Service' },
      wayBack: [{ label: 'start_again', actionId: 'localServices.launcher.start', input: { machineId: 'machine', targetId: 'missing' } }] }));
    expect(await undo({ machineId: 'machine', entryId: 'service' }, viewer)).toMatchObject({ status,
      reasonCode: status === 'denied' ? 'launcher_target_unknown' : 'launcher_snapshot_unavailable' });
    expect((await f.activity.read('service'))?.undoneAt).toBeUndefined();
  });
  it('uses the first restorative Action, preserves its approval, and commits undo only after a valid owner result', async () => {
    const f = await setup(); await f.activity.append(entry('resume'));
    const undo = f.handlers.get(RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO)!;
    const agent = { ...context(), localActionContext: { surface: 'agent' as const, authority: 'account_automation' as const } };
    expect(await undo({ machineId: 'machine', entryId: 'resume' }, agent)).toMatchObject({ ok: false });
    expect(f.opened).toEqual([]); expect((await f.activity.read('resume'))?.undoneAt).toBeUndefined();
    f.setOutput({ kind: 'approval_request_created', artifactId: 'original-approval', actionId: 'session.open' });
    expect(await undo({ machineId: 'machine', entryId: 'resume' }, context()))
      .toEqual({ kind: 'approval_request_created', artifactId: 'original-approval', actionId: 'session.open' });
    expect((await f.activity.read('resume'))?.undoneAt).toBeUndefined();
    f.setOutput({ ok: false, errorCode: 'not_resumable', error: 'not_resumable' });
    expect(await undo({ machineId: 'machine', entryId: 'resume' }, context())).toMatchObject({ errorCode: 'not_resumable' });
    expect((await f.activity.read('resume'))?.undoneAt).toBeUndefined();
    f.setOutput(Number.NaN);
    expect(await undo({ machineId: 'machine', entryId: 'resume' }, context())).toMatchObject({ errorCode: 'invalid_action_output' });
    expect((await f.activity.read('resume'))?.undoneAt).toBeUndefined();
    f.setOutput({ opened: true });
    expect(await undo({ machineId: 'machine', entryId: 'resume' }, context())).toEqual({ opened: true });
    expect((await f.activity.read('resume'))?.undoneAt).toBe(now);
    expect(await undo({ machineId: 'machine', entryId: 'resume' }, context())).toMatchObject({ errorCode: 'activity_entry_unavailable' });
    await f.activity.append(entry('not-restorative', { wayBack: [{ label: 'review_processes', actionId: 'machines.guard.get', input: { machineId: 'machine' } }] }));
    expect(await undo({ machineId: 'machine', entryId: 'not-restorative' }, context())).toMatchObject({ errorCode: 'activity_entry_unavailable' });
    await f.activity.append(entry('invalid-input', { wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: '' } }] }));
    expect(await undo({ machineId: 'machine', entryId: 'invalid-input' }, context())).toMatchObject({ errorCode: 'invalid_action_input' });
    expect((await f.activity.read('invalid-input'))?.undoneAt).toBeUndefined();
  });
  it('retains the real guard owner across transport replacement and rejects identity changes across awaited reads', async () => {
    const f = await setup(); await f.activity.append(entry('retained'));
    const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => null });
    cache.attachMachineGuardRoutes(f.routes);
    // Registrar replacement is the network transport boundary; the guard and Activity owners remain real.
    const replacement = { registerMachineGuardRoutes: (routes: DaemonMachineGuardRoutes) => {
      registerDaemonMachineGuardRpcHandlers({ registerHandler: (method, handler) => { f.handlers.set(method, handler); } }, routes);
    } };
    cache.attachApiMachineForSessions(replacement as never);
    const get = f.handlers.get(RPC_METHODS.MACHINES_GUARD_GET)!;
    expect(await get({ machineId: 'machine' }, context())).toMatchObject({ recentActivity: [{ id: 'retained' }] });
    const changing = { ...context(), verifyMachineAdmissionCurrent: async () => {
      f.setTarget({ ...identity, installationId: 'replacement' }); return true;
    } };
    await expect(get({ machineId: 'machine' }, changing)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
  });
});
