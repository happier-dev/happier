import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from '../proc/proc.mjs';
import { DEV_TARGET_MUTAGEN_IGNORE_PATHS } from './mutagen_ignore_paths.mjs';

// Mutagen uses Git-style ignore semantics (mutagen_project.test.mjs). An empty
// temporary Git directory enumerates authored source and partial replicas alike;
// it neither reads nor changes the source checkout's real index. Omitting
// --exclude-standard keeps authored Git-ignored inputs that Mutagen sends.
// This measures source file bytes only, not dependencies or a future job peak.
export async function measureReplicaSourceBytes(sourceDir, env = process.env) {
  const temporary = await mkdtemp(join(tmpdir(), 'hstack-replica-source-'));
  try {
    const ignores = join(temporary, 'ignores');
    await writeFile(ignores, [...DEV_TARGET_MUTAGEN_IGNORE_PATHS, '.git', '.hg', '.svn'].join('\n') + '\n');
    const gitDir = join(temporary, 'repo.git');
    await runCapture('git', ['init', '--bare', '--quiet', gitDir], { env });
    const paths = await runCapture('git', [`--git-dir=${gitDir}`, `--work-tree=${sourceDir}`, '-c', 'core.fsmonitor=false', 'ls-files', '--others', '-z', `--exclude-from=${ignores}`], {
      cwd: sourceDir, env: { ...env, GIT_INDEX_FILE: join(temporary, 'empty-index') },
    });
    let bytes = 0;
    for (const path of paths.split('\0').filter(Boolean)) {
      const info = await lstat(join(sourceDir, path)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      // Mutagen copies each source pathname; source-side hardlinks do not
      // make a new destination pathname resident. Symlinks are not followed.
      if (info?.isFile()) bytes += info.size;
    }
    if (!Number.isSafeInteger(bytes)) throw new Error('replica source byte measurement exceeds the supported integer range');
    return bytes;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
