import type { StartedDaemon } from '../../daemon/daemon';
import type { CliTestLaunchSpec } from '../../process/cliLaunchSpec';
import type { SpawnedProcess } from '../../process/spawnProcess';
import { spawnSessionFromDaemon } from '../../uiE2e/spawnSessionFromDaemon';
import type { ProviderProtocol } from '../types';

type SpawnFromDaemon = typeof spawnSessionFromDaemon;

const DAEMON_SESSION_ENVIRONMENT_OVERRIDE_KEYS = [
  'HAPPIER_STACK_TOOL_TRACE',
  'HAPPIER_STACK_TOOL_TRACE_DIR',
  'HAPPIER_STACK_TOOL_TRACE_FILE',
] as const;

export async function spawnProviderHarnessDirectProcessWithLaunchSpec(params: Readonly<{
  resolveLaunchSpec: () => Promise<CliTestLaunchSpec | null>;
  spawn: (launchSpec: CliTestLaunchSpec | null) => SpawnedProcess;
}>): Promise<SpawnedProcess> {
  const launchSpec = await params.resolveLaunchSpec();
  try {
    return params.spawn(launchSpec);
  } catch (error) {
    if (!launchSpec?.cleanup) throw error;
    try {
      await launchSpec.cleanup();
    } catch (cleanupError) {
      const primary = error instanceof Error ? error : new Error(String(error));
      const cleanupFailure = cleanupError instanceof Error
        ? cleanupError
        : new Error(String(cleanupError));
      throw new AggregateError(
        [primary, cleanupFailure],
        'Provider direct launch setup and source snapshot cleanup failed',
      );
    }
    throw error;
  }
}

function projectDaemonSessionEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    DAEMON_SESSION_ENVIRONMENT_OVERRIDE_KEYS.flatMap((key) => {
      const value = env[key];
      return typeof value === 'string' ? [[key, value]] : [];
    }),
  );
}

export async function launchProviderHarnessSession(params: Readonly<{
  providerId: string;
  agentId: string;
  providerProtocol: ProviderProtocol;
  launchViaDaemon?: boolean;
  daemon: StartedDaemon | null;
  directory: string;
  existingSessionId: string;
  resume?: string;
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  environmentVariables: NodeJS.ProcessEnv;
  spawnFromDaemon?: SpawnFromDaemon;
  spawnDirect: () => SpawnedProcess | Promise<SpawnedProcess>;
}>): Promise<Readonly<{ process: SpawnedProcess | null }>> {
  try {
    const launchViaDaemon = params.providerProtocol === 'acp' || params.launchViaDaemon === true;
    if (!launchViaDaemon) {
      return { process: await params.spawnDirect() };
    }

    if (!params.daemon) {
      throw new Error(
        params.providerProtocol === 'acp'
          ? `Provider harness requires a running daemon for native ACP Agent ${params.agentId} (${params.providerId})`
          : `Provider harness requires a running daemon for daemon-runner continuity Agent ${params.agentId} (${params.providerId})`,
      );
    }

    const spawnedSessionId = await (params.spawnFromDaemon ?? spawnSessionFromDaemon)({
      daemon: params.daemon,
      directory: params.directory,
      agent: params.agentId,
      request: {
        existingSessionId: params.existingSessionId,
        ...(params.resume ? { resume: params.resume } : {}),
        terminal: { mode: 'plain' },
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
        ...(params.permissionModeUpdatedAt !== undefined
          ? { permissionModeUpdatedAt: params.permissionModeUpdatedAt }
          : {}),
        ...(params.modelId ? { modelId: params.modelId } : {}),
        ...(params.modelUpdatedAt !== undefined ? { modelUpdatedAt: params.modelUpdatedAt } : {}),
        environmentVariables: projectDaemonSessionEnvironment(params.environmentVariables),
      },
    });

    if (spawnedSessionId !== params.existingSessionId) {
      throw new Error(
        `Provider daemon spawn expected existing session ${params.existingSessionId}, received ${spawnedSessionId}`,
      );
    }

    return { process: null };
  } catch (error) {
    if (!params.daemon) throw error;
    try {
      await params.daemon.stop();
    } catch (cleanupError) {
      const primary = error instanceof Error ? error : new Error(String(error));
      const cleanupFailure = cleanupError instanceof Error
        ? cleanupError
        : new Error(String(cleanupError));
      throw new AggregateError(
        [primary, cleanupFailure],
        'Provider harness launch and daemon cleanup failed',
      );
    }
    throw error;
  }
}
