import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { commandExistsInPath } from '@/daemon/service/commandExistsInPath';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  buildAuthEnv: async ({ token }) => ({
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    cleanupOnFailure: null,
    cleanupOnExit: null,
  }),
  validateSpawn: async () => {
    const isWindows = process.platform === 'win32';
    const accessMode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;

    const override = typeof process.env.HAPPIER_CLAUDE_PATH === 'string' ? process.env.HAPPIER_CLAUDE_PATH.trim() : '';
    if (override) {
      try {
        await access(override, accessMode);
        return { ok: true };
      } catch {
        // fall back to PATH lookup
      }
    }

    const ok = commandExistsInPath({
      cmd: 'claude',
      envPath: process.env.PATH,
      platform: process.platform,
      pathext: process.env.PATHEXT,
    });
    if (ok) return { ok: true };

    return {
      ok: false,
      errorMessage:
        'Claude CLI (claude) is not available on the daemon PATH. ' +
        'Install claude or set HAPPIER_CLAUDE_PATH, then restart the daemon.',
    };
  },
};
