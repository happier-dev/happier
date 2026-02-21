import { storage } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { isHiddenSystemSession } from '@happier-dev/protocol';

import {
  compareSessionKeyDesc,
  type CursorKey,
  formatCursorKey,
  parseCursorKey,
  resolveVoiceUpdatesPrefs,
  shouldIncludeAfterCursor,
  toRoleAndText,
} from './shared';

export async function listSessionsForVoiceTool(params: Readonly<{
  limit?: number;
  cursor?: string | null;
  includeLastMessagePreview?: boolean;
}>): Promise<Readonly<{ ok: true; sessions: readonly any[]; nextCursor: string | null }>> {
  const state: any = storage.getState();
  const sessionsObj = state?.sessions ?? {};
  const sessionsFromCaches = state?.sessionListViewDataByServerId ?? {};
  const limit = params.limit ?? 20;
  const includeLastMessagePreview = params.includeLastMessagePreview !== false;
  const cursorKey = parseCursorKey(params.cursor ?? null);

  const seen = new Set<string>();
  const rows: any[] = [];

  const pushSessionRow = (s: any, serverId: string | null) => {
    if (!s || typeof s.id !== 'string') return;
    if (isHiddenSystemSession({ metadata: s?.metadata })) return;
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
    rows.push({
      id: s.id,
      key: { updatedAt, id: s.id } satisfies CursorKey,
      active: Boolean(s.active),
      presence: typeof s.presence === 'string' ? s.presence : null,
      updatedAt,
      title: getSessionName(s),
      serverId,
    });
  };

  for (const s of Object.values(sessionsObj)) {
    pushSessionRow(s as any, null);
  }

  for (const [serverIdRaw, items] of Object.entries(sessionsFromCaches)) {
    if (!Array.isArray(items)) continue;
    const serverId = String(serverIdRaw ?? '').trim();
    for (const item of items as any[]) {
      if (!item || item.type !== 'session') continue;
      pushSessionRow(item.session, serverId || null);
    }
  }

  const prefs = resolveVoiceUpdatesPrefs((state?.settings ?? {}) as any);

  const sessions = rows
    .sort((a: any, b: any) => compareSessionKeyDesc(a.key, b.key))
    .filter((s: any) => (cursorKey ? shouldIncludeAfterCursor(s.key, cursorKey) : true))
    .slice(0, limit)
    .map((s: any) => {
      const out: any = {
        id: s.id,
        title: s.title,
        active: s.active,
        presence: s.presence,
        updatedAt: s.updatedAt,
      };
      if (typeof s.serverId === 'string' && s.serverId.trim().length > 0) {
        out.serverId = s.serverId;
      }
      if (!includeLastMessagePreview) return out;

      const messages = (state?.sessionMessages?.[s.id]?.messages ?? []) as Message[];
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      if (!last) return out;
      if (!prefs.shareRecentMessages && (last.kind === 'agent-text' || last.kind === 'user-text')) {
        return out;
      }
      const preview = toRoleAndText(last, {
        shareToolNames: prefs.shareToolNames,
        shareToolArgs: prefs.shareToolArgs,
        shareFilePaths: prefs.shareFilePaths,
      });
      if (!preview.text || !preview.role) return out;
      out.lastMessagePreview = {
        role: preview.role,
        text: preview.text,
        createdAt: (last as any).createdAt ?? null,
      };
      return out;
    });

  const nextCursor =
    sessions.length > 0
      ? formatCursorKey({ updatedAt: sessions[sessions.length - 1].updatedAt ?? 0, id: sessions[sessions.length - 1].id })
      : null;

  return { ok: true, sessions, nextCursor };
}
