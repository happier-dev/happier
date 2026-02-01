import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ensureEnvFileUpdated } from './env_file.mjs';
import { ensureUserConfigEnvUpdated, getHomeEnvLocalPath, getHomeEnvPath } from './config.mjs';

export async function ensureEnvLocalUpdated({ rootDir, updates }) {
  // Behavior:
  // - If a stack env file is explicitly set, write there (stack-scoped).
  // - If the user has run `hstack init` (home config exists), write to the main stack env file (user config).
  // - If no home config exists (legacy cloned-repo usage), write to <repo>/env.local for repo-local behavior.
  const explicit = (process.env.HAPPIER_STACK_ENV_FILE ?? '').trim();
  if (explicit) {
    await ensureEnvFileUpdated({ envPath: explicit, updates });
    return;
  }

  const hasHomeConfig = existsSync(getHomeEnvPath()) || existsSync(getHomeEnvLocalPath());
  if (hasHomeConfig) {
    await ensureUserConfigEnvUpdated({ cliRootDir: rootDir, updates });
    return;
  }

  await ensureEnvFileUpdated({ envPath: join(rootDir, 'env.local'), updates });
}
