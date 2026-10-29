import { act } from 'react-test-renderer';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { LocalServiceLaunchTargetV1Schema, type LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, RPC_ERROR_CODES, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { storage } from '@/sync/domains/state/storage';
import { createLocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import { getLocalServiceLauncherState, invalidateLocalServiceLauncherStore, readLocalServiceLauncherStore, publishLocalServiceLauncherSnapshot, resetLocalServiceLauncherStoreForTests } from '@/sync/domains/local/services/launch/sharedStore';
import { publishLocalServiceInventorySnapshot, resetLocalServiceInventoryStoreForTests } from '@/sync/domains/local/services/inventory/sharedStore';
import { useLocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { clearMachineRequestReachabilityForMachine } from '@/sync/domains/machines/reachability/machineReachability';

const remote = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
// Host renderer uses the real web adapter for the native haptic boundary.
vi.mock('@/components/ui/theme/haptics', () => import('@/components/ui/theme/haptics.web'));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { alert } }).module;
});
// Only the daemon transport is replaced; accepted topology, observation and both stores stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: remote }));
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; resetLocalServiceLauncherStoreForTests(); resetLocalServiceInventoryStoreForTests();
  storage.getState().clearProjectAccountRowsScope(); remote.mockReset(); alert.mockReset(); });

async function readCatalogBinding(serverId: string) {
  const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
  const resolved = await resolveServerCredentialAccountScope(serverId);
  if (resolved.kind !== 'bound' || !resolved.credentialKey) throw new Error('Expected the fixture Home credential binding');
  return { serverId: resolved.scope.serverId, accountId: resolved.scope.accountId, credentialKey: resolved.credentialKey };
}

describe('Project Services source feed plus actual native binding', () => {
  it('shares canonical controller demand and current Action publication for an admitted Project Home alias', async () => {
    home = await createPlainArtifactHomeFixture('https://project-services-alias.test', { handleRequest: async path =>
      path === '/v1/machines?includeRevoked=true' ? Response.json([{ id: 'source', revokedAt: null, replacedByMachineId: null }]) : null });
    const { setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
    const { createLocalServicesRuntimeActionExecutor } = await import('@/sync/domains/local/services/actions/runtimeActionExecutor');
    const { fetchLocalServiceLauncherSnapshotViaMachineRpc } = await import('@/sync/domains/local/services/launch/machineRpc');
    const identified = await setServerProfileIdentityForUrl(home.home.serverUrl, 'srv_project_services_alias');
    if (!identified?.serverIdentityId) throw new Error('Expected the actual Home identity owner to admit its portable alias');
    const canonicalServerId = resolveServerProfileScopeIdForIdentifier(identified.id);
    const serverId = identified.id === canonicalServerId ? identified.serverIdentityId : identified.id;
    expect(serverId).not.toBe(canonicalServerId);
    expect(resolveServerProfileScopeIdForIdentifier(serverId)).toBe(canonicalServerId);
    const account = await captureLazyActionAccountContext(serverId);
    const scope = account.accountLifetime.scope;
    storage.setState({ profileScope: scope });
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] });
    const actual = LocalServiceLaunchTargetV1Schema.parse({ ...declaration, id: 'native-instance',
      sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' }, serviceState: 'healthy',
      state: 'available', unavailableReason: undefined, readiness: 'ready', actions: ['manage'] });
    const watchSignals: AbortSignal[] = [];
    let running = false;
    let failNativeRead = false;
    remote.mockImplementation(async ({ method, machineId, payload, signal }: {
      method: string; machineId: string; payload: { projection?: 'managed_bindings' }; signal: AbortSignal;
    }) => {
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
        watchSignals.push(signal);
        return new Promise(() => {});
      }
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
        if (failNativeRead && payload.projection) throw new Error('Native read unavailable');
        return { protocolVersion: 1, snapshot: { v: 1, machineId, updatedAt: running ? 2 : 1,
          targets: payload.projection ? running ? [actual] : [] : [declaration] } };
      }
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: source.machineId, serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace' }));
    const readRows = () => buildLocalServiceRows({ inventoryRows: [],
      launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      rowIdsByTargetId: hook.getCurrent().launcherState?.rowIdsByTargetId, sessionId: null, scope: 'workspace' });
    try {
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start' } }));
      expect(watchSignals).toHaveLength(1);
      running = true;
      const execute = createLocalServicesRuntimeActionExecutor({
        catalogBinding: { lifetime: account.accountLifetime, credentialKey: resolveAuthCredentialsScopeKey(account.credentials) },
        fetchLauncherSnapshot: fetchLocalServiceLauncherSnapshotViaMachineRpc,
      });
      await act(async () => { await execute({ actionId: 'localServices.launcher.snapshot',
        input: { machineId: source.machineId, scope: 'workspace', workspaceRoot: source.rootPath }, context: { serverId } }); });
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject({ id: declaration.id, status: 'running', target: actual }));
      expect(watchSignals).toHaveLength(1);
      expect(storage.getState().projectAccountRows?.workspaceRefs[0]?.serverId).toBe(serverId);
      const lastKnownRow = readRows()[0];
      const bindingKey = { ...await readCatalogBinding(serverId), machineId: source.machineId,
        scope: 'workspace' as const, workspaceRoot: source.rootPath, projection: 'managed_bindings' as const };
      failNativeRead = true;
      await act(async () => {
        invalidateLocalServiceLauncherStore(bindingKey);
        await readLocalServiceLauncherStore(bindingKey);
      });
      await vi.waitFor(() => expect(getLocalServiceLauncherState(bindingKey).refreshStatus).toBe('error'));
      await flushHookEffects();
      expect(readRows()[0]).toEqual(lastKnownRow);
    } finally { await hook.unmount(); account.dispose(); }
    expect(watchSignals.every(signal => signal.aborted)).toBe(true);
  });

  it.each(['watch', 'home-reconnect', 'home-reconnect-invalid', 'daemon-restart', 'visibility'] as const)('updates a mounted stopped declaration after an external Start (%s)', async recovery => {
    let holdCensus = false;
    let censusReads = 0;
    const census = createDeferred<Response>();
    const machineRows = () => Response.json([{ id: 'source', revokedAt: null, replacedByMachineId: null }]);
    home = await createPlainArtifactHomeFixture('https://project-services-external-start.test', { handleRequest: async path => {
      if (path !== '/v1/machines?includeRevoked=true') return null;
      censusReads++;
      return holdCensus ? census.promise : machineRows();
    } });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] });
    const actual = LocalServiceLaunchTargetV1Schema.parse({ ...declaration, id: 'native-instance',
      sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' }, serviceState: 'healthy',
      state: 'available', unavailableReason: undefined, readiness: 'ready', actions: ['manage'] });
    const watches: Array<(value: unknown) => void> = [];
    const watchSignals: AbortSignal[] = [];
    let running = false;
    let sourceGeneration = 1;
    let holdReopen = false;
    let failBindings = false;
    const reopenedLauncher = createDeferred<void>();
    remote.mockImplementation(async ({ method, machineId, payload, signal }: {
      method: string; machineId: string; payload: { projection?: 'managed_bindings' }; signal: AbortSignal;
    }) => {
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
        watchSignals.push(signal);
        return new Promise((resolve, reject) => watches.push(value => value instanceof Error ? reject(value) : resolve(value)));
      }
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
        if (holdReopen) await reopenedLauncher.promise;
        if (payload.projection && failBindings) throw new Error('binding unavailable');
        return { protocolVersion: 1,
          snapshot: { v: 1, machineId, updatedAt: running ? 100 : payload.projection ? 1 : sourceGeneration,
            targets: payload.projection ? running ? [actual] : [] : [declaration] } };
      }
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    let presented = true;
    const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(PluginSurfaceFocusEligibilityProvider, { active: presented, children });
    let rowPublications = 0;
    let feedCommits = 0;
    const hook = await renderHook(() => {
      const feeds = useLocalServiceLiveFeeds({ machineId: source.machineId, serverId,
        workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace' });
      React.useLayoutEffect(() => { rowPublications++; }, [feeds.launcherState?.targetsById, feeds.launcherState?.rowIdsByTargetId]);
      React.useLayoutEffect(() => { feedCommits++; });
      return feeds;
    }, { wrapper });
    const readRows = () => buildLocalServiceRows({ inventoryRows: [],
      launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      rowIdsByTargetId: hook.getCurrent().launcherState?.rowIdsByTargetId, sessionId: null, scope: 'workspace' });
    try {
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start' } }));
      await vi.waitFor(() => expect(watches).toHaveLength(1));
      if (recovery === 'watch') {
        await flushHookEffects();
        const before = rowPublications;
        const commitsBefore = feedCommits;
        const countReads = (bindings: boolean) => remote.mock.calls.filter(([request]) =>
          request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
            && Boolean(request.payload.projection) === bindings).length;
        const sourceReads = countReads(false);
        const bindingReads = countReads(true);
        const key = { ...(await readCatalogBinding(serverId)), machineId: source.machineId,
          scope: 'workspace' as const, workspaceRoot: source.rootPath };
        // Replay 75 required source reads at the brief's four-second observation cadence.
        // Unchanged facts must not republish rows or restart the admitted binding census.
        for (let generation = 2; generation <= 76; generation++) {
          await act(async () => {
            sourceGeneration = generation;
            invalidateLocalServiceLauncherStore(key);
            await readLocalServiceLauncherStore(key);
          });
        }
        expect(rowPublications - before).toBe(0);
        expect(feedCommits - commitsBefore).toBe(0);
        expect(countReads(false) - sourceReads).toBe(75);
        expect(countReads(true) - bindingReads).toBe(0);
        expect(readRows()[0]).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start' } });
        const bindingKey = { ...key, projection: 'managed_bindings' as const };
        failBindings = true;
        await act(async () => {
          invalidateLocalServiceLauncherStore(bindingKey);
          await readLocalServiceLauncherStore(bindingKey);
        });
        await vi.waitFor(() => expect(getLocalServiceLauncherState(bindingKey).refreshStatus).toBe('error'));
        await flushHookEffects();
        expect(readRows()[0]).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start' } });
        const failedCensuses = censusReads;
        const failedCommits = feedCommits;
        const failedBindingReads = countReads(true);
        for (let failure = 1; failure < 75; failure++) {
          await act(async () => {
            invalidateLocalServiceLauncherStore(bindingKey);
            await readLocalServiceLauncherStore(bindingKey);
          });
        }
        expect(countReads(true) - failedBindingReads).toBe(74);
        expect(censusReads - failedCensuses).toBe(0);
        expect(feedCommits - failedCommits).toBe(0);
        failBindings = false;
        await act(async () => {
          invalidateLocalServiceLauncherStore(bindingKey);
          await readLocalServiceLauncherStore(bindingKey);
        });
        await vi.waitFor(() => expect(readRows()[0]?.status).toBe('stopped'));
      }
      if (recovery === 'visibility') {
        const cachedRow = readRows()[0];
        presented = false;
        await hook.rerender();
        expect(watchSignals.every(signal => signal.aborted)).toBe(true);
        const readsWhileClosed = remote.mock.calls.length;
        await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'connected' }); });
        expect(remote.mock.calls).toHaveLength(readsWhileClosed);
        running = true;
        holdReopen = true;
        presented = true;
        await hook.rerender();
        // SOURCE declaration plus its accepted native census stay visible while
        // the same canonical stores revalidate; pending is not cached content.
        expect(readRows()[0]).toEqual(cachedRow);
        reopenedLauncher.resolve();
        await vi.waitFor(() => expect(watches).toHaveLength(2));
      } else if (recovery !== 'watch') {
        // Non-timeout transport failure or invalid reply, without navigating the Services page.
        await act(async () => { watches[0]!(recovery !== 'home-reconnect-invalid'
          ? new RpcError('Transport unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) : { invalid: true }); });
        await flushHookEffects();
        expect.soft(hook.getCurrent().inventoryState.refreshState).toBe('error');
        expect.soft(readRows()[0]).toMatchObject({ id: declaration.id, status: 'stopped', primaryAction: { kind: 'start' } });
        expect(watches).toHaveLength(1);
        await act(async () => { publishHomeAccountChange('another-home', undefined, { source: 'connected' }); });
        await act(async () => {
          clearMachineRequestReachabilityForMachine({ ...scope, serverId: 'another-home' }, source.machineId);
          clearMachineRequestReachabilityForMachine(scope, 'another-machine');
        });
        await flushHookEffects();
        expect(watches).toHaveLength(1);
        const censusesBeforeRecovery = censusReads;
        holdReopen = recovery === 'home-reconnect-invalid';
        await act(async () => {
          if (recovery === 'daemon-restart') clearMachineRequestReachabilityForMachine(scope, source.machineId);
          else publishHomeAccountChange(serverId, undefined, { source: 'connected' });
        });
        await vi.waitFor(() => expect(watches).toHaveLength(2));
        if (holdReopen) {
          await flushHookEffects();
          expect.soft(censusReads - censusesBeforeRecovery).toBe(0);
          // The recovering native reads, not a second recovery observer, renew admission.
          await act(async () => { holdReopen = false; reopenedLauncher.resolve(); });
          await vi.waitFor(() => expect(readRows()[0]?.status).toBe('stopped'));
        }
      }
      running = true;
      const previousCensuses = censusReads;
      holdCensus = recovery === 'watch';
      await act(async () => { watches.at(-1)!({ protocolVersion: 1, changed: true,
        snapshot: { v: 1, machineId: source.machineId, generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] } }); });
      if (recovery === 'watch') {
        const key = { ...(await readCatalogBinding(serverId)), machineId: source.machineId,
          scope: 'workspace' as const, workspaceRoot: source.rootPath, projection: 'managed_bindings' as const };
        await vi.waitFor(() => expect(getLocalServiceLauncherState(key).targetsById.get(actual.id)?.serviceState).toBe('healthy'));
        await vi.waitFor(() => expect(censusReads).toBe(previousCensuses + 1));
        // The native publication is already present; fresh Machine/topology admission
        // gates its Project projection. No timer or additional launcher read is needed.
        expect(readRows()[0]?.status).toBe('stopped');
        const beforeAdmission = feedCommits;
        await act(async () => { census.resolve(machineRows()); });
        await vi.waitFor(() => expect(readRows()[0]?.status).toBe('running'));
        expect(feedCommits - beforeAdmission).toBe(1);
      }
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject({ id: declaration.id, status: 'running', target: actual }));
    } finally { census.resolve(machineRows()); reopenedLauncher.resolve(); await hook.unmount(); }
  });
  it.each([false, true])('isolates failed candidate reads from present SOURCE custody, while absence requires the full census (present=%s)', async hostPresent => {
    home = await createPlainArtifactHomeFixture('https://project-services-copy-binding.test', { handleRequest: async path =>
      path === '/v1/machines?includeRevoked=true' ? new Response(JSON.stringify(
        ['source', 'worker', 'paused-worker'].map(id => ({ id, revokedAt: null, replacedByMachineId: null })),
      )) : null });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    const worker = { ...source, id: 'worker-ref', machineId: 'worker', rootPath: '/copy' };
    const pausedWorker = { ...worker, id: 'paused-ref', machineId: 'paused-worker' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'committed-copy',
      controllerMachineId: source.machineId, alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id,
      mode: 'keep_synced', enabled: true, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: worker.id },
      committedAtMs: 1, createdAtMs: 1, updatedAtMs: 1 });
    const paused = WorkspaceSyncRelationshipV1Schema.parse({ ...relationship, relationshipId: 'paused-copy', enabled: false,
      betaWorkspaceRefId: pausedWorker.id, provenance: { ...relationship.provenance, targetWorkspaceRefId: pausedWorker.id } });
    const staged = WorkspaceSyncRelationshipV1Schema.parse({ ...paused, committedAtMs: null });
    const rows = { scope, status: 'ready' as const, coverage: 'complete' as const,
      workspaceRefs: [source, worker, pausedWorker], relationships: [relationship, staged], organizations: [], revisionsByPhysicalKey: {} };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, rows);
    const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] });
    const actual = LocalServiceLaunchTargetV1Schema.parse({ ...declaration,
      sourceClass: { kind: 'managed_service', managedServiceId: 'source-instance' }, serviceState: 'healthy',
      state: 'available', unavailableReason: undefined, readiness: 'ready', actions: ['manage'] });
    let pausedAvailable = false;
    const observedMachines = new Set<string>();
    // The production snapshot codec, shared stores, Account rows and binding hook are real.
    // Only the remote daemon/OS transport is substituted.
    remote.mockImplementation(async ({ method, machineId, payload }: {
      method: string; machineId: string; payload: { projection?: 'managed_bindings' };
    }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
        if (payload.projection === 'managed_bindings') {
          observedMachines.add(machineId);
          if (machineId === pausedWorker.machineId && !pausedAvailable) {
            throw new RpcError('Remote binding unavailable', RPC_ERROR_CODES.FORBIDDEN);
          }
        }
        return { protocolVersion: 1, snapshot: { v: 1, machineId, updatedAt: 1,
          targets: payload.projection ? machineId === source.machineId && hostPresent ? [actual] : [] : [declaration] } };
      }
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: source.machineId, serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace', inventoryState: createLocalServiceInventoryState() }));
    const readRows = () => buildLocalServiceRows({ inventoryRows: [],
      launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()], sessionId: null, scope: 'workspace' });
    try {
      const expected = hostPresent ? { status: 'running', target: actual } : { status: 'stopped', primaryAction: { kind: 'start', target: declaration } };
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject(expected));
      expect(observedMachines).toEqual(new Set([source.machineId, worker.machineId]));
      await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, { ...rows, relationships: [relationship, paused] }); });
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject(hostPresent ? expected : { status: 'unavailable',
        reasonCode: 'project_service_binding_unavailable', primaryAction: null,
        target: { unavailableMachineId: pausedWorker.machineId } }));
      expect(observedMachines.has(pausedWorker.machineId)).toBe(true);
      pausedAvailable = true;
      await act(async () => { publishLocalServiceInventorySnapshot({ ...(await readCatalogBinding(serverId)), machineId: pausedWorker.machineId }, {
        v: 1, machineId: pausedWorker.machineId, generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
      await vi.waitFor(() => expect(readRows()[0]).toMatchObject(expected));
    } finally { await hook.unmount(); }
  });
  it.each(['retry', 'watch', 'daemon-restart'] as const)('recovers a failed cold launcher through the real %s path', async recovery => {
    home = await createPlainArtifactHomeFixture('https://project-services-recovery.test', { handleRequest: async path =>
      path === '/v2/account/settings' ? new Response(JSON.stringify({ content: { t: 'plain', v: {} }, version: 0 })) : null });
    await home.hydrateAccountSettings();
    let available = false;
    let watches = 0;
    let rejectWatch!: (error: unknown) => void;
    const firstWatch = new Promise((_, reject) => { rejectWatch = reject; });
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      const inventory = { v: 1, machineId, generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] };
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
        if (++watches === 1) return firstWatch;
        if (watches === 2 && recovery === 'watch') return { protocolVersion: 1, changed: true,
          snapshot: { ...inventory, generatedAt: 3 } };
        return new Promise(() => {});
      }
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
        if (!available) throw Object.assign(new Error('deadline'), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE });
        return { protocolVersion: 1, snapshot: { v: 1, machineId, updatedAt: 2, targets: [] } };
      }
      return { protocolVersion: 1, snapshot: inventory };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId: home!.home.id, scope: 'machine' }));
    try {
      await vi.waitFor(() => expect(hook.getCurrent().launcherState?.refreshStatus).toBe('error'));
      await vi.waitFor(() => expect(watches).toBe(1));
      const unavailableRequests = remote.mock.calls.length;
      await flushHookEffects();
      expect(remote.mock.calls).toHaveLength(unavailableRequests);
      available = true;
      await act(async () => {
        if (recovery === 'retry') await hook.getCurrent().refresh!();
        else if (recovery === 'daemon-restart') clearMachineRequestReachabilityForMachine(
          { serverId: home!.home.id, accountId: 'artifact-account' }, 'source');
        else rejectWatch(Object.assign(new Error('deadline'), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE }));
      });
      await vi.waitFor(() => expect(hook.getCurrent().launcherState).toMatchObject({ refreshStatus: 'idle', updatedAt: 2 }));
      expect(hook.getCurrent().inventoryState.generatedAt).toBe(recovery === 'watch' ? 3 : 2);
      expect(alert).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
  });
  it.each(['absent', 'failed', 'retired'] as const)('settles the first fresh binding without another Machine census or inventory watch (%s)', async outcome => {
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) =>
      method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? new Promise(() => {})
        : { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } });
    let censusReads = 0;
    home = await createPlainArtifactHomeFixture('https://project-services-first-binding.test', { handleRequest: async path => {
      if (path !== '/v1/machines?includeRevoked=true') return null;
      if (++censusReads > 1) return new Promise<Response>(() => {});
      return new Response(JSON.stringify([{ id: 'source', revokedAt: null, replacedByMachineId: null }]));
    } });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] });
    let releaseBinding!: () => void;
    const bindingRead = new Promise<void>(resolve => { releaseBinding = resolve; });
    let bindingRequested = false;
    const snapshotClient = async (input: { machineId: string; projection?: 'managed_bindings' }) => {
      if (input.projection) { bindingRequested = true; await bindingRead; }
      if (input.projection && outcome === 'failed') return { ok: false as const, reason: 'request_failed' as const };
      return { ok: true as const, snapshot: { v: 1 as const, machineId: input.machineId, updatedAt: 1,
        targets: input.projection ? [] : [declaration] } };
    };
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace',
      inventoryState: createLocalServiceInventoryState(), launcherSnapshotClient: snapshotClient }));
    try {
      await vi.waitFor(() => expect(bindingRequested).toBe(true));
      const before = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
        sessionId: null, scope: 'workspace' });
      expect(before[0]?.primaryAction).toBeNull();
      expect.soft(before[0]?.status).toBe('loading');
      expect.soft(before[0]?.reasonCode).not.toBe('project_service_binding_unavailable');
      expect.soft(hook.getCurrent().launcherState!.refreshStatus).toBe('refreshing');
      await act(async () => {
        if (outcome === 'retired') storage.getState().clearProjectAccountRowsScope();
        releaseBinding();
      });
      await vi.waitFor(() => {
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
          sessionId: null, scope: 'workspace' });
        expect(rows[0]).toMatchObject(outcome === 'absent'
          ? { status: 'stopped', primaryAction: { kind: 'start', target: declaration } }
          : { status: 'unavailable', primaryAction: null });
        if (outcome === 'failed') expect(hook.getCurrent().launcherState!.refreshStatus).toBe('idle');
      });
      if (outcome === 'absent') {
        // A scan's timestamp alone does not change native bindings. Re-reading the
        // census here can suspend an already-settled page behind another slow request.
        await act(async () => {
          publishLocalServiceLauncherSnapshot({ ...(await readCatalogBinding(serverId)), machineId: source.machineId,
            scope: 'workspace', workspaceRoot: source.rootPath, projection: 'managed_bindings' },
          { v: 1, machineId: source.machineId, updatedAt: 2, targets: [] });
          await flushHookEffects();
        });
        expect(censusReads).toBe(1);
        expect(hook.getCurrent().launcherState!.refreshStatus).toBe('idle');
      }
    } finally { releaseBinding(); await hook.unmount(); }
  });
  it.each(['retry', 'daemon-restart'] as const)('recovers a failed Project census with unchanged native snapshots (%s)', async recovery => {
    let censusAvailable = false;
    let censusReads = 0;
    home = await createPlainArtifactHomeFixture('https://project-services-census-recovery.test', { handleRequest: async path => {
      if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
      if (path !== '/v1/machines?includeRevoked=true') return null;
      censusReads++;
      return censusAvailable ? Response.json([{ id: 'source', revokedAt: null, replacedByMachineId: null }])
        : new Response('', { status: 503 });
    } });
    await home.hydrateAccountSettings();
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] });
    remote.mockImplementation(async ({ method, machineId, payload }: {
      method: string; machineId: string; payload: { projection?: 'managed_bindings' };
    }) => {
      if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
      return { protocolVersion: 1, snapshot: method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
        ? { v: 1, machineId, updatedAt: 1, targets: payload.projection ? [] : [declaration] }
        : { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: source.machineId, serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace' }));
    const row = () => buildLocalServiceRows({ inventoryRows: [],
      launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()], sessionId: null, scope: 'workspace' })[0];
    try {
      await vi.waitFor(() => expect(row()).toMatchObject({ status: 'unavailable', primaryAction: null }));
      await flushHookEffects();
      const unavailableRequests = remote.mock.calls.length;
      const unavailableCensuses = censusReads;
      await flushHookEffects();
      expect(remote.mock.calls).toHaveLength(unavailableRequests);
      expect(censusReads).toBe(unavailableCensuses);
      censusAvailable = true;
      await act(async () => {
        if (recovery === 'retry') await hook.getCurrent().refresh!();
        else clearMachineRequestReachabilityForMachine(scope, source.machineId);
      });
      await vi.waitFor(() => expect(row()).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start' } }));
      expect(censusReads).toBe(unavailableCensuses + 1);
    } finally { await hook.unmount(); }
  });
  it('shows the typed daemon refusal through Refresh without exposing the transport message', async () => {
    home = await createPlainArtifactHomeFixture('https://project-services-refusal.test', { handleRequest: async path =>
      path === '/v2/account/settings' ? new Response(JSON.stringify({ content: { t: 'plain', v: {} }, version: 0 })) : null });
    await home.hydrateAccountSettings();
    let refuseRefresh = false;
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      if (refuseRefresh && method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
        throw new RpcError('private transport detail', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
      }
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 2,
        refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId: home!.home.id,
      scope: 'machine', launcherState: null }));
    try {
      await vi.waitFor(() => expect(hook.getCurrent().inventoryState.generatedAt).toBe(2));
      refuseRefresh = true;
      await act(async () => { await hook.getCurrent().refresh!(); });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]?.[1]).not.toContain(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
      expect(alert.mock.calls[0]?.[1]).not.toContain('private transport detail');
      const buttons = alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
      buttons.find(button => button.onPress)?.onPress?.();
      expect(alert.mock.calls[1]?.[1]).toContain(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    } finally {
      await hook.unmount();
    }
  });
  it.each([false, true])('explicit Refresh obeys Action enablement (%s), while automatic observations remain available', async enabled => {
    home = await createPlainArtifactHomeFixture('https://project-services-refresh.test', { handleRequest: async path =>
      path === '/v2/account/settings' ? new Response(JSON.stringify({ content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { 'localServices.inventory.refresh': { enabled } } },
      } }, version: 0 })) : null });
    await home.hydrateAccountSettings();
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH ? 2 : 1,
        refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId: home!.home.id,
      scope: 'machine', launcherState: null }));
    await vi.waitFor(() => expect(hook.getCurrent().inventoryState.generatedAt).toBe(2));
    remote.mockClear();
    await act(async () => { await hook.getCurrent().refresh!(); });
    expect(remote.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)).toBe(enabled);
    await hook.unmount();
  });
  it.each([false, true])('shows the worker occurrence and reobserves Stop (bind-child SOURCE=%s)', async bindChild => {
    let childProjection: unknown;
    let managedRow: unknown;
    let managedReads = 0;
    let managedReadFails = false;
    let sourceRevoked = false;
    home = await createPlainArtifactHomeFixture('https://project-services-feed.test', { handleRequest: async path => {
      if (path === '/v1/machines?includeRevoked=true') return new Response(JSON.stringify([{ id: 'source', installationId: 'child-installation',
        devcontainerChild: childProjection, revokedAt: sourceRevoked ? 1 : null, replacedByMachineId: null },
        { id: 'worker', installationId: 'worker-installation', revokedAt: null, replacedByMachineId: null },
        { id: 'parent', installationId: 'parent-installation', revokedAt: null, replacedByMachineId: null }]));
      if (path === managedMachineActionEndpointPathV1('machines.managed.get')) {
        managedReads++;
        if (managedReadFails) return Response.json({ error: 'unavailable' }, { status: 503 });
        return new Response(JSON.stringify(managedRow));
      }
      return null;
    } });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    const worker = { id: 'worker-ref', machineId: 'worker', serverId, rootPath: '/copy', createdAtMs: 1 };
    const parent = { ...source, id: 'parent-ref', machineId: 'parent', rootPath: '/host-source' };
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: source.rootPath,
      storage: { kind: 'bind', hostPath: parent.rootPath, childPath: source.rootPath } };
    childProjection = bindChild ? { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer', parentMachineId: 'parent' }, observation } : undefined;
    const initialManagedRow = { id: 'managed-child', homeId: serverId, custodianAccountId: 'artifact-account',
      controller: { machineId: 'parent', installationId: 'parent-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: observation },
      allocation: 'bound', creationState: 'active', enrolledMachineId: 'source', desired: 'start', desiredWhen: 'now',
      intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    managedRow = initialManagedRow;
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const physicalSource = bindChild ? parent : source;
    const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'copy', controllerMachineId: physicalSource.machineId,
      alphaWorkspaceRefId: physicalSource.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: bindChild ? [source, parent, worker] : [source, worker], relationships: [relationship], organizations: [], revisionsByPhysicalKey: {} });
    const declaration: LocalServiceLaunchTargetV1 = { id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] };
    const actual: LocalServiceLaunchTargetV1 = { ...declaration, id: 'worker-service', machineId: worker.machineId,
      workspaceId: worker.id, workspace: { serverId, machineId: worker.machineId, workspaceId: worker.id, rootPath: worker.rootPath },
      declaration: { workspaceRefId: worker.id, selection: { kind: 'manifest', name: 'web' } }, cwd: worker.rootPath,
      sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' }, state: 'available',
      unavailableReason: undefined, serviceState: 'running', readiness: 'ready', actions: ['manage'] };
    const declarations = Array.from({ length: 32 }, (_, index) => LocalServiceLaunchTargetV1Schema.parse({ ...declaration,
      id: `${declaration.id}-${index}`, declaration: { ...declaration.declaration, selection: { kind: 'manifest', name: `web-${index}` } } }));
    const actuals = declarations.map((target, index) => LocalServiceLaunchTargetV1Schema.parse({ ...actual,
      id: `${actual.id}-${index}`, sourceClass: { kind: 'managed_service', managedServiceId: `native-instance-${index}` },
      declaration: { ...actual.declaration, selection: target.declaration!.selection } }));
    let running = true;
    let finishRefresh!: () => void;
    const pendingRefresh = new Promise<void>(resolve => { finishRefresh = resolve; });
    let refreshing = false;
    const snapshotClient = async (input: { machineId: string; projection?: 'managed_bindings' }) => {
      if (input.projection && !running) { refreshing = true; await pendingRefresh; }
      return { ok: true as const,
      snapshot: { v: 1 as const, machineId: input.machineId, updatedAt: running ? 1 : 2,
        targets: input.projection === 'managed_bindings' ? input.machineId === 'worker' && running ? actuals : [] : declarations } };
    };
    const watchReplies = new Map<string, (value: unknown) => void>();
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise((resolve, reject) => {
        watchReplies.set(machineId, value => value instanceof Error ? reject(value) : resolve(value));
      });
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace',
      inventoryState: createLocalServiceInventoryState(), launcherSnapshotClient: snapshotClient }));
    await vi.waitFor(() => expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual(actuals));
    await flushHookEffects();
    expect(managedReads).toBe(bindChild ? 1 : 0);
    const readRows = () => buildLocalServiceRows({ inventoryRows: [],
      launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      rowIdsByTargetId: hook.getCurrent().launcherState?.rowIdsByTargetId, sessionId: null, scope: 'workspace' });
    expect(readRows()[0]).toMatchObject({ id: declarations[0]!.id, target: actuals[0] });
    await vi.waitFor(() => expect(watchReplies.has('worker')).toBe(true));
    const retainedWorkerRows = readRows();
    await act(async () => { watchReplies.get('worker')!(new RpcError('Daemon disconnected', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE)); });
    await flushHookEffects();
    expect(readRows()).toEqual(retainedWorkerRows);
    await act(async () => { clearMachineRequestReachabilityForMachine(scope, 'worker'); });
    await vi.waitFor(() => expect(readRows()[0]).toMatchObject({ id: declarations[0]!.id, status: 'running', target: actuals[0] }));
    const readsBeforeRefresh = managedReads;
    running = false;
    await act(async () => { publishLocalServiceInventorySnapshot({ ...(await readCatalogBinding(serverId)), machineId: 'worker' }, {
      v: 1, machineId: 'worker', generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
    await vi.waitFor(() => expect(refreshing).toBe(true));
    expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual(actuals);
    expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      sessionId: null, scope: 'workspace' })[0]).toMatchObject({ status: 'running' });
    await act(async () => { finishRefresh(); });
    await vi.waitFor(() => expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual(declarations));
    expect(managedReads - readsBeforeRefresh).toBe(bindChild ? 1 : 0);
    expect(readRows()[0]).toMatchObject({ id: declarations[0]!.id, target: declarations[0] });
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      sessionId: null, scope: 'workspace' });
    expect(row).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start', target: declarations[0] } });
    expect(row!.target.actions).toEqual([]);
    await hook.unmount();
    if (bindChild) {
      const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
      const { readUiWorkspaceSyncChildMachineFacts } = await import('@/sync/ops/workspaceSyncChildMachineFacts');
      const cancellation = new AbortController();
      const account = await captureLazyActionAccountContext(serverId);
      try {
        const failedCensus = await readUiWorkspaceSyncChildMachineFacts(account);
        managedReadFails = true;
        let before = managedReads;
        const failures = await Promise.allSettled([failedCensus.readChildMachines(['source']), failedCensus.readChildMachines(['source'])]);
        expect(failures.map(result => result.status)).toEqual(['rejected', 'rejected']);
        expect(managedReads - before).toBe(1);
        managedReadFails = false;
        // Recovery is a new census, not a per-declaration retry of this one's
        // settled failure, even when the HTTP boundary is now healthy.
        await expect(failedCensus.readChildMachines(['source'])).rejects.toThrow();
        expect(managedReads - before).toBe(1);
        managedRow = { ...initialManagedRow, intentRevision: 2 };
        const freshCensus = await readUiWorkspaceSyncChildMachineFacts(account, cancellation.signal);
        before = managedReads;
        const values = await Promise.all([freshCensus.readChildMachines(['source', 'parent']), freshCensus.readChildMachines(['source'])]);
        expect(values.map(value => value.map(fact => fact.machineId))).toEqual([['source'], ['source']]);
        expect(values.map(value => value.map(fact => fact.managedMachine.intentRevision))).toEqual([[2], [2]]);
        expect(managedReads - before).toBe(1);
        cancellation.abort();
        await expect(freshCensus.readChildMachines(['source'])).rejects.toThrow();
        expect(managedReads - before).toBe(1);
        sourceRevoked = true;
        const staleCensus = await readUiWorkspaceSyncChildMachineFacts(account);
        await expect(staleCensus.readChildMachines(['source'])).rejects.toThrow('Current Machine is unavailable');
        expect(managedReads - before).toBe(1);
        await home.dispose(); home = undefined;
        await expect(failedCensus.readChildMachines(['source'])).rejects.toThrow();
        expect(managedReads - before).toBe(1);
      } finally { account.dispose(); }
    }
  });
});
