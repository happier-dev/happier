import type { VendorResumeEligibilityReasonCode } from '@happier-dev/agents';

import type { StoredCredentials } from '@/persistence';
import { summarizeSessionRow, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { buildCliSessionRowModel, type CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { getSessionTranscript } from './getSessionTranscript';
import type { SemanticTranscriptItem } from './transcript/semanticTranscriptItem';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';

const LIST_SESSION_PREVIEW_TEXT_LIMIT = 200;

export type ListSessionsLastMessagePreview = Readonly<{
  id: string;
  createdAt: number;
  role: 'user' | 'assistant';
  text: string;
  truncated?: boolean;
}>;

export type ListSessionsJsonSession = SessionSummary & Readonly<{
  agentId: CliSessionRowModel['agentId'];
  vendorResumeEligible: boolean;
  vendorResumeReasonCode?: VendorResumeEligibilityReasonCode;
  lastMessagePreview?: ListSessionsLastMessagePreview;
}>;

export type ListSessionsResult = Readonly<{
  rows?: readonly CliSessionRowModel[];
  sessions: readonly ListSessionsJsonSession[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

function normalizeResultLimit(limit: number | undefined): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor(limit);
}

function toLastMessagePreview(message: SemanticTranscriptItem | undefined): ListSessionsLastMessagePreview | undefined {
  if (!message || !message.text) return undefined;
  const text = message.text.slice(0, LIST_SESSION_PREVIEW_TEXT_LIMIT);
  return {
    id: message.id,
    createdAt: message.createdAt,
    role: message.role === 'user' ? 'user' : 'assistant',
    text,
    ...(message.text.length > text.length ? { truncated: true } : {}),
  };
}

async function loadLastMessagePreview(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
}>): Promise<ListSessionsLastMessagePreview | undefined> {
  try {
    const res = await getSessionTranscript({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
      limit: 1,
      roles: ['user', 'assistant'],
      maxCharsPerMessage: LIST_SESSION_PREVIEW_TEXT_LIMIT,
    });
    if (!res.ok) return undefined;
    return toLastMessagePreview(res.items[0]);
  } catch {
    return undefined;
  }
}

export async function listSessions(params: Readonly<{
  credentials: StoredCredentials;
  activeOnly: boolean;
  archivedOnly: boolean;
  includeSystem: boolean;
  resumableOnly: boolean;
  includeRows?: boolean;
  includeLastMessagePreview?: boolean;
  limit?: number;
  cursor?: string;
}>): Promise<ListSessionsResult> {
  const [initialPage, accountSettingsContext, accountEncryptionCurrentness] = await Promise.all([
    fetchSessionsPage({
      token: params.credentials.token,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      activeOnly: params.activeOnly,
      archivedOnly: params.archivedOnly,
    }),
    bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'fast',
    }),
    fetchAccountEncryptionCurrentness({ token: params.credentials.token }),
  ]);
  const resultLimit = normalizeResultLimit(params.limit);
  const rawRowById = new Map<string, (typeof initialPage.sessions)[number]>();
  const activityAtBySessionId = new Map<string, number>();
  const rowModels: CliSessionRowModel[] = [];
  const appendPageRows = (rawRows: typeof initialPage.sessions) => {
    for (const rawRow of rawRows) {
      rawRowById.set(rawRow.id, rawRow);
      const meaningfulActivityAt = (rawRow as { meaningfulActivityAt?: unknown }).meaningfulActivityAt;
      activityAtBySessionId.set(
        rawRow.id,
        typeof meaningfulActivityAt === 'number' && Number.isFinite(meaningfulActivityAt)
          ? meaningfulActivityAt
          : rawRow.updatedAt,
      );
      const row = buildCliSessionRowModel({
        credentials: params.credentials,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
        rawSession: rawRow,
        accountSettings: accountSettingsContext.settings,
      });
      if (params.includeSystem || row.isSystem !== true) rowModels.push(row);
    }
  };
  appendPageRows(initialPage.sessions);
  const filteredRows = () => params.resumableOnly
    ? rowModels
        .filter((row) => row.vendorResume.eligible === true && row.archivedAt === null && row.active !== true)
        .sort((a, b) => {
          const activityOrder = (activityAtBySessionId.get(b.id) ?? b.updatedAt)
            - (activityAtBySessionId.get(a.id) ?? a.updatedAt);
          if (activityOrder !== 0) return activityOrder;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        })
    : rowModels;

  let page = initialPage;
  const shouldFillVisibleLimit = (params.includeSystem === false || params.resumableOnly)
    // The active endpoint intentionally has no cursor contract.
    && params.activeOnly === false;
  const seenCursors = new Set(params.cursor ? [params.cursor] : []);
  while (
    resultLimit !== null
    && shouldFillVisibleLimit
    && filteredRows().length < resultLimit
  ) {
    if (!page.hasNext || page.nextCursor === null || seenCursors.has(page.nextCursor)) break;
    const cursor = page.nextCursor;
    seenCursors.add(cursor);
    page = await fetchSessionsPage({
      token: params.credentials.token,
      cursor,
      // The server cursor is after the whole raw page, so do not fetch more
      // raw rows than can still be returned after client-side filtering.
      limit: resultLimit - filteredRows().length,
      activeOnly: params.activeOnly,
      archivedOnly: params.archivedOnly,
    });
    appendPageRows(page.sessions);
  }

  const limitedRows = resultLimit === null ? filteredRows() : filteredRows().slice(0, resultLimit);
  let sessions = limitedRows.map((row) => {
      const rawRow = rawRowById.get(row.id);
      if (!rawRow) throw new Error(`Missing raw session row for ${row.id}`);
      const session = summarizeSessionRow({
        credentials: params.credentials,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
        row: rawRow,
      });
      return {
        ...session,
        agentId: row.agentId,
        vendorResumeEligible: row.vendorResume.eligible,
        ...(row.vendorResume.eligible ? {} : { vendorResumeReasonCode: row.vendorResume.reasonCode }),
      };
  });

  if (params.includeLastMessagePreview === true) {
    const previews = await Promise.all(sessions.map(async (session) => [
      session.id,
      await loadLastMessagePreview({ credentials: params.credentials, sessionId: session.id }),
    ] as const));
    const previewBySessionId = new Map(previews.filter((entry): entry is readonly [string, ListSessionsLastMessagePreview] => entry[1] !== undefined));
    sessions = sessions.map((session) => {
      const preview = previewBySessionId.get(session.id);
      return preview ? { ...session, lastMessagePreview: preview } : session;
    });
  }

  return {
    sessions,
    nextCursor: page.nextCursor,
    hasNext: page.hasNext,
    ...(params.includeRows === true ? { rows: limitedRows } : {}),
  };
}
