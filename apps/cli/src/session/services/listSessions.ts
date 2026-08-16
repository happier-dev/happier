import type { VendorResumeEligibilityReasonCode } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { summarizeSessionRow, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { buildCliSessionRowModel, type CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { getSessionTranscript } from './getSessionTranscript';
import type { SemanticTranscriptItem } from './transcript/semanticTranscriptItem';

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
  sessions: readonly ListSessionsJsonSession[];
  nextCursor: string | null;
  hasNext: boolean;
  rows?: readonly CliSessionRowModel[];
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
  credentials: Credentials;
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
  credentials: Credentials;
  activeOnly: boolean;
  archivedOnly: boolean;
  includeSystem: boolean;
  resumableOnly: boolean;
  includeRows?: boolean;
  includeLastMessagePreview?: boolean;
  limit?: number;
  cursor?: string;
}>): Promise<ListSessionsResult> {
  const page = await fetchSessionsPage({
    token: params.credentials.token,
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.limit ? { limit: params.limit } : {}),
    activeOnly: params.activeOnly,
    archivedOnly: params.archivedOnly,
  });

  const accountSettingsContext = await bootstrapAccountSettingsContext({
    credentials: params.credentials,
    mode: 'fast',
  });
  const rowModels = page.sessions
    .map((row) =>
      buildCliSessionRowModel({
        credentials: params.credentials,
        rawSession: row,
        accountSettings: accountSettingsContext.settings,
      }))
    .filter((row) => params.includeSystem || row.isSystem !== true);

  const activityAtBySessionId = new Map(page.sessions.map((row) => {
    const meaningfulActivityAt = (row as { meaningfulActivityAt?: unknown }).meaningfulActivityAt;
    return [
      row.id,
      typeof meaningfulActivityAt === 'number' && Number.isFinite(meaningfulActivityAt)
        ? meaningfulActivityAt
        : row.updatedAt,
    ] as const;
  }));

  const filteredRows = params.resumableOnly
    ? rowModels
        .filter((row) => row.vendorResume.eligible === true && row.archivedAt === null && row.active !== true)
        .sort((a, b) => {
          const activityOrder = (activityAtBySessionId.get(b.id) ?? b.updatedAt)
            - (activityAtBySessionId.get(a.id) ?? a.updatedAt);
          if (activityOrder !== 0) return activityOrder;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        })
    : rowModels;
  const resultLimit = normalizeResultLimit(params.limit);
  const limitedRows = resultLimit === null ? filteredRows : filteredRows.slice(0, resultLimit);

  const rawRowById = new Map(page.sessions.map((row) => [row.id, row] as const));
  let sessions = limitedRows.map((row) => {
      const rawRow = rawRowById.get(row.id);
      if (!rawRow) throw new Error(`Missing raw session row for ${row.id}`);
      const session = summarizeSessionRow({ credentials: params.credentials, row: rawRow });
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
