import type { Message } from '@/sync/domains/messages/messageTypes';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import { clampInt, resolveVoiceUpdatesPrefs, toRoleAndText } from './shared';

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

  const messages = (state?.sessionMessages?.[requestedSessionId]?.messages ?? []) as Message[];

  const beforeCreatedAt = (() => {
    if (!cursor) return null;
    const n = Number(cursor);
    return Number.isFinite(n) ? n : null;
  })();

  const filtered = messages
    .filter((m) => m && typeof m === 'object')
    .filter((m) => {
      if (m.kind === 'agent-text') return includeAssistant;
      if (m.kind === 'user-text') return includeUser;
      if (m.kind === 'tool-call') return includeAssistant;
      return false;
    })
    .filter((m) => (beforeCreatedAt == null ? true : m.createdAt < beforeCreatedAt))
    .slice(0)
    .sort((a, b) => b.createdAt - a.createdAt);

  const page = filtered.slice(0, limit).slice(0).reverse();
  const outMessages = page.flatMap((m) => {
    const row = toRoleAndText(m, { shareToolNames: prefs.shareToolNames, shareToolArgs: prefs.shareToolArgs, shareFilePaths: prefs.shareFilePaths });
    if (!row.text || !row.role) return [];
    const text = maxCharsPerMessage === null ? row.text : row.text.slice(0, Math.max(0, maxCharsPerMessage));
    return [{
      id: (m as any).id,
      role: row.role,
      text,
      createdAt: (m as any).createdAt,
    }];
  });

  const nextCursor = outMessages.length > 0 ? String(outMessages[0].createdAt) : null;
  return { ok: true, sessionId: requestedSessionId, messages: outMessages, nextCursor };
}
