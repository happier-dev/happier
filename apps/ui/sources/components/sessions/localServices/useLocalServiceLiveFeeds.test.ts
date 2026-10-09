import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';
import { createLocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import { resetLocalServiceLauncherStoreForTests } from '@/sync/domains/local/services/launch/sharedStore';
import { publishLocalServiceInventorySnapshot, resetLocalServiceInventoryStoreForTests } from '@/sync/domains/local/services/inventory/sharedStore';
import { useLocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';

const remote = vi.hoisted(() => vi.fn());
// Only the daemon transport is replaced; accepted topology, observation and both stores stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: remote }));
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => { home?.dispose(); home = undefined; resetLocalServiceLauncherStoreForTests(); resetLocalServiceInventoryStoreForTests();
  storage.getState().clearProjectAccountRowsScope(); remote.mockReset(); });

describe('Project Services source feed plus actual native binding', () => {
  it('shows the worker occurrence, preserves its exact provenance, and reobserves Stop through the existing worker watch', async () => {
    home = await createPlainArtifactHomeFixture('https://project-services-feed.test');
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    const worker = { id: 'worker-ref', machineId: 'worker', serverId, rootPath: '/copy', createdAtMs: 1 };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'copy', controllerMachineId: 'source',
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source, worker], relationships: [relationship], organizations: [], revisionsByPhysicalKey: {} });
    const declaration: LocalServiceLaunchTargetV1 = { id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] };
    const actual: LocalServiceLaunchTargetV1 = { ...declaration, id: 'worker-service', machineId: worker.machineId,
      workspaceId: worker.id, workspace: { serverId, machineId: worker.machineId, workspaceId: worker.id, rootPath: worker.rootPath },
      declaration: { workspaceRefId: worker.id, selection: { kind: 'manifest', name: 'web' } }, cwd: worker.rootPath,
      sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' }, state: 'available',
      unavailableReason: undefined, serviceState: 'running', readiness: 'ready', actions: ['manage'] };
    let running = true;
    const snapshotClient = async (input: { machineId: string; projection?: 'managed_bindings' }) => ({ ok: true as const,
      snapshot: { v: 1 as const, machineId: input.machineId, updatedAt: running ? 1 : 2,
        targets: input.projection === 'managed_bindings' ? input.machineId === 'worker' && running ? [actual] : [] : [declaration] } });
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace',
      inventoryState: createLocalServiceInventoryState(), launcherSnapshotClient: snapshotClient }));
    await vi.waitFor(() => expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual([actual]));
    running = false;
    await act(async () => { publishLocalServiceInventorySnapshot({ serverId, machineId: 'worker' }, {
      v: 1, machineId: 'worker', generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
    await vi.waitFor(() => expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual([declaration]));
    await hook.unmount();
  });
});
