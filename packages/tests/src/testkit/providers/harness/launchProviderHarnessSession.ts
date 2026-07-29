import type { StartedDaemon } from '../../daemon/daemon';
import type { SpawnedProcess } from '../../process/spawnProcess';
import { spawnSessionFromDaemon } from '../../uiE2e/spawnSessionFromDaemon';
import type { ProviderProtocol } from '../types';

type SpawnFromDaemon = typeof spawnSessionFromDaemon;

function projectDaemonSessionEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => {
      if (key === 'HAPPIER_SESSION_ATTACH_FILE') return [];
      return typeof value === 'string' ? [[key, value]] : [];
    }),
  );
}

export async function launchProviderHarnessSession(params: Readonly<{
  providerId: string;
  agentId: string;
  providerProtocol: ProviderProtocol;
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
  if (params.providerProtocol !== 'acp') {
    return { process: await params.spawnDirect() };
  }

  if (!params.daemon) {
    throw new Error(
      `Provider harness requires a running daemon for native ACP Agent ${params.agentId} (${params.providerId})`,
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
}
