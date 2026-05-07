import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function createSourceOffer(input: Readonly<{
  digest: string;
  sizeBytes: number;
  relativePath: string;
  sourceControllerMetadata?: Readonly<Record<string, unknown>>;
}>){
  return {
    offerId: 'offer_123',
    relationshipId: 'rel_123',
    directionId: 'dir_123',
    sourceFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    manifest: {
      entries: [
        {
          relativePath: input.relativePath,
          kind: 'file' as const,
          digest: input.digest,
          sizeBytes: input.sizeBytes,
          executable: false,
        },
      ],
      fingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    blobIndex: [
      {
        digest: input.digest,
        sizeBytes: input.sizeBytes,
      },
    ],
    ...(input.sourceControllerMetadata ? { sourceControllerMetadata: input.sourceControllerMetadata } : {}),
  };
}

async function withIsolatedProcessHome<T>(
  prefix: string,
  run: (homeDir: string) => Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    return await run(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('applyWorkspaceReplicationPlan', () => {
  it('materializes a transfer snapshot from a CAS-backed source offer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-active-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-target-'));
    const sourceFilePath = join(activeServerDir, 'README.md');
    const payload = Buffer.from('hello snapshot\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { applyWorkspaceReplicationPlan } = await import('./applyWorkspaceReplicationPlan');

      await writeFile(sourceFilePath, payload);
      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await casStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      const result = await applyWorkspaceReplicationPlan({
        activeServerDir,
        targetPath: targetRoot,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        sourceOffer: createSourceOffer({
          digest,
          sizeBytes: payload.byteLength,
          relativePath: 'README.md',
          sourceControllerMetadata: {
            nestedRepositories: [],
            supportsSafeReplace: true,
          },
        }),
      });

      expect(result).toEqual({ targetPath: targetRoot });
      await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('hello snapshot\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it('applies sync_changes from a CAS-backed source offer using the provided current target manifest', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-active-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-sync-target-'));
    const sourceFilePath = join(activeServerDir, 'README.md');
    const payload = Buffer.from('new readme\n', 'utf8');
    const digest = createSha256Digest(payload);
    const currentTargetManifest: WorkspaceManifest = {
      entries: [
        {
          relativePath: 'README.md',
          kind: 'file',
          digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sizeBytes: 11,
          executable: false,
        },
        {
          relativePath: 'old.txt',
          kind: 'file',
          digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sizeBytes: 4,
          executable: false,
        },
      ],
    };

    try {
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { applyWorkspaceReplicationPlan } = await import('./applyWorkspaceReplicationPlan');

      await writeFile(join(targetRoot, 'README.md'), 'old readme\n', 'utf8');
      await writeFile(join(targetRoot, 'old.txt'), 'old\n', 'utf8');
      await writeFile(sourceFilePath, payload);
      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await casStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      const result = await applyWorkspaceReplicationPlan({
        activeServerDir,
        targetPath: targetRoot,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        currentTargetManifest,
        sourceOffer: {
          ...createSourceOffer({
            digest,
            sizeBytes: payload.byteLength,
            relativePath: 'README.md',
          }),
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest,
                sizeBytes: payload.byteLength,
                executable: false,
              },
              {
                relativePath: 'docs',
                kind: 'directory',
              },
            ],
          },
          blobIndex: [
            {
              digest,
              sizeBytes: payload.byteLength,
            },
          ],
        },
      });

      expect(result).toEqual({ targetPath: targetRoot });
      await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('new readme\n');
      await expect(readFile(join(targetRoot, 'old.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const docsStats = await lstat(join(targetRoot, 'docs'));
      expect(docsStats.isDirectory()).toBe(true);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it('rejects sync_changes when currentTargetManifest is missing (no silent empty-manifest default)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-missing-target-manifest-active-'));
    const targetRoot = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-missing-target-manifest-target-'));
    const sourceFilePath = join(activeServerDir, 'README.md');
    const payload = Buffer.from('new readme\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { applyWorkspaceReplicationPlan } = await import('./applyWorkspaceReplicationPlan');

      await writeFile(sourceFilePath, payload);
      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await casStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      await expect(applyWorkspaceReplicationPlan({
        activeServerDir,
        targetPath: targetRoot,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        sourceOffer: createSourceOffer({
          digest,
          sizeBytes: payload.byteLength,
          relativePath: 'README.md',
        }),
      })).rejects.toThrow(/currentTargetManifest/i);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a writable local path when sync_changes targets an uncreatable parent tree', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-active-'));
    const root = await mkdtemp(join(tmpdir(), 'happier-replication-apply-plan-uncreatable-'));
    const lockedRoot = join(root, 'locked-root');
    const requestedTarget = join(lockedRoot, 'foreign', 'repo');
    const sourceFilePath = join(activeServerDir, 'README.md');
    const payload = Buffer.from('hello fallback\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { applyWorkspaceReplicationPlan } = await import('./applyWorkspaceReplicationPlan');

      await mkdir(lockedRoot, { recursive: true });
      await writeFile(sourceFilePath, payload);
      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      await casStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      await withIsolatedProcessHome('happier-replication-apply-plan-home-', async (homeDir) => {
        await chmod(lockedRoot, 0o555);
        try {
          const result = await applyWorkspaceReplicationPlan({
            activeServerDir,
            targetPath: requestedTarget,
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
            currentTargetManifest: { entries: [] },
            sourceOffer: createSourceOffer({
              digest,
              sizeBytes: payload.byteLength,
              relativePath: 'README.md',
            }),
          });

          expect(result.targetPath).toBe(join(homeDir, 'repo'));
          expect(result.targetPath).not.toBe(requestedTarget);
          expect(result.targetPath.startsWith(lockedRoot)).toBe(false);
          await expect(readFile(join(result.targetPath, 'README.md'), 'utf8')).resolves.toBe('hello fallback\n');
          await expect(access(requestedTarget, constants.F_OK)).rejects.toThrow();
        } finally {
          await chmod(lockedRoot, 0o755);
        }
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
