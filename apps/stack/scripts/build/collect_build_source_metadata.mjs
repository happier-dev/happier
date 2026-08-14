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

export function assertBuildSourceMetadataStable({ before, after }) {
  const beforeFingerprint = String(before?.sourceFingerprint ?? '').trim();
  const afterFingerprint = String(after?.sourceFingerprint ?? '').trim();
  if (beforeFingerprint && beforeFingerprint === afterFingerprint) return;

  const error = new Error(
    '[build] source changed while runtime artifacts were being built; the candidate was not published. Retry against the current checkout.',
  );
  error.code = 'HAPPIER_RUNTIME_BUILD_SOURCE_CHANGED';
  throw error;
}

async function readGitHead(repoDir) {
  try {
    return (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).trim();
  } catch {
    return 'nogit';
  }
}

async function readGitDirtyHash(repoDir) {
  try {
    const trackedDiff = await runCapture('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], { cwd: repoDir });
    const untrackedRaw = await runCapture('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoDir });
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

export async function collectBuildSourceMetadata({ rootDir, env = process.env }) {
  const repoDir = getRepoDir(rootDir, env);
  const serverComponent = parseServerComponentFromEnv(env);
  const dbProvider = resolveDbProvider(env, serverComponent);
  const commitSha = await readGitHead(repoDir);
  const dirtyHash = await readGitDirtyHash(repoDir);
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
