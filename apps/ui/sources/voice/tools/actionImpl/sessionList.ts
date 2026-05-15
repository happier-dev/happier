import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { isHiddenSystemSession } from '@happier-dev/protocol';

import {
  compareSessionKeyDesc,
  type CursorKey,
  formatCursorKey,
  parseCursorKey,
  normalizeNonEmptyString,
  resolveVoiceUpdatesPrefs,
  shouldIncludeAfterCursor,
  toRoleAndText,
} from './shared';
import { collectVoiceSessionRows } from './voiceSessionRows';

export async function listSessionsForVoiceTool(params: Readonly<{
  limit?: number;
  cursor?: string | null;
  includeLastMessagePreview?: boolean;
}>): Promise<Readonly<{ ok: true; sessions: readonly any[]; nextCursor: string | null }>> {
  const state: any = storage.getState();
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(100, Math.floor(params.limit)))
      : 100;
  const includeLastMessagePreview = params.includeLastMessagePreview === true;
  const cursorKey = parseCursorKey(params.cursor ?? null);

  const visibleSessionRows = collectVoiceSessionRows(state);
  const sessionsObj = state?.sessions ?? {};
  const rows = visibleSessionRows
    .map((row) => {
      const raw = sessionsObj?.[row.id];
      if (raw && isHiddenSystemSession({ metadata: raw?.metadata })) {
        return null;
      }
      const updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : row.updatedAt;
      return {
        id: row.id,
        key: { updatedAt, id: row.id } satisfies CursorKey,
        active: row.active,
        presence: row.presence,
        updatedAt,
        title: row.title ?? (raw ? getSessionName(raw) : row.id),
        locationLabel: normalizeNonEmptyString(row.locationLabel),
        serverId: row.serverId ?? null,
        serverName: normalizeNonEmptyString(row.serverName),
      };
    })
    .filter(Boolean) as any[];

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
      if (typeof s.locationLabel === 'string' && s.locationLabel.trim().length > 0) {
        out.locationLabel = s.locationLabel;
      }
      if (typeof s.serverId === 'string' && s.serverId.trim().length > 0) {
        out.serverId = s.serverId;
      }
      if (typeof s.serverName === 'string' && s.serverName.trim().length > 0) {
        out.serverName = s.serverName;
      }
      if (!includeLastMessagePreview) return out;

      const messages = readStoredSessionMessages(state, s.id);
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
