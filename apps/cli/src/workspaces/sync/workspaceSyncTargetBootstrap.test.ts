import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';

import {
  prepareExistingGitWorkspaceSyncTarget,
  prepareWorkspaceSyncGitTarget,
  computeWorkspaceSyncRootFingerprint,
  rehydrateWorkspaceSyncTargetBootstrap,
  workspaceSyncTargetBootstrap,
} from './workspaceSyncTargetBootstrap';
import { beginWorkspaceTargetMaterialization } from '@/scm/workspace/workspaceExportMaterialization';
import { readWorkspaceSyncRootObjectIdentity } from './workspaceSyncRootIdentity';
import { createWorkspaceRootOwnershipManager, type WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';

const rootOwnershipManager = createWorkspaceRootOwnershipManager({
  lockDirectory: join(tmpdir(), `workspace-sync-bootstrap-locks-${process.pid}`),
});
const crashChildPath = join(dirname(fileURLToPath(import.meta.url)), 'workspaceSyncTargetBootstrap.child.ts');
const fakeMaterializationReceipt = {
  v: 1 as const,
  previousTargetName: null,
  originalTargetIdentity: null,
  promotedTargetIdentity: null,
  expectedBackupIdentity: null,
};

async function replacementApproval(rootPath: string): Promise<HandoffTargetReplacementApprovalV1> {
  const canonicalRoot = await realpath(rootPath);
  return {
    v: 1 as const,
    consequences: ['replace_nonempty_workspace_target'],
    serverId: 'server-1',
    machineId: 'machine-b',
    canonicalRoot,
    rootFingerprint: await computeWorkspaceSyncRootFingerprint(canonicalRoot),
    operationId: 'relationship-1',
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!(await access(path).then(() => true, () => false))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function killBootstrapChildAtBoundary(input: Readonly<{
  mode: 'existing' | 'existing-quarantined' | 'missing-git';
  target: string;
  staging: string;
  ready: string;
}>): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', crashChildPath, input.mode, input.target, input.staging, input.ready], {
    cwd: join(dirname(crashChildPath), '../../..'),
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  try {
    await waitForFile(input.ready);
    child.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`bootstrap child failed: ${stderr}`, { cause: error });
  }
}

describe('workspaceSyncTargetBootstrap', () => {
  it('returns approval_stale without mutation when the approved root object was replaced', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-stale-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    await mkdir(target);
    await writeFile(join(target, 'approved.txt'), 'old');
    const canonicalTarget = await realpath(target);
    const approval: HandoffTargetReplacementApprovalV1 = {
      v: 1 as const,
      consequences: ['replace_nonempty_workspace_target'],
      serverId: 'server-1',
      machineId: 'machine-b',
      canonicalRoot: canonicalTarget,
      rootFingerprint: await computeWorkspaceSyncRootFingerprint(canonicalTarget),
      operationId: 'handoff-action-1',
    };
    await rm(target, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, 'replacement.txt'), 'preserve');

    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: approval,
      materializeSeed: async () => { throw new Error('must not mutate'); },
    }))).rejects.toMatchObject({ code: 'approval_stale' });
    await expect(readFile(join(target, 'replacement.txt'), 'utf8')).resolves.toBe('preserve');
    await expect(access(materializationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  });
  it('recovers an existing target after process loss between rename and READY', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-crash-existing-'));
    const target = join(fixture, 'target');
    const staging = join(fixture, 'staging');
    const ready = join(fixture, 'child-ready');
    await mkdir(target);
    await writeFile(join(target, 'old.txt'), 'old');
    await killBootstrapChildAtBoundary({ mode: 'existing', target, staging, ready });

    const recovered = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: staging,
      relationshipId: 'relationship-crash',
      targetBootstrap: 'use_existing',
    }));
    await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old');
    await expect(readFile(join(target, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await recovered.release();
    await rm(fixture, { recursive: true, force: true });
  }, 60_000);

  it('rehydrates an absent target by restoring the quarantined predecessor before binding root identity', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-crash-quarantined-'));
    const target = join(fixture, 'target');
    const staging = join(fixture, 'staging');
    const ready = join(fixture, 'child-ready');
    await mkdir(target);
    await writeFile(join(target, 'old.txt'), 'old');
    await killBootstrapChildAtBoundary({ mode: 'existing-quarantined', target, staging, ready });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const recovered = await rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-crash',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: 'a'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory: staging,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(staging, 'root-locks') }),
      requireMaterializationReceipt: true,
    });

    expect(recovered).toBeNull();
    await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old');
    await expect(access(join(staging, `${createHash('sha256')
      .update('workspace-sync-bootstrap-v1\0')
      .update('relationship-crash')
      .update('\0beta')
      .digest('hex')}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  }, 60_000);

  it('restores a missing Git target to absence after process loss before SCM materialization', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-crash-missing-git-'));
    const target = join(fixture, 'target');
    const staging = join(fixture, 'staging');
    const ready = join(fixture, 'child-ready');
    await killBootstrapChildAtBoundary({ mode: 'missing-git', target, staging, ready });

    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: staging,
      relationshipId: 'relationship-crash',
      contentSelection: 'git_worktree',
      createIfMissing: false,
      targetBootstrap: 'materialize_from_source_workspace',
      prepareGitTarget: async () => undefined,
    }))).rejects.toMatchObject({ code: 'target_bootstrap_required' });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  }, 60_000);

  it('does not mutate an interrupted target when root ownership acquisition reports overlap', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-crash-overlap-'));
    const target = join(fixture, 'target');
    const staging = join(fixture, 'staging');
    const ready = join(fixture, 'child-ready');
    await mkdir(target);
    await writeFile(join(target, 'old.txt'), 'old');
    await killBootstrapChildAtBoundary({ mode: 'existing', target, staging, ready });
    const overlappingManager: WorkspaceRootOwnershipManager = {
      tryAcquire: async ({ canonicalRoot }) => ({
        kind: 'overlap',
        existing: {
          ownerId: 'other-daemon',
          canonicalRoot,
          operation: 'sync',
          rootFingerprint: null,
        },
      }),
    };

    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: staging,
      relationshipId: 'relationship-crash',
      rootOwnershipManager: overlappingManager,
      targetBootstrap: 'use_existing',
    }))).rejects.toMatchObject({ code: 'workspace_root_in_use' });
    await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
    await expect(readFile(join(target, 'old.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  }, 60_000);

  it('rejects a blank root before path resolution', async () => {
    await expect(workspaceSyncTargetBootstrap(input({ rootPath: '   ' }))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
  });

  it('requires an exact Action proof for a non-empty unmarked target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      targetBootstrap: 'materialize_from_source_workspace',
      materializeSeed: async () => undefined,
    }))).rejects.toMatchObject({ code: 'approval_stale' });
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    await rm(fixture, { recursive: true, force: true });
  });

  it('uses an explicitly selected existing target without replacing its contents', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    let seedCalled = false;
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      targetBootstrap: 'use_existing',
      materializeSeed: async () => { seedCalled = true; },
    }));
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    expect(seedCalled).toBe(false);
    expect(result).toMatchObject({ created: false, state: 'READY' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('authorizes an empty target for the initial Mutagen cycle without finite seed materialization', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    let seeded = false;
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace',
      materializeSeed: async ({ canonicalRoot }) => {
        seeded = true;
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
      },
    }));
    expect(seeded).toBe(false);
    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('holds replaced-target custody until commit and restores it on abort', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-custody-'));
    const target = join(fixture, 'target');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    let committed = 0;
    let aborted = 0;
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
      materializeSeed: async ({ canonicalRoot }) => {
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        return {
          receipt: fakeMaterializationReceipt,
          bindPromotedTarget: async () => undefined,
          commit: async () => { committed += 1; },
          abort: async () => {
            aborted += 1;
            await writeFile(join(canonicalRoot, 'restored.txt'), 'restored');
          },
        };
      },
    }));

    expect(committed).toBe(0);
    expect(aborted).toBe(0);
    await result.materializationCustody?.abort();
    expect(aborted).toBe(1);
    expect(committed).toBe(0);
    await expect(readFile(join(target, 'restored.txt'), 'utf8')).resolves.toBe('restored');
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('rolls back durable replacement custody when restart finds no final READY', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-rehydrate-custody-'));
    const target = join(fixture, 'target');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
      materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists }) => {
        const materialization = await beginWorkspaceTargetMaterialization({
          targetPath: canonicalRoot,
          backupDirectoryPrefix: '.happier-sync-backup',
          receiptPath: materializationReceiptPath,
          originalTargetExists,
        });
        await mkdir(canonicalRoot);
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        await materialization.custody.bindPromotedTarget();
        return materialization.custody;
      },
    }));
    await result.release();

    const recovered = await rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-1',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: 'a'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory: join(fixture, 'staging'),
      rootOwnershipManager,
    });
    expect(recovered).toBeNull();
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  });

  it('does not infer final readiness from a matching root when commit never published READY', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-no-ready-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await mkdir(target);
    const prepared = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
    }));
    await prepared.release();

    const rehydrated = await rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-1',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: 'a'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
    });
    expect(rehydrated).toBeNull();

    await prepared.publishReady();
    await expect(rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-1',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'different-workspace-ref',
      policyDigest: 'a'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
    })).resolves.toBeNull();
    const ready = await rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-1',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: 'a'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
    });
    expect(ready).not.toBeNull();
    await ready?.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('releases restart ownership when the target disappears after acquisition', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-rehydrate-race-'));
    const target = join(fixture, 'target');
    const lockDirectory = join(fixture, 'locks');
    const manager = createWorkspaceRootOwnershipManager({ lockDirectory });
    await mkdir(target);

    await expect(rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-1',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: 'a'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory: join(fixture, 'staging'),
      rootOwnershipManager: {
        tryAcquire: async (request) => {
          const ownership = await manager.tryAcquire(request);
          if (!('kind' in ownership)) await rm(target, { recursive: true });
          return ownership;
        },
      },
    })).rejects.toMatchObject({ code: 'root_changed' });

    await mkdir(target);
    const reacquired = await manager.tryAcquire({
      ownerId: 'relationship-2',
      canonicalRoot: await realpath(target),
      operation: 'sync',
    });
    expect(reacquired).not.toHaveProperty('kind');
    if (!('kind' in reacquired)) await reacquired.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('restores a missing all-files target to absence when materialization aborts', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-missing-all-files-'));
    const target = join(fixture, 'target');
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace',
      materializeSeed: async ({ canonicalRoot }) => {
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        return { receipt: fakeMaterializationReceipt, bindPromotedTarget: async () => undefined, commit: async () => undefined, abort: async () => undefined };
      },
    }));

    await result.materializationCustody?.abort();
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('restores a missing local Git target to absence when materialization aborts', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-missing-git-'));
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');
    await mkdir(source);
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      sourceRootPath: source,
      materializationDirectory: join(fixture, 'staging'),
      contentSelection: 'git_worktree',
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace',
      prepareGitTarget: async (request) => await prepareWorkspaceSyncGitTarget(request, {
        realizeWorkspaceCheckout: async ({ targetPath }) => {
          await expect(access(targetPath!)).rejects.toMatchObject({ code: 'ENOENT' });
          await mkdir(targetPath!);
          await writeFile(join(targetPath!, '.git-marker'), 'materialized');
          return { kind: 'git_worktree', targetPath: targetPath!, branchName: 'test', created: true };
        },
        inspectWorkspaceLocation: async ({ candidatePath }) => ({
          workspaceLocationScm: { provider: 'git', rootPath: candidatePath },
          checkoutDiscovery: [{ kind: 'git_worktree' }],
        }),
      }),
    }));

    await result.materializationCustody?.abort();
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('fails closed before creating an empty Git target when no SCM bootstrap owner is supplied', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      contentSelection: 'git_worktree',
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace',
    }))).rejects.toMatchObject({ code: 'target_bootstrap_required' });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  });

  it('accepts only an existing selected Git checkout rooted at the authorized target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-git-'));
    const target = join(fixture, 'target');
    const nested = join(target, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(target, '.git-marker'), 'test boundary');
    const inspectWorkspaceLocation = async () => ({
      workspaceLocationScm: { provider: 'git' as const, rootPath: target },
      checkoutDiscovery: [{ kind: 'git_worktree' as const }],
    });

    await expect(prepareExistingGitWorkspaceSyncTarget({
      canonicalRoot: target,
      targetState: 'nonempty',
    }, { inspectWorkspaceLocation })).resolves.toBeUndefined();
    await expect(prepareExistingGitWorkspaceSyncTarget({
      canonicalRoot: nested,
      targetState: 'nonempty',
    }, { inspectWorkspaceLocation })).rejects.toMatchObject({ code: 'git_selection_unavailable' });
    await expect(prepareExistingGitWorkspaceSyncTarget({
      canonicalRoot: target,
      targetState: 'empty',
    }, { inspectWorkspaceLocation })).rejects.toMatchObject({ code: 'target_bootstrap_required' });

    await rm(fixture, { recursive: true, force: true });
  });

  it('holds local Git target replacement under canonical materialization custody', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-git-materialize-'));
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    const realizeWorkspaceCheckout = async (request: Readonly<{
      sourcePath: string;
      targetPath?: string;
      checkoutCreation: Readonly<{ kind: string; displayName: string; baseRef: string | null; branchMode: string }>;
    }>) => {
      expect(request).toMatchObject({
        sourcePath: source,
        targetPath: target,
        checkoutCreation: { kind: 'git_worktree', branchMode: 'new' },
      });
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(target);
      await writeFile(join(target, '.git-marker'), 'materialized');
      return { kind: 'git_worktree' as const, targetPath: target, branchName: 'test', created: true };
    };
    const inspectWorkspaceLocation = async () => ({
      workspaceLocationScm: { provider: 'git' as const, rootPath: target },
      checkoutDiscovery: [{ kind: 'git_worktree' as const }],
    });

    const custody = await prepareWorkspaceSyncGitTarget({
      canonicalRoot: target,
      sourceRootPath: source,
      relationshipId: 'relationship-1',
      targetState: 'nonempty',
      targetBootstrap: 'materialize_from_source_workspace',
      materializationReceiptPath: join(fixture, 'materialization.json'),
      targetFence: {
        state: 'nonempty',
        identity: await readWorkspaceSyncRootObjectIdentity(target),
      },
    }, { realizeWorkspaceCheckout, inspectWorkspaceLocation });
    await custody?.abort();
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    await expect(readFile(join(target, '.git-marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await rm(fixture, { recursive: true, force: true });
  });

  it('reports offline when Git materialization has no reachable source workspace', async () => {
    await expect(prepareWorkspaceSyncGitTarget({
      canonicalRoot: '/tmp/unreachable-target',
      relationshipId: 'relationship-1',
      targetState: 'missing',
      targetBootstrap: 'materialize_from_source_workspace',
      materializationReceiptPath: '/tmp/.unreachable-target.happier-materialization.json',
      targetFence: { state: 'missing', identity: null },
    })).rejects.toMatchObject({ code: 'target_bootstrap_offline' });
  });

  it('acquires the mutation fence before creating a missing target root', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    let acquired = false;
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      createIfMissing: true,
      rootOwnershipManager: {
        tryAcquire: async (owner) => {
          await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
          acquired = true;
          return {
            owner: { ...owner, rootFingerprint: null },
            assertCurrentRootIdentity: async () => undefined,
            bindCurrentRootIdentity: async () => undefined,
            renew: async () => undefined,
            release: async () => undefined,
          };
        },
      },
    }));
    expect(acquired).toBe(true);
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('runs an explicit seed provider under the bootstrap fence before marking a non-empty target ready', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    await mkdir(target);
    await writeFile(join(target, 'scm-metadata'), 'present');
    let seedCalled = false;
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      materializeSeed: async ({ canonicalRoot }) => {
        seedCalled = true;
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
      },
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
    }));
    expect(seedCalled).toBe(true);
    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).resolves.toBe('seed');
    await expect(readdir(join(fixture, 'staging'))).resolves.toHaveLength(0);
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('leaves no durable bootstrap authority after materialization fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      materializeSeed: async () => {
        throw Object.assign(new Error('seed unavailable'), { code: 'target_bootstrap_offline' });
      },
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
    }))).rejects.toMatchObject({ code: 'target_bootstrap_offline' });
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    expect(await readdir(materializationDirectory)).toEqual([]);
    await rm(fixture, { recursive: true, force: true });
  });

  it('retains committed-copy evidence in the canonical materialization receipt after commit', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    const result = await workspaceSyncTargetBootstrap(input({ rootPath: target, materializationDirectory: join(fixture, 'staging'), createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace', materializeSeed: async () => undefined }));
    expect(result).toMatchObject({ created: true, state: 'READY', policyDigest: 'a'.repeat(64) });
    expect(result).not.toHaveProperty('markerPath');
    await expect(readdir(join(fixture, 'staging'))).resolves.toEqual([
      expect.stringMatching(/(?<!\.ready)\.json$/u),
    ]);
    await result.publishReady();
    await expect(readdir(join(fixture, 'staging'))).resolves.toEqual(expect.arrayContaining([
      expect.stringMatching(/(?<!\.ready)\.json$/u),
      expect.stringMatching(/\.ready\.json$/u),
    ]));
    await result.materializationCustody?.commit();
    await expect(readdir(join(fixture, 'staging'))).resolves.toEqual([
      expect.stringMatching(/^[a-f0-9]{64}\.json$/u),
      expect.stringMatching(/\.ready\.json$/u),
    ]);
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('keeps rollback custody when final READY publication fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-ready-failure-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    const readyFailure = new Error('injected READY publication failure');
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
      materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists }) => {
        const materialization = await beginWorkspaceTargetMaterialization({
          targetPath: canonicalRoot,
          backupDirectoryPrefix: '.happier-sync-backup',
          receiptPath: materializationReceiptPath,
          originalTargetExists,
        });
        await mkdir(canonicalRoot);
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        await materialization.custody.bindPromotedTarget();
        return materialization.custody;
      },
    }), { writeReadyFact: async () => { throw readyFailure; } });

    await expect(result.publishReady()).rejects.toBe(readyFailure);
    expect((await readdir(materializationDirectory)).some((name) => name.endsWith('.json'))).toBe(true);
    expect((await readdir(fixture)).some((name) => name.startsWith('.happier-sync-backup.'))).toBe(true);
    await result.materializationCustody?.abort();
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('treats exact READY plus receipt as committed cleanup pending on restart', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-ready-cleanup-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    const prepared = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
      materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists }) => {
        const materialization = await beginWorkspaceTargetMaterialization({
          targetPath: canonicalRoot,
          backupDirectoryPrefix: '.happier-sync-backup',
          receiptPath: materializationReceiptPath,
          originalTargetExists,
        });
        await mkdir(canonicalRoot);
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        await materialization.custody.bindPromotedTarget();
        return materialization.custody;
      },
    }));
    await prepared.publishReady();
    await prepared.release();

    const restarted = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
    }));
    expect(restarted).not.toBeNull();
    expect(restarted?.readyPublished).toBe(true);
    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).resolves.toBe('seed');
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(fixture)).some((name) => name.startsWith('.happier-sync-backup.'))).toBe(true);
    const pendingArtifacts = await readdir(materializationDirectory);
    expect(pendingArtifacts).toHaveLength(2);
    expect(pendingArtifacts.some((name) => name.endsWith('.ready.json'))).toBe(true);
    expect(pendingArtifacts.some((name) => name.endsWith('.json') && !name.endsWith('.ready.json'))).toBe(true);
    await restarted?.materializationCustody?.commit();
    expect((await readdir(fixture)).some((name) => name.startsWith('.happier-sync-backup.'))).toBe(false);
    await expect(readdir(materializationDirectory)).resolves.toEqual([
      expect.stringMatching(/^[a-f0-9]{64}\.json$/u),
      expect.stringMatching(/\.ready\.json$/u),
    ]);
    await restarted?.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('never restores the predecessor after exact READY when later Git verification fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-ready-verification-failure-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    const prepared = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
      materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists }) => {
        const materialization = await beginWorkspaceTargetMaterialization({
          targetPath: canonicalRoot,
          backupDirectoryPrefix: '.happier-sync-backup',
          receiptPath: materializationReceiptPath,
          originalTargetExists,
        });
        await mkdir(canonicalRoot);
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        await materialization.custody.bindPromotedTarget();
        return materialization.custody;
      },
    }));
    await prepared.publishReady();
    await prepared.release();
    const verificationFailure = Object.assign(new Error('source unavailable during invalid retry'), {
      code: 'target_bootstrap_offline',
    });

    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
      contentSelection: 'git_worktree',
      targetBootstrap: 'materialize_from_source_workspace',
      prepareGitTarget: async ({ targetBootstrap }) => {
        expect(targetBootstrap).toBe('use_existing');
        throw verificationFailure;
      },
    }))).rejects.toBe(verificationFailure);

    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).resolves.toBe('seed');
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(fixture)).some((name) => name.startsWith('.happier-sync-backup.'))).toBe(false);
    await expect(readdir(materializationDirectory)).resolves.toEqual([
      expect.stringMatching(/^[a-f0-9]{64}\.json$/u),
      expect.stringMatching(/\.ready\.json$/u),
    ]);
    await rm(fixture, { recursive: true, force: true });
  });

  it('does not trust mismatched READY to commit a retained rollback receipt', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-ready-mismatch-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'preserve');
    const prepared = await workspaceSyncTargetBootstrap(input({
      rootPath: target,
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
      targetBootstrap: 'materialize_from_source_workspace',
      targetReplacementApproval: await replacementApproval(target),
      materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists }) => {
        const materialization = await beginWorkspaceTargetMaterialization({
          targetPath: canonicalRoot,
          backupDirectoryPrefix: '.happier-sync-backup',
          receiptPath: materializationReceiptPath,
          originalTargetExists,
        });
        await mkdir(canonicalRoot);
        await writeFile(join(canonicalRoot, 'seeded.txt'), 'seed');
        await materialization.custody.bindPromotedTarget();
        return materialization.custody;
      },
    }));
    await prepared.publishReady();
    await prepared.release();

    await expect(rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: target,
      relationshipId: 'relationship-1',
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: 'b'.repeat(64),
      contentSelection: 'all_files',
      materializationDirectory,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
    })).resolves.toBeNull();
    await expect(readFile(join(target, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    await expect(readFile(join(target, 'seeded.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(fixture, { recursive: true, force: true });
  });

  it('does not use an untrusted relationship id as a receipt pathname', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'target');
    const materializationDirectory = join(fixture, 'staging');
    const result = await workspaceSyncTargetBootstrap(input({
      rootPath: target, materializationDirectory, relationshipId: '../escape', createIfMissing: true,
    }));
    expect(result).not.toHaveProperty('markerPath');
    await result.publishReady();
    await result.materializationCustody?.commit();
    await expect(readFile(join(fixture, 'escape', 'ready.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('rehydrates restart custody from settings intent and the canonical materialization receipt owner', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const targetA = join(fixture, 'target-a');
    const staging = join(fixture, 'staging');
    const first = await workspaceSyncTargetBootstrap(input({ rootPath: targetA, materializationDirectory: staging, createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace', materializeSeed: async () => {} }));
    await first.publishReady();
    await first.materializationCustody?.commit();
    await first.release();
    const exact = await rehydrateWorkspaceSyncTargetBootstrap({
      rootPath: targetA, relationshipId: 'relationship-1', endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta', policyDigest: 'a'.repeat(64), contentSelection: 'all_files',
      materializationDirectory: staging, rootOwnershipManager,
    });
    expect(exact).not.toBeNull();
    await exact?.release();
    await rm(fixture, { recursive: true, force: true });
  });

  it('rejects source/target overlap before seed materialization or marker writes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const source = join(fixture, 'workspace');
    const target = join(source, 'nested-target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing'), 'data');
    let seeded = false;
    await expect(workspaceSyncTargetBootstrap(input({
      rootPath: target, sourceRootPath: source, materializationDirectory: join(fixture, 'staging'),
      materializeSeed: async () => { seeded = true; },
    }))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
    expect(seeded).toBe(false);
    await rm(fixture, { recursive: true, force: true });
  });

  it('does not compare target-local paths with an absent remote source path', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-bootstrap-'));
    const target = join(fixture, 'workspace');
    const { sourceRootPath: _sourceRootPath, ...remoteSourceInput } = input({
      rootPath: target,
      materializationDirectory: join(fixture, 'staging'),
      createIfMissing: true,
    });
    void _sourceRootPath;
    const result = await workspaceSyncTargetBootstrap(remoteSourceInput);

    expect(result).toMatchObject({ created: true, state: 'READY' });
    await result.release();
    await rm(fixture, { recursive: true, force: true });
  });
});

function input(overrides: Partial<Parameters<typeof workspaceSyncTargetBootstrap>[0]> = {}) {
  return {
    rootPath: '/tmp/unused', sourceRootPath: `/tmp/workspace-sync-source-${process.pid}`, relationshipId: 'relationship-1', endpointRole: 'beta' as const,
    targetWorkspaceRefId: 'workspace-beta',
    policyDigest: 'a'.repeat(64), contentSelection: 'all_files' as const, approved: true as const, materializationDirectory: '/tmp/unused-staging',
    rootOwnershipManager,
    targetBootstrap: 'use_existing' as const,
    ...overrides,
  };
}
