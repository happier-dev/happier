import type { Credentials } from '@/persistence';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';
import { applyMemorySynopsisPointerV1ToSessionMetadata } from '@/session/memoryArtifacts/memorySynopsisPointerV1';

export type UpdateMemorySynopsisPointerBestEffortDeps = Readonly<{
  fetchSessionById: typeof fetchSessionById;
  updateSessionMetadataWithRetry: typeof updateSessionMetadataWithRetry;
}>;

export async function updateMemorySynopsisPointerBestEffort(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  synopsis: Readonly<{ seqTo: number; updatedAtMs: number }>;
  deps?: Partial<UpdateMemorySynopsisPointerBestEffortDeps>;
}>): Promise<void> {
  const deps: UpdateMemorySynopsisPointerBestEffortDeps = {
    fetchSessionById,
    updateSessionMetadataWithRetry,
    ...params.deps,
  };

  try {
    const rawSession = await deps.fetchSessionById({ token: params.credentials.token, sessionId: params.sessionId });
    if (!rawSession) return;
    await deps.updateSessionMetadataWithRetry({
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession,
      updater: (metadata) => {
        return applyMemorySynopsisPointerV1ToSessionMetadata({ metadata, next: params.synopsis });
      },
      maxAttempts: 4,
    });
  } catch {
    // best-effort only
  }
}

