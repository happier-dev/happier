import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { materializeLocalWorkspaceSyncSeed, resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createManagedSessionDirectories } from './managedSessionDirectories';
import { SessionCreationCorrespondenceConflictError } from '@/api/session/sessionCreationCorrespondenceConflictError';

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
  // Fresh admission may be retried before bind; a bound target is never reseeded.
  const custody = await materializeLocalWorkspaceSyncSeed({ operationId: target.allocationId,
    activeServerDir: input.activeServerDir, sourcePath: source.directory, targetPath: target.directory,
    workspaceTransfer: resolveWorkspaceSyncSeedTransfer({ selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] }),
    prepareEntryAccess: await owner.prepareSeedEntryAccess(target.allocationId),
  });
  try {
    await custody.bindPromotedTarget();
    // Promotion replaces the directory object; restore its protected permissions/ACL.
    await owner.materializeForFreshSpawn({ sessionCreationTag: input.sessionCreationTag });
    await custody.commit();
  } catch (error) { await custody.abort(); throw error; }
  return { ok: true };
}
