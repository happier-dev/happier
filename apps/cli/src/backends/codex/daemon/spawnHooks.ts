import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { delimiter as pathDelimiter, join } from 'node:path';

import tmp from 'tmp';

import { getCodexAcpDepStatus } from '@/capabilities/deps/codexAcp';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';

function readCodexAcpNpxMode(): 'auto' | 'never' | 'force' {
  const raw = typeof process.env.HAPPIER_CODEX_ACP_NPX_MODE === 'string'
    ? process.env.HAPPIER_CODEX_ACP_NPX_MODE.trim().toLowerCase()
    : '';
  if (raw === 'never' || raw === 'force' || raw === 'auto') return raw;
  return 'auto';
}

function isBinOnPath(baseName: string): boolean {
  const path = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  if (!path) return false;
  const candidates =
    process.platform === 'win32'
      ? [`${baseName}.cmd`, `${baseName}.exe`, baseName]
      : [baseName];
  for (const dir of path.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of candidates) {
      try {
        if (existsSync(join(trimmed, name))) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
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
      await fs.writeFile(join(codexHomeDir.name, 'auth.json'), token);
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

  validateSpawn: async ({ experimentalCodexResume, experimentalCodexAcp }) => {
    if (experimentalCodexAcp !== true) return { ok: true };

    if (experimentalCodexResume === true) {
      return {
        ok: false,
        errorMessage: 'Invalid spawn options: Codex ACP and Codex resume MCP cannot both be enabled.',
      };
    }

    const envOverride = typeof process.env.HAPPIER_CODEX_ACP_BIN === 'string' ? process.env.HAPPIER_CODEX_ACP_BIN.trim() : '';
    if (envOverride) {
      if (!existsSync(envOverride)) {
        return {
          ok: false,
          errorMessage: `Codex ACP is enabled, but HAPPIER_CODEX_ACP_BIN does not exist: ${envOverride}`,
        };
      }
      return { ok: true };
    }

    const status = await getCodexAcpDepStatus({ onlyIfInstalled: true });
    if (!status.installed || !status.binPath) {
      const npxMode = readCodexAcpNpxMode();

      const hasCodexAcp = isBinOnPath('codex-acp');
      if (hasCodexAcp) return { ok: true };

      if (npxMode === 'never') {
        return {
          ok: false,
          errorMessage:
            'Codex ACP is enabled, but codex-acp is not installed (and npx fallback is disabled). Install codex-acp from the Happier app (Machine details → Codex ACP), add codex-acp to PATH, or disable the experiment.',
        };
      }

      const hasNpx = isBinOnPath('npx');
      if (hasNpx) return { ok: true };

      return {
        ok: false,
        errorMessage:
          'Codex ACP is enabled, but codex-acp is not installed and npx is not available. Install codex-acp from the Happier app (Machine details → Codex ACP), install Node.js/npm (for npx), or disable the experiment.',
      };
    }

    return { ok: true };
  },

  buildExtraEnvForChild: ({ experimentalCodexResume, experimentalCodexAcp }) => ({
    ...(experimentalCodexResume === true ? { HAPPIER_EXPERIMENTAL_CODEX_RESUME: '1' } : {}),
    ...(experimentalCodexAcp === true ? { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
  }),
};
