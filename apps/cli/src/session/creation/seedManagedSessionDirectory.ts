import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { materializeLocalWorkspaceSyncSeed, resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createManagedSessionDirectories } from './managedSessionDirectories';
import { SessionCreationCorrespondenceConflictError } from '@/api/session/sessionCreationCorrespondenceConflictError';
import { basename, dirname, join } from 'node:path';
import { withPinnedUnixDirectory, type PinnedUnixDirectoryAccess } from '@/utils/fs/unixPathAccess';

/** Called only after fresh admission and before launching the child's Agent. */
export async function seedManagedSessionDirectory(input: Readonly<{
  activeServerDir: string;
  sessionCreationTag: string;
  targetPath: string;
  seed: NonNullable<SpawnSessionOptions['managedDirectorySeed']>;
}>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: 'SESSION_DIRECTORY_MISSING' }>> {
  const owner = createManagedSessionDirectories({ activeServerDir: input.activeServerDir });
  const source = await owner.resolveForSession({ sessionId: input.seed.sourceSessionId,
    sessionCreationTag: input.seed.sourceSessionCreationTag, path: input.seed.sourcePath,
  });
  if (!source.ok) return source;
  const target = await owner.materializeForFreshSpawn({ sessionCreationTag: input.sessionCreationTag });
  if (!canonicalAbsolutePathsEqual(target.directory, input.targetPath)) {
    throw new SessionCreationCorrespondenceConflictError();
  }
  const prepareEntryAccess = await owner.prepareSeedEntryAccess(target.allocationId);
  const materialize = async (pinnedTargetParent?: PinnedUnixDirectoryAccess) => {
    // Keep the accepted parent pinned through staging, promotion and custody
    // settlement. No descriptor path or capability escapes this operation.
    const custody = await materializeLocalWorkspaceSyncSeed({ operationId: target.allocationId,
      activeServerDir: input.activeServerDir, sourcePath: source.directory,
      targetPath: pinnedTargetParent ? join(pinnedTargetParent.path, basename(target.directory)) : target.directory,
      pinnedTargetParent,
      workspaceTransfer: resolveWorkspaceSyncSeedTransfer({ selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] }),
      prepareEntryAccess,
    });
    try {
      await custody.bindPromotedTarget();
      // Promotion replaces the directory object; restore its protected permissions/ACL.
      await owner.materializeForFreshSpawn({ sessionCreationTag: input.sessionCreationTag });
      await custody.commit();
    } catch (error) { await custody.abort(); throw error; }
  };
  if (prepareEntryAccess && process.platform === 'linux') {
    await withPinnedUnixDirectory(dirname(target.directory), materialize);
  } else await materialize();
  return { ok: true };
}
