import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseServerComponentFromEnv } from '../stack/stack_environment.mjs';
import { getRepoDir } from '../utils/paths/paths.mjs';
import { runCapture } from '../utils/proc/proc.mjs';
import { createRuntimeFingerprint } from '../runtime/shared/runtime_fingerprint.mjs';
import { applyEffectiveDbProviderEnv } from '../utils/server/effective_db_provider.mjs';

function resolveDbProvider(env, serverComponent) {
  return applyEffectiveDbProviderEnv({
    serverComponentName: serverComponent,
    env,
    targetEnv: { ...env },
  });
}

const BUILD_METADATA_GIT_CONFIG_ARGS = ['-c', 'core.fsmonitor=false'];

async function runBuildMetadataGit(repoDir, args, runCaptureImpl) {
  return await runCaptureImpl(
    'git',
    [...BUILD_METADATA_GIT_CONFIG_ARGS, ...args],
    { cwd: repoDir },
  );
}

async function readGitHead(repoDir, runCaptureImpl) {
  try {
    return (await runBuildMetadataGit(repoDir, ['rev-parse', 'HEAD'], runCaptureImpl)).trim();
  } catch {
    return 'nogit';
  }
}

async function readGitDirtyHash(repoDir, runCaptureImpl) {
  try {
    const trackedDiff = await runBuildMetadataGit(
      repoDir,
      ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
      runCaptureImpl,
    );
    const untrackedRaw = await runBuildMetadataGit(
      repoDir,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      runCaptureImpl,
    );
    const untrackedPaths = untrackedRaw.split('\0').map((value) => value.trim()).filter(Boolean);
    if (!trackedDiff.trim() && untrackedPaths.length === 0) return 'clean';

    const hash = createHash('sha256');
    hash.update(trackedDiff);
    for (const relativePath of untrackedPaths.sort()) {
      const absolutePath = join(repoDir, relativePath);
      const info = await stat(absolutePath).catch(() => null);
      hash.update(`untracked:${relativePath}\n`);
      if (!info?.isFile()) {
        hash.update('missing-or-non-file\n');
        continue;
      }
      hash.update(await readFile(absolutePath));
      hash.update('\n');
    }
    return hash.digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

export async function collectBuildSourceMetadata({ rootDir, env = process.env, runCaptureImpl = runCapture }) {
  const repoDir = getRepoDir(rootDir, env);
  const serverComponent = parseServerComponentFromEnv(env);
  const dbProvider = resolveDbProvider(env, serverComponent);
  const commitSha = await readGitHead(repoDir, runCaptureImpl);
  const dirtyHash = await readGitDirtyHash(repoDir, runCaptureImpl);
  const sourceFingerprint = createRuntimeFingerprint({
    repoDir,
    commitSha,
    dirtyHash,
    serverComponent,
    dbProvider,
    components: ['web', 'server', 'daemon'],
  });

  return {
    repoDir,
    serverComponent,
    dbProvider,
    commitSha,
    dirtyHash,
    sourceFingerprint,
    builtAt: new Date().toISOString(),
  };
}
