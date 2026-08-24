import type { StartedDaemon } from '../daemon/daemon';
import { daemonControlPostJson } from '../daemon/controlServerClient';

type SpawnSessionSuccessResponse = Readonly<{
  success: true;
  sessionId: string;
}>;

function isSpawnSessionSuccessResponse(value: unknown): value is SpawnSessionSuccessResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === true &&
    'sessionId' in value &&
    typeof value.sessionId === 'string'
  );
}

export async function spawnSessionFromDaemon(params: Readonly<{
  daemon: StartedDaemon;
  directory: string;
  agent?: string;
}>): Promise<string> {
  const token = params.daemon.state.controlToken;
  if (!token) throw new Error('daemon control token missing');

  const response = await daemonControlPostJson<unknown>({
    port: params.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: token,
    body: {
      directory: params.directory,
      ...(params.agent
        ? { backendTarget: { kind: 'builtInAgent', agentId: params.agent } }
        : {}),
    },
  });
  if (response.status < 200 || response.status >= 300 || !isSpawnSessionSuccessResponse(response.data)) {
    throw new Error(`Failed to spawn session (status=${response.status}): ${JSON.stringify(response.data)}`);
  }
  return response.data.sessionId;
}
