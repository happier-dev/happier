import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storage';
import { executeProjectWorkerActionV1 } from './projectWorkerActions';

const remote = vi.hoisted(() => vi.fn());
// The Machine network boundary is the only replaced execution path.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: remote }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => { throw new Error('Unexpected rendering'); } }));

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => { home?.dispose(); home = undefined; remote.mockReset(); storage.getState().clearProjectAccountRowsScope(); });

describe('UI service placement Get through the Action front door', () => {
  it('observes a linked native declaration using source identity and refuses failed or withdrawn owner reads', async () => {
    home = await createPlainArtifactHomeFixture('https://service-placement.test', {
      handleRequest: async path => path === '/v1/projects/execution/config/read'
        ? new Response(JSON.stringify({ status: 'absent' })) : null,
    });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source', serverId, machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 };
    const worker = { ...source, id: 'copy', machineId: 'worker-machine', rootPath: '/copy' };
    const selection = { kind: 'native' as const, source: { kind: 'native' as const, tool: 'package_script' as const, file: 'package.json', target: 'dev' } };
    // Incumbent wire identity vector: SHA256 of this exact ordered tuple, not a new identity.
    const id = (ref: typeof source) => `project-service:${createHash('sha256').update(JSON.stringify([
      ref.serverId, ref.machineId, { workspaceRefId: ref.id, selection },
    ])).digest('hex')}`;
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationships = [{ v: 1 as const, relationshipId: 'linked', controllerMachineId: source.machineId,
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced' as const, enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }];
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source, worker], relationships, organizations: [], revisionsByPhysicalKey: {} });
    const target = { id: id(worker), source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
      machineId: worker.machineId, workspaceId: worker.id, workspace: { serverId, workspaceId: worker.id, machineId: worker.machineId, rootPath: worker.rootPath },
      cwd: worker.rootPath, declaration: { workspaceRefId: worker.id, selection }, serviceState: 'running', readiness: 'not_reported',
      title: 'dev', state: 'available', confidence: 'high', actions: ['manage'] };
    let failWorker = false;
    let withdrawRows = false;
    remote.mockImplementation(async ({ machineId, accountId, payload }) => {
      expect(accountId).toBe(scope.accountId);
      expect(payload).toEqual({ machineId, scope: 'workspace', workspaceRoot: machineId === source.machineId ? source.rootPath : worker.rootPath,
        projection: 'managed_bindings' });
      if (machineId !== source.machineId && machineId !== worker.machineId) throw new Error('Unrelated owner');
      if (machineId === worker.machineId && failWorker) throw new Error('Owner unavailable');
      if (withdrawRows) storage.getState().clearProjectAccountRowsScope();
      return { protocolVersion: 1, snapshot: { v: 1, machineId, updatedAt: 1, targets: machineId === worker.machineId ? [target] : [] } };
    });
    const get = () => executeProjectWorkerActionV1('projects.service.placement.get',
      { workspace: { serverId, refId: source.id }, serviceName: id(source) }, { expectedAccountId: scope.accountId });
    expect(await get()).toMatchObject({ status: 'ready', placement: { runsOn: { kind: 'primary' } },
      actual: { status: 'present', target: { id: id(worker) } } });
    failWorker = true;
    expect(await get()).toMatchObject({ actual: { status: 'unavailable' } });
    failWorker = false;
    withdrawRows = true;
    expect(await get()).toMatchObject({ actual: { status: 'unavailable' } });
  });
});
