import { resolveKimiSessionRuntimePreferences } from '../preferences/session.js';
import { resolveKimiDaemonSpawnPrerequisites } from '../lifecycle/spawnHooks.js';

async function resolveKimiCatalogDaemonSpawnPrerequisites(
  params: Parameters<typeof resolveKimiDaemonSpawnPrerequisites>[0] & Parameters<typeof resolveKimiDaemonSpawnPrerequisites>[1],
) {
  const result = await resolveKimiDaemonSpawnPrerequisites(params, { tools: params.tools });
  return result.allowed
    ? { ok: true as const }
    : {
      ok: false as const,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      errorMessage: result.errorMessage ?? 'Kimi ACP runtime is unavailable.',
    };
}

export const KIMI_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'kimi',
  builtInAcpCatalog: true,
  daemonSpawnHooks: {
    resolveRuntimePrerequisites: resolveKimiCatalogDaemonSpawnPrerequisites,
  },
  sessionRuntimePreferences: {
    resolve: resolveKimiSessionRuntimePreferences,
  },
} as const);
