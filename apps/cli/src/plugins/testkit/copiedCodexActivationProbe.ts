import { writeFile } from 'node:fs/promises';

import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { prepareRunnerAgentSessionBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import {
  createPluginReloadController,
  type PluginReloadController,
  type PluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/controller';

const CODEX_PLUGIN_ID = 'happier.agent.codex';
const CODEX_PREREQUISITE_HOOK_ID = 'agent.resolvePrerequisites';
const CODEX_PREREQUISITE_HOOK_LOCAL_ID = 'resolve-prerequisites';

type ProbeFailure = Readonly<{
  name: string;
  message: string;
  stack?: string;
}>;

function serializeFailure(error: unknown): ProbeFailure {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    name: 'NonErrorFailure',
    message: String(error),
  };
}

function readActivationDiagnostics(controller: PluginReloadController) {
  const state = controller.getState();
  const registry = state.activeRegistry;
  return {
    reloadDiagnostics: state.lastResult?.diagnostics ?? [],
    codexDiagnostics:
      state.lastResult?.diagnosticsByPluginId[CODEX_PLUGIN_ID]
      ?? registry?.pluginDiagnosticsByPluginId[CODEX_PLUGIN_ID]
      ?? [],
    activatedPluginIds: registry ? [...registry.activatedPluginIds].sort() : [],
    registeredCodexPrerequisiteHooks:
      registry?.hookHandlersByHookId
        .get(CODEX_PREREQUISITE_HOOK_ID)
        ?.filter((handler) => handler.pluginId === CODEX_PLUGIN_ID)
        .map((handler) => ({
          pluginId: handler.pluginId,
          localId: handler.localId,
        }))
        ?? [],
  };
}

async function main(): Promise<void> {
  const outputPath = process.env.HAPPIER_CODEX_ACTIVATION_PROBE_OUTPUT_PATH?.trim();
  const happyHomeDir = process.env.HAPPIER_HOME_DIR?.trim();
  if (!outputPath || !happyHomeDir) {
    throw new Error(
      'Copied Codex activation probe requires HAPPIER_CODEX_ACTIVATION_PROBE_OUTPUT_PATH and HAPPIER_HOME_DIR',
    );
  }

  const controller = createPluginReloadController({ happyHomeDir });
  let lease: PluginRuntimeRegistryLease | null = null;
  let report: Record<string, unknown> = {
    ok: false,
    failure: {
      name: 'ProbeIncomplete',
      message: 'Copied Codex activation probe did not reach a terminal result',
    },
  };
  const logs: Array<Readonly<{ level: 'debug' | 'info' | 'warn'; message: string }>> = [];

  try {
    lease = await controller.acquireRuntimeRegistry();
    const registryAccepted =
      lease.source === 'active'
      && controller.isRuntimeRegistryCurrent(lease.registry);
    if (!registryAccepted) {
      throw new Error('Copied source probe did not acquire the accepted active plugin runtime registry');
    }

    const activatedBeforeDispatch = lease.registry.activatedPluginIds.has(CODEX_PLUGIN_ID);
    const runnerBootstrap = await prepareRunnerAgentSessionBootstrapForLease({
      target: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      lease,
    });
    const spawnResult = await resolveSpawnChildEnvironment({
      happyHomeDir,
      pluginRuntimeRegistry: lease.registry,
      options: {
        directory: '/copied-source-codex-probe',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        codexBackendMode: 'appServer',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: { HAPPIER_CODEX_PATH: process.execPath },
      logDebug: (message) => logs.push({ level: 'debug', message }),
      logInfo: (message) => logs.push({ level: 'info', message }),
      logWarn: (message) => logs.push({ level: 'warn', message }),
      connectedServiceAuth: null,
    });

    const registeredCodexPrerequisiteHooks = lease.registry.hookHandlersByHookId
      .get(CODEX_PREREQUISITE_HOOK_ID)
      ?.filter((handler) => (
        handler.pluginId === CODEX_PLUGIN_ID
        && handler.localId === CODEX_PREREQUISITE_HOOK_LOCAL_ID
      ))
      .map((handler) => ({
        pluginId: handler.pluginId,
        localId: handler.localId,
      }))
      ?? [];

    report = {
      ok: true,
      registryAccepted,
      activatedBeforeDispatch,
      activatedAfterDispatch: lease.registry.activatedPluginIds.has(CODEX_PLUGIN_ID),
      runnerBootstrapPrepared: runnerBootstrap !== null,
      registeredCodexPrerequisiteHooks,
      spawnResult: spawnResult.ok
        ? {
          ok: true,
          codexBackendMode: spawnResult.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE ?? null,
        }
        : {
          ok: false,
          errorCode: spawnResult.errorCode,
          errorMessage: spawnResult.errorMessage,
        },
      diagnostics: readActivationDiagnostics(controller),
      logs,
    };
  } catch (error) {
    report = {
      ok: false,
      failure: serializeFailure(error),
      diagnostics: readActivationDiagnostics(controller),
      logs,
    };
    process.exitCode = 1;
  } finally {
    const cleanupFailures: ProbeFailure[] = [];
    try {
      await lease?.release();
    } catch (error) {
      cleanupFailures.push(serializeFailure(error));
    }
    try {
      await controller.shutdown();
    } catch (error) {
      cleanupFailures.push(serializeFailure(error));
    }
    if (cleanupFailures.length > 0) {
      report = {
        ...report,
        ok: false,
        cleanupFailures,
      };
      process.exitCode = 1;
    }
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

await main();
