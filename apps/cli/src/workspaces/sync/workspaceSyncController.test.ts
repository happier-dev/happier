import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSyncController } from './workspaceSyncController';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncStatusV1 } from './workspaceSyncTypes';

const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [], includeGitDirectory: false };
const definition = { v: 1 as const, relationshipId: 'r1', controllerMachineId: 'm1', alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b', mode: 'keep_synced' as const, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
const status: WorkspaceSyncStatusV1 = { relationshipId: 'r1', controllerMachineId: 'm1', state: 'watching', alphaPath: '/a', betaPath: '/b', mode: 'keep_synced', changedFiles: 0, conflictCount: 0, lastSuccessfulSyncAtMs: null };

describe('WorkspaceSyncController', () => {
  it('serializes relationship commands and rejects definition mutation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ensure = vi.fn(async () => { await gate; return status; });
    const controller = new WorkspaceSyncController({ adapter: { ensure }, resolveWorkspaceRef: (id) => ({ machineId: 'other', rootPath: `/${id}` }) });
    const first = controller.ensure(definition);
    const second = controller.ensure(definition);
    release();
    await Promise.all([first, second]);
    expect(ensure).toHaveBeenCalledTimes(2);
    await expect(controller.ensure({ ...definition, mode: 'mirror_exactly' })).rejects.toMatchObject({ code: 'relationship_definition_conflict' });
  });
});
