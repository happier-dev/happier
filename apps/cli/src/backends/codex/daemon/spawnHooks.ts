import { validateCodexAcpSpawnAvailability } from '../acp/spawnAvailability';
import { resolveCodexAcpSpawn } from '../acp/resolveCommand';
import { resolveCanonicalCodexBackendMode } from './backendMode';
import { resolveCodexVendorResumeSupportParamsForSpawn } from './spawnCompat';
import {
    type DaemonSpawnHooks,
    type DaemonSpawnRuntimeSelection,
} from '../../../daemon/spawnHooks';

type CodexDaemonSpawnHooks = DaemonSpawnHooks & Readonly<{
  resolveVendorResumeSupportParams: (
    params: Parameters<typeof resolveCodexVendorResumeSupportParamsForSpawn>[0],
  ) => ReturnType<typeof resolveCodexVendorResumeSupportParamsForSpawn>;
}>;

function resolveCodexDaemonBackendMode(params: DaemonSpawnRuntimeSelection): 'mcp' | 'acp' | 'appServer' | null {
  return resolveCanonicalCodexBackendMode(params) ?? null;
}

export const codexDaemonSpawnHooks = {
  resolveRuntimePrerequisites: async (runtimeSelection) => {
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

  augmentEnv: (runtimeSelection) => ({
    ...(resolveCodexDaemonBackendMode(runtimeSelection) === 'acp' ? { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
  }),
  resolveVendorResumeSupportParams: (params) => resolveCodexVendorResumeSupportParamsForSpawn(params),
} satisfies CodexDaemonSpawnHooks;
