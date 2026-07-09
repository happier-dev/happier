import { sync } from '@/sync/sync';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import { resolveSpawnedFirstPromptFollowUp } from '@/sync/domains/session/spawn/spawnedFirstPromptFollowUp';
import { normalizeNonEmptyString } from './shared';

export async function postprocessSpawnedSession(params: Readonly<{
  sessionId: string | null;
  serverId?: string | null;
  tag?: string | null;
  initialMessage?: string | null;
  initialMessageMetaOverrides?: Record<string, unknown> | null;
  daemonInitialPromptUsed?: boolean | null;
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
    metaOverrides: normalizeInitialMessageMetaOverrides(params.initialMessageMetaOverrides),
    daemonInitialPromptUsed: params.daemonInitialPromptUsed === true,
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

  if (!tag && !initialMessage && params.daemonInitialPromptUsed === true) {
    try {
      await sync.refreshSessions();
    } catch {
      // best-effort
    }
  }
}

export function didSpawnUseDaemonInitialPrompt(spawned: unknown): boolean {
  if (!spawned || typeof spawned !== 'object' || Array.isArray(spawned)) {
    return false;
  }
  return (spawned as { usedInitialPrompt?: unknown }).usedInitialPrompt === true;
}

function normalizeInitialMessageMetaOverrides(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value || Object.keys(value).length === 0) return null;
  return value;
}
