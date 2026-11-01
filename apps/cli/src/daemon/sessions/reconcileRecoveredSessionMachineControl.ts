import { SessionWorkspaceLocationV1Schema } from '@happier-dev/protocol';

import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

/** Called only for runners adopted through the daemon's local process/marker proof. */
export async function reconcileRecoveredSessionMachineControl(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  machineId: string;
  runnerPid: number;
}>): Promise<void> {
  await ensureSessionMachineAccessKeyBinding({
    serverUrl: configuration.apiServerUrl,
    token: params.credentials.token,
    sessionId: params.sessionId,
    machineId: params.machineId,
  });
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) throw new Error('Recovered session not found while reconciling machine control');

  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (metadata) => {
      // Adoption proves local custody, but a handoff may already have published another runner.
      if (metadata.hostPid !== params.runnerPid || metadata.machineId === params.machineId) return metadata;
      const location = SessionWorkspaceLocationV1Schema.safeParse(metadata.sessionWorkspaceLocationV1);
      return {
        ...metadata,
        machineId: params.machineId,
        ...(location.success && location.data.machineId === metadata.machineId
          ? { sessionWorkspaceLocationV1: { ...location.data, machineId: params.machineId } }
          : {}),
      };
    },
  });
}
