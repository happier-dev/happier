import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import { findAnyCredentialPathInCliHome } from './credentials_paths.mjs';

export function stackHasAccessKey(stackName) {
  try {
    const { baseDir, envPath } = resolveStackEnvPath(stackName);
    if (!existsSync(envPath)) return false;
    return Boolean(findAnyCredentialPathInCliHome({ cliHomeDir: join(baseDir, 'cli') }));
  } catch {
    return false;
  }
}

/**
 * Seed sources that are safe to reuse locally.
 *
 * Note: deliberately does NOT include legacy ~/.happy sources; in many contexts we cannot reliably
 * seed DB Account rows, which leads to broken stacks.
 */
export function detectSeedableAuthSources() {
  const out = [];
  if (stackHasAccessKey('dev-auth')) out.push('dev-auth');
  if (stackHasAccessKey('main')) out.push('main');
  return out;
}
