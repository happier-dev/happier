import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import {
  clampInt,
  compareSessionKeyDesc,
  formatCursorKey,
  parseCursorKey,
  resolveVoiceUpdatesPrefs,
  shouldIncludeAfterCursor,
  toRoleAndText,
} from './shared';

export async function getSessionRecentMessagesForVoiceTool(params: Readonly<{
  sessionId: string;
  defaultSessionId?: string | null;
  limit?: number;
  cursor?: string | null;
  includeUser?: boolean;
  includeAssistant?: boolean;
  maxCharsPerMessage?: number | null;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; messages: readonly any[]; nextCursor: string | null }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string }>
> {
  const state: any = storage.getState();
  const prefs = resolveVoiceUpdatesPrefs((state?.settings ?? {}) as any);
  if (!prefs.shareRecentMessages) return { ok: false, errorCode: 'recent_messages_disabled', errorMessage: 'recent_messages_disabled' };

  const requestedSessionId = String(params.sessionId ?? '').trim();
  const activeSessionId = String(params.defaultSessionId ?? '').trim() || null;
  const { trackedSessionIds } = useVoiceTargetStore.getState();
  const isActive = requestedSessionId === activeSessionId || trackedSessionIds.includes(requestedSessionId);

  if (!isActive && prefs.otherSessionsSnippetsMode === 'never') {
    return { ok: false, errorCode: 'other_sessions_snippets_disabled', errorMessage: 'other_sessions_snippets_disabled' };
  }

  const defaultOnDemandLimit = clampInt(params.limit, { min: 1, max: 50, fallback: 20 });
  const limit = defaultOnDemandLimit;
  const cursor = params.cursor ?? null;
  const maxCharsPerMessage = params.maxCharsPerMessage ?? null;

  const includeAssistant = params.includeAssistant ?? true;
  const includeUser = params.includeUser ?? true;

  const messages = readStoredSessionMessages(state, requestedSessionId);
  const beforeCursor = parseCursorKey(cursor);

  const filtered = messages
    .filter((m) => m && typeof m === 'object')
    .map((message) => ({
      message,
      key: {
        updatedAt: Number((message as any).createdAt ?? 0),
        id: String((message as any).id ?? ''),
      },
    }))
    .filter(({ key }) => Number.isFinite(key.updatedAt) && key.id.length > 0)
    .filter(({ message }) => {
      if (message.kind === 'agent-text') return includeAssistant;
      if (message.kind === 'user-text') return includeUser;
      if (message.kind === 'tool-call') return includeAssistant;
      return false;
    })
    .filter(({ key }) => (beforeCursor == null ? true : shouldIncludeAfterCursor(key, beforeCursor)))
    .slice(0)
    .sort((left, right) => compareSessionKeyDesc(left.key, right.key));

  const page = filtered.slice(0, limit).slice(0).reverse();
  const outMessages = page.flatMap(({ message }) => {
    const row = toRoleAndText(message, { shareToolNames: prefs.shareToolNames, shareToolArgs: prefs.shareToolArgs, shareFilePaths: prefs.shareFilePaths });
    if (!row.text || !row.role) return [];
    const text = maxCharsPerMessage === null ? row.text : row.text.slice(0, Math.max(0, maxCharsPerMessage));
    return [{
      id: (message as any).id,
      role: row.role,
      text,
      createdAt: (message as any).createdAt,
    }];
  });

  const nextCursor = outMessages.length > 0
    ? formatCursorKey({
        updatedAt: Number(outMessages[0]?.createdAt ?? 0),
        id: String(outMessages[0]?.id ?? ''),
      })
    : null;
  return { ok: true, sessionId: requestedSessionId, messages: outMessages, nextCursor };
}
