import { buildSpawnedFirstTurnLocalId } from '@happier-dev/protocol';
import { sync } from '@/sync/sync';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import { resolveSpawnedFirstPromptFollowUp } from '@/sync/domains/session/spawn/spawnedFirstPromptFollowUp';
import { normalizeNonEmptyString } from './shared';

export function resolveVoiceSpawnedFirstTurnLocalId(params: Readonly<{
  spawned: unknown;
  requestedSpawnNonce: string;
}>): string | null {
  const spawnedRecord = params.spawned && typeof params.spawned === 'object' && !Array.isArray(params.spawned)
    ? params.spawned as Record<string, unknown>
    : null;
  const custody = spawnedRecord?.spawnAttemptCustody
    && typeof spawnedRecord.spawnAttemptCustody === 'object'
    && !Array.isArray(spawnedRecord.spawnAttemptCustody)
    ? spawnedRecord.spawnAttemptCustody as Record<string, unknown>
    : null;
  const canonicalSpawnNonce = normalizeNonEmptyString(custody?.spawnNonce)
    ?? normalizeNonEmptyString(params.requestedSpawnNonce);
  return buildSpawnedFirstTurnLocalId(canonicalSpawnNonce);
}

export async function postprocessSpawnedSession(params: Readonly<{
  sessionId: string | null;
  serverId?: string | null;
  tag?: string | null;
  initialMessage?: string | null;
  initialMessageMetaOverrides?: Record<string, unknown> | null;
  firstTurnLocalId?: string | null;
}>): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) return;
  const tag = normalizeNonEmptyString(params.tag);
  const initialMessage = normalizeNonEmptyString(params.initialMessage);

  if (tag) {
    try {
      await sync.refreshSessions();
      await publishDisplayTitleMetadataMutation({
        sessionId,
        title: `Session ${tag}`,
        updateSessionMetadataWithRetry: (targetSessionId, updater) =>
          sync.patchSessionMetadataWithRetry(targetSessionId, updater),
        resolveTitle: (metadata: Metadata) =>
          typeof metadata?.summary?.text === 'string' ? metadata.summary.text : `Session ${tag}`,
      });
    } catch {
      // best-effort
    }
  }

  const firstPromptFollowUp = resolveSpawnedFirstPromptFollowUp({
    sessionId,
    initialMessageText: initialMessage,
    fallbackLocalId: params.firstTurnLocalId,
    metaOverrides: normalizeInitialMessageMetaOverrides(params.initialMessageMetaOverrides),
  });

  if (firstPromptFollowUp.initialMessageText) {
    await followUpSpawnedSessionWithServerScope({
      sessionId,
      targetServerId: params.serverId ?? null,
      initialMessageText: firstPromptFollowUp.initialMessageText,
      metaOverrides: firstPromptFollowUp.metaOverrides,
      messageLocalId: firstPromptFollowUp.messageLocalId ?? undefined,
    });
  }

}

function normalizeInitialMessageMetaOverrides(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value || Object.keys(value).length === 0) return null;
  return value;
}
