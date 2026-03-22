import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { spawnDaemonSession } from '@/daemon/controlClient';
import type { Credentials } from '@/persistence';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { summarizeSessionRecord, type SessionSummary } from '@/cli/output/session/sessionSummary';

type CreateSpawnedSessionParams = Readonly<{
  credentials: Credentials;
  directory: string;
  machineId?: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  title?: string;
  tag?: string;
  initialMessage?: string;
}>;

export async function createSpawnedSession(
  params: CreateSpawnedSessionParams,
): Promise<Readonly<{ created: true; sessionId: string; session: SessionSummary }>> {
  const spawnRequest = SpawnDaemonSessionRequestSchema.parse({
    directory: params.directory,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    backendTarget: params.backendTarget,
    ...(params.modelId ? { modelId: params.modelId, modelUpdatedAt: Date.now() } : {}),
    ...(typeof params.initialMessage === 'string' && params.initialMessage.trim().length > 0
      ? { initialPrompt: params.initialMessage }
      : {}),
  });
  const spawnResponse = await spawnDaemonSession(spawnRequest);

  if (!spawnResponse || spawnResponse.success !== true || typeof spawnResponse.sessionId !== 'string') {
    const error = new Error(
      typeof spawnResponse?.error === 'string' && spawnResponse.error.trim().length > 0
        ? spawnResponse.error
        : 'Failed to spawn session',
    );
    (error as { code?: string }).code =
      spawnResponse?.requiresUserApproval === true
        ? 'conflict'
        : typeof spawnResponse?.errorCode === 'string' && spawnResponse.errorCode.trim().length > 0
          ? spawnResponse.errorCode
          : 'unknown_error';
    (error as { details?: unknown }).details = spawnResponse ?? null;
    throw error;
  }

  const sessionId = spawnResponse.sessionId.trim();
  let rawSession = await fetchSessionById({ token: params.credentials.token, sessionId });
  if (!rawSession) {
    const error = new Error(`Spawned session ${sessionId} was not found`);
    (error as { code?: string }).code = 'unknown_error';
    throw error;
  }

  const normalizedTitle = typeof params.title === 'string' ? params.title.trim() : '';
  const normalizedTag = typeof params.tag === 'string' ? params.tag.trim() : '';
  if (normalizedTitle || normalizedTag) {
    await updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId,
      rawSession,
      updater: (metadata) => ({
        ...metadata,
        ...(normalizedTag ? { tag: normalizedTag } : {}),
        ...(normalizedTitle
          ? {
              summary: {
                text: normalizedTitle,
                updatedAt: Date.now(),
              },
            }
          : {}),
      }),
    });

    rawSession = await fetchSessionById({ token: params.credentials.token, sessionId });
    if (!rawSession) {
      const error = new Error(`Spawned session ${sessionId} was not found after metadata update`);
      (error as { code?: string }).code = 'unknown_error';
      throw error;
    }
  }

  return {
    created: true,
    sessionId,
    session: summarizeSessionRecord({ credentials: params.credentials, session: rawSession }),
  };
}
