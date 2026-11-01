import { validateCodexAcpSpawnAvailability } from '@/backends/codex/acp/spawnAvailability';
import { resolveCodexAcpSpawn } from '@/backends/codex/acp/resolveCommand';
import { isExperimentalCodexAcpEnabled } from '@/backends/codex/experiments/codexExperiments';
import { resolveCodexBackendModeForRun } from '@/backends/codex/utils/resolveCodexBackendModeForRun';
import {
  CODEX_APP_SERVER_OVERRIDE_ENV_KEYS,
  resolveCodexOverrideCommand,
} from '@/backends/codex/utils/resolveCodexCliInvocation';
import {
  resolveDaemonSpawnRuntimeCodexBackendMode,
  type DaemonSpawnHooks,
  type DaemonSpawnRuntimeSelection,
  type DaemonSpawnValidationResult,
} from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';

function resolveCodexDaemonBackendMode(params: DaemonSpawnRuntimeSelection): 'mcp' | 'acp' | 'appServer' | null {
  return resolveDaemonSpawnRuntimeCodexBackendMode(params) ?? null;
}

/** Admits App Server and MCP launches only when the runner can resolve the command it will spawn. */
async function validateCodexCliSpawn(runtimeSelection: DaemonSpawnRuntimeSelection): Promise<DaemonSpawnValidationResult> {
  const processEnv = runtimeSelection.environmentVariables ?? process.env;
  const runMode = resolveCodexBackendModeForRun({
    codexBackendMode: resolveCodexDaemonBackendMode(runtimeSelection) ?? undefined,
    experimentalCodexAcp: runtimeSelection.experimentalCodexAcp,
    experimentalCodexAcpEnabledByDefault: isExperimentalCodexAcpEnabled(processEnv),
  });
  // ACP selected only by the runner's environment default keeps its runner-owned launch validation.
  if (runMode === 'acp') return { ok: true };
  if (
    runMode === 'appServer'
    && resolveCodexOverrideCommand(processEnv, CODEX_APP_SERVER_OVERRIDE_ENV_KEYS, runtimeSelection.directory ?? process.cwd())
  ) {
    return { ok: true };
  }
  return await validateProviderCliSpawn({ agentId: 'codex', processEnv });
}

export const codexDaemonSpawnHooks: DaemonSpawnHooks = {
  resolveTerminalPresentation: ({ host, runtimeSelection, processEnv }) => {
    const admitted = processEnv.HAPPIER_CODEX_BACKEND_MODE;
    const mode = resolveCodexBackendModeForRun({
      codexBackendMode: admitted === 'acp' || admitted === 'mcp' || admitted === 'appServer'
        ? admitted
        : resolveDaemonSpawnRuntimeCodexBackendMode(runtimeSelection),
      experimentalCodexAcp: runtimeSelection.experimentalCodexAcp,
      experimentalCodexAcpEnabledByDefault: false,
    });
    if (mode === 'acp') return { kind: 'none' };
    if (mode === 'appServer') return { kind: 'provider_attach', startingMode: 'local' };
    return host === 'tmux' ? { kind: 'runner', startingMode: 'remote' } : { kind: 'none' };
  },
  validateSpawn: async (runtimeSelection) => {
    if (resolveCodexDaemonBackendMode(runtimeSelection) !== 'acp') return await validateCodexCliSpawn(runtimeSelection);

    let resolved: { command: string; args: string[] };
    try {
      resolved = resolveCodexAcpSpawn({ env: runtimeSelection.environmentVariables });
    } catch (error) {
      return {
        ok: false,
        reasonCode: 'codex_acp_unavailable',
        errorMessage: error instanceof Error
          ? error.message
          : 'Codex ACP is enabled, but the command could not be resolved.',
      };
    }

    const availability = validateCodexAcpSpawnAvailability(resolved, { env: runtimeSelection.environmentVariables });
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
