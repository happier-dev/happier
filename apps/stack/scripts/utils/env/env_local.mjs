import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ensureEnvFileMutated } from './env_file.mjs';
import { getHomeEnvLocalPath, getHomeEnvPath, resolveUserConfigEnvPath } from './config.mjs';

export async function ensureEnvLocalUpdated({ rootDir, updates, removeKeys = [] }) {
  // Behavior:
  // - If a stack env file is explicitly set, write there (stack-scoped).
  // - If the user has run `hstack init` (home config exists), write to the main stack env file (user config).
  // - If no home config exists (legacy cloned-repo usage), write to <repo>/env.local for repo-local behavior.
  const explicit = (process.env.HAPPIER_STACK_ENV_FILE ?? '').trim();
  if (explicit) {
    await ensureEnvFileMutated({ envPath: explicit, updates, removeKeys });
    return;
  }

  const hasHomeConfig = existsSync(getHomeEnvPath()) || existsSync(getHomeEnvLocalPath());
  if (hasHomeConfig) {
    await ensureEnvFileMutated({ envPath: resolveUserConfigEnvPath({ cliRootDir: rootDir }), updates, removeKeys });
    return;
  }

  await ensureEnvFileMutated({ envPath: join(rootDir, 'env.local'), updates, removeKeys });
}
