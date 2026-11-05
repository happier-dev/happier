import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from './workspaceSyncTargetAuthority';
import { runNativeConfinedWorkspaceSyncApply } from './workspaceSyncNativeConfinedFileSystem';

it('reconciles only the host-selected endpoint while preserving another local root owner', async () => {
  await withTempDir('workspace-sync-local-endpoint-', async fixture => {
    const alpha = join(fixture, 'alpha');
    const beta = join(fixture, 'beta');
    await mkdir(alpha); await mkdir(beta);
    await writeFile(join(alpha, 'owned.txt'), 'other owner');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'alpha', serverId: 'home', machineId: 'local', rootPath: alpha, createdAtMs: 1 },
      { id: 'beta', serverId: 'home', machineId: 'local', rootPath: beta, createdAtMs: 1 },
      { id: 'source', serverId: 'home', machineId: 'remote', rootPath: '/remote/source', createdAtMs: 1 },
    ], relationships: [{ v: 1, relationshipId: 'relationship', controllerMachineId: 'remote', alphaWorkspaceRefId: 'source',
      betaWorkspaceRefId: 'beta', mode: 'keep_both_in_sync', enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 },
    { v: 1, relationshipId: 'other-relationship', controllerMachineId: 'remote', alphaWorkspaceRefId: 'source',
      betaWorkspaceRefId: 'alpha', mode: 'keep_both_in_sync', enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }],
    organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'requester' };
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const otherOwner = await rootOwnershipManager.tryAcquire({ ownerId: 'other-owner', canonicalRoot: alpha, operation: 'sync' });
    if ('kind' in otherOwner) throw new Error('Fixture root is already owned');
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'local', localWorkspaceRefId: 'beta',
      getProjectSnapshot: () => snapshot, callMachineRpc: async () => { throw new Error('No remote operation expected'); },
      openRootedAgent: async () => { throw new Error('No rooted agent may launch without READY'); },
      bootstrap: { materializationDirectory: join(fixture, 'materialization'), rootOwnershipManager } });
    try {
      await expect(authority.acquireWorkspaceSyncMachineIngress({ operationId: 'other-relationship', sourceMachineId: 'remote', targetMachineId: 'local' }))
        .rejects.toMatchObject({ code: 'peer_unavailable' });
      await authority.reconcileRetainedBootstraps();
      await otherOwner.assertCurrentRootIdentity(otherOwner.owner.rootFingerprint!);
      expect(await readFile(join(alpha, 'owned.txt'), 'utf8')).toBe('other owner');
      expect(await rootOwnershipManager.tryAcquire({ ownerId: 'contender', canonicalRoot: alpha, operation: 'sync' }))
        .toMatchObject({ kind: 'overlap', existing: { ownerId: 'other-owner' } });
    } finally { await authority.releaseAllRetainedBootstraps(); await otherOwner.release(); }
  });
});

it('retains failed local source agent cleanup for an explicit shutdown retry', async () => {
  await withTempDir('workspace-sync-local-source-', async root => {
    let stopped = false;
    let refuseStop = true;
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'local',
      callMachineRpc: async () => { throw new Error('No remote operation expected'); },
      // Rooted process is the genuine OS boundary. Custody and listener are real.
      openRootedAgent: async () => ({ stream: new PassThrough(), stop: async () => {
        if (refuseStop) { refuseStop = false; throw new Error('Process stop failed'); }
        stopped = true;
      } }),
    });
    await authority.openLocalWorkspaceAgentIngress({ operationId: 'operation', role: 'alpha', workspaceRefId: 'source', canonicalRoot: root });
    try {
      await expect(authority.releaseAllRetainedBootstraps()).rejects.toThrow('Process stop failed');
      expect(stopped).toBe(false);
    } finally { await authority.releaseAllRetainedBootstraps(); }
    expect(stopped).toBe(true);
  });
});

it.skipIf(process.platform !== 'linux')('settles a requester source journal with its controller loan when the installed Account graph differs', async () => {
  await withTempDir('workspace-sync-requester-recovery-', async fixture => {
    const sourceRoot = join(fixture, 'source');
    const resolutionDirectory = join(fixture, 'resolution');
    await mkdir(sourceRoot); await mkdir(resolutionDirectory);
    await writeFile(join(sourceRoot, 'reviewed.txt'), 'original');
    const materialPath = join(resolutionDirectory, 'entry');
    await writeFile(materialPath, 'selected');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'requester-relationship', controllerMachineId: 'local',
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'target', mode: 'keep_both_in_sync' as const, enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    let requesterRows: ActiveProjectAccountRowsSnapshot | null = { source: 'network', workspaceRefs: [
      { id: 'source', serverId: 'home', machineId: 'local', rootPath: sourceRoot, createdAtMs: 1 },
      { id: 'target', serverId: 'home', machineId: 'remote', rootPath: '/remote/target', createdAtMs: 1 },
    ], relationships: [relationship], organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'requester' };
    const otherAccountRows: ActiveProjectAccountRowsSnapshot = { ...requesterRows, workspaceRefs: [], relationships: [], scopeKey: 'installed' };
    let installedRows: ActiveProjectAccountRowsSnapshot | null = null;
    const roots = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const loan = await roots.tryAcquire({ ownerId: relationship.relationshipId, canonicalRoot: sourceRoot, operation: 'sync' });
    if ('kind' in loan) throw new Error('Source root is unexpectedly owned');
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'local',
      getProjectSnapshot: () => installedRows, resolutionMaterialDirectory: resolutionDirectory,
      callMachineRpc: async () => { throw new Error('No remote operation expected'); } });
    try {
      const expectedDestination = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
      const selectedExpectation = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
      let interrupted;
      try { interrupted = await runNativeConfinedWorkspaceSyncApply({ rootPath: sourceRoot, relativePath: 'reviewed.txt',
        expectedDestination, selectedExpectation, materialPath, recoveryDirectory: resolutionDirectory, operationId: 'requester-source',
        assertCurrentAuthority: async () => { await chmod(sourceRoot, 0o500); } }); }
      finally { await chmod(sourceRoot, 0o700); }
      expect(interrupted.status).toBe('recovery_needed');
      const request = { relationshipId: relationship.relationshipId, targetMachineId: 'local', targetWorkspaceRefId: 'source' };
      await expect(authority.recoverConflictResolutionHere(request)).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
      installedRows = otherAccountRows;
      await expect(authority.recoverConflictResolutionHere(request)).rejects.toMatchObject({ code: 'relationship_not_ready' });
      const localResolutionEndpoint = { relationship, canonicalRoot: sourceRoot,
        assertCurrentAuthority: async () => { await loan.assertCurrentRootIdentity(loan.owner.rootFingerprint!); } };
      expect(await authority.recoverConflictResolutionHere(request, undefined,
        { localResolutionEndpoint, getProjectSnapshot: () => requesterRows })).toEqual({ status: 'settled' });
      await expect(lstat(join(resolutionDirectory, 'workspace-recovery-requester-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(sourceRoot, 'reviewed.txt'), 'utf8')).toBe('original');
      requesterRows = null;
      await expect(authority.recoverConflictResolutionHere(request, undefined,
        { localResolutionEndpoint, getProjectSnapshot: () => requesterRows })).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
    } finally { await authority.releaseAllRetainedBootstraps(); await loan.release(); }
  });
});
