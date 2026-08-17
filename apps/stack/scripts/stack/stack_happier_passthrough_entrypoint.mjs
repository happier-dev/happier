import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { coerceHappyMonorepoRootFromPath } from '../utils/paths/paths.mjs';

export function resolveStackHappierPassthroughEntrypoint({ rootDir, env = process.env } = {}) {
  const launcherRoot = String(rootDir ?? '').trim();
  const repoRoot = coerceHappyMonorepoRootFromPath(env?.HAPPIER_STACK_REPO_DIR) || '';
  if (repoRoot) {
    const stackRoot = join(repoRoot, 'apps', 'stack');
    const stackWrapperEntrypoint = join(stackRoot, 'bin', 'happier.mjs');
    if (existsSync(stackWrapperEntrypoint)) {
      return {
        cwd: stackRoot,
        entrypoint: stackWrapperEntrypoint,
        source: 'stack-repo-wrapper',
      };
    }
  }

  return {
    cwd: launcherRoot,
    entrypoint: join(launcherRoot, 'scripts', 'happier.mjs'),
    source: 'launcher-script',
  };
}
