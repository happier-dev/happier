import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import tmp from 'tmp';

import { validateCodexAcpSpawnAvailability } from '@/backends/codex/acp/spawnAvailability';
import { resolveCodexAcpSpawn } from '@/backends/codex/acp/resolveCommand';
import {
  resolveDaemonSpawnRuntimeCodexBackendMode,
  type DaemonSpawnHooks,
  type DaemonSpawnRuntimeSelection,
} from '@/daemon/spawnHooks';

function resolveCodexDaemonBackendMode(params: DaemonSpawnRuntimeSelection): 'mcp' | 'acp' | 'appServer' | null {
  return resolveDaemonSpawnRuntimeCodexBackendMode(params) ?? null;
}

export const codexDaemonSpawnHooks: DaemonSpawnHooks = {
  buildAuthEnv: async ({ token }) => {
    const codexHomeDir = tmp.dirSync();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        codexHomeDir.removeCallback();
      } catch {
        // best-effort
      }
    };

    try {
      // Seed the temporary CODEX_HOME with the user's existing Codex configuration so the
      // subprocess keeps MCP servers and other preferences when using token auth.
      //
      // Best-effort: the auth.json write is the only required step; a missing/unreadable
      // config.toml should not prevent spawn.
      const sourceCodexHomeRaw = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : '';
      const sourceCodexHome = sourceCodexHomeRaw.length > 0 ? sourceCodexHomeRaw : join(homedir(), '.codex');
      const sourceConfigPath = join(sourceCodexHome, 'config.toml');
      let seededConfigCopied = false;
      if (existsSync(sourceConfigPath)) {
        try {
          const destPath = join(codexHomeDir.name, 'config.toml');
          await fs.copyFile(sourceConfigPath, destPath);
          seededConfigCopied = true;
          if (process.platform !== 'win32') {
            try {
              await fs.chmod(destPath, 0o600);
            } catch {
              // best-effort
            }
          }
        } catch {
          // best-effort: seeding should not prevent token-based spawn.
        }
      }

      const authPath = join(codexHomeDir.name, 'auth.json');
      await fs.writeFile(authPath, token, process.platform === 'win32' ? undefined : { mode: 0o600 });
      if (process.platform !== 'win32') {
        try {
          await fs.chmod(authPath, 0o600);
        } catch {
          // best-effort
        }
      }
    } catch (error) {
      cleanup();
      throw error;
    }

    return {
      env: { CODEX_HOME: codexHomeDir.name },
      cleanupOnFailure: cleanup,
      cleanupOnExit: cleanup,
    };
  },

  validateSpawn: async (runtimeSelection) => {
    if (resolveCodexDaemonBackendMode(runtimeSelection) !== 'acp') return { ok: true };

    let resolved: { command: string; args: string[] };
    try {
      resolved = resolveCodexAcpSpawn();
    } catch (error) {
      return {
        ok: false,
        reasonCode: 'codex_acp_unavailable',
        errorMessage: error instanceof Error
          ? error.message
          : 'Codex ACP is enabled, but the command could not be resolved.',
      };
    }

    const availability = validateCodexAcpSpawnAvailability(resolved);
    if (availability.ok) return { ok: true };

    if (resolved.command === 'codex-acp') {
      return {
        ok: false,
        reasonCode: 'codex_acp_unavailable',
        errorMessage:
          'Codex ACP is enabled, but codex-acp could not be resolved. Install codex-acp from the Happier app (Machine details → Installables), add codex-acp to PATH, or disable the experiment.',
      };
    }

    return {
      ok: false,
      reasonCode: 'codex_acp_unavailable',
      errorMessage: `Codex ACP is enabled, but ${availability.errorMessage.toLowerCase()}`,
    };
  },

  buildExtraEnvForChild: (runtimeSelection) => ({
    ...(resolveCodexDaemonBackendMode(runtimeSelection) === 'acp' ? { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
  }),
};
