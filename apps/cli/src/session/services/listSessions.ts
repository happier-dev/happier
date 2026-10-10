import type { VendorResumeEligibilityReasonCode } from '@happier-dev/agents';
import type { AccountSettings } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { summarizeSessionRow, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { buildCliSessionRowModel, type CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  fetchSessionById,
  fetchSessionsPage,
  fetchSessionsQueryPage,
  readSessionListAttentionContinuation,
  type RawSessionRecord,
  type SessionListAttentionContinuationV1,
} from '@/session/transport/http/sessionsHttp';
import { getSessionTranscript } from './getSessionTranscript';
import type { SemanticTranscriptItem } from './transcript/semanticTranscriptItem';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { projectCliSessionAwarenessV1 } from '@/cli/output/session/sessionAwareness';
import { mapWithConcurrency } from '@/utils/async/mapWithConcurrency';
import { buildSessionAwarenessListResultV1, markSessionListQueryResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import type { SessionAwarenessListResultV1, SessionListQueryV1, SessionListViewV1 } from '@happier-dev/protocol';
import { matchSessionBotFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

const LIST_SESSION_PREVIEW_TEXT_LIMIT = 200;

/**
 * Explicit previews are one transcript request per returned Session. `Promise.all` fired all of
 * them at once, so a 200-row page opened 200 concurrent requests against the Home; awareness
 * itself never triggers any of them.
 */
const LIST_SESSION_PREVIEW_CONCURRENCY = 4;

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

type ListSessionsResultBase = Readonly<{
  rows?: readonly CliSessionRowModel[];
  sessions: readonly ListSessionsJsonSession[];
  nextCursor: string | null;
  hasNext: boolean;
  queryVersion?: 1;
  metadataUpgradeRequiredCount?: number;
  botFilterUnavailableCount?: number;
}>;

export type ListSessionsResult = ListSessionsResultBase & (
  | SessionListAttentionContinuationV1
  | Readonly<{ attentionNextCursor?: never; attentionHasNext?: never }>
);

function normalizeResultLimit(limit: number | undefined): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor(limit);
}

/**
 * Raised when a strict query asks a host-admitted one-Session corpus something only
 * the Account listing owner can answer. The caller turns it into the typed
 * `unsupported_action` result; a silently empty page would be a wrong answer.
 */
export class SessionListAdmittedQueryUnsupportedError extends Error {
  readonly arms: readonly string[];

  constructor(arms: readonly string[]) {
    super(`Session query arms unsupported for an admitted Session corpus: ${arms.join(', ')}`);
    this.name = 'SessionListAdmittedQueryUnsupportedError';
    this.arms = arms;
  }
}

export type AdmittedSessionListQueryAdmission =
  | Readonly<{ kind: 'match' }>
  | Readonly<{ kind: 'miss' }>
  | Readonly<{ kind: 'unsupported'; arms: readonly string[] }>;

/**
 * The one admission rule for a host-admitted single-Session corpus, shared by the
 * full-credential listing service and the restricted runtime reader so both answer a
 * strict query identically.
 *
 * Storage, archival and liveness are facts the detail row proves by itself. Scope,
 * attention, audience and tag membership are the Home's meaning: re-deriving them
 * here would make a second, diverging query evaluator, so they are reported as
 * unsupported instead.
 */
export function resolveAdmittedSessionListQueryAdmission(
  query: SessionListQueryV1,
  row: Readonly<{ active: boolean; archivedAt?: number | null }>,
): AdmittedSessionListQueryAdmission {
  const arms: string[] = [];
  if (query.underSessionId !== undefined) arms.push('underSessionId');
  if (query.scope !== 'all_accessible') arms.push('scope');
  if (query.attention !== 'any') arms.push('attention');
  if (query.audiences.length > 0) arms.push('audiences');
  if (query.tagIds.length > 0) arms.push('tagIds');
  if (arms.length > 0) return { kind: 'unsupported', arms };
  // An Account-corpus continuation cannot be replayed as the first (and only) page
  // of this corpus. Treat it as already past that row rather than ignoring it.
  if (query.cursor !== undefined || query.attentionCursor !== undefined) return { kind: 'miss' };
  if (query.storage === 'archived') {
    return row.archivedAt != null ? { kind: 'match' } : { kind: 'miss' };
  }
  if (row.archivedAt != null) return { kind: 'miss' };
  if (query.includeInactive || row.active) return { kind: 'match' };
  // `includeInactive: false` still admits an inactive row the Home's attention
  // predicate keeps, and the detail row cannot prove that.
  return { kind: 'unsupported', arms: ['includeInactive'] };
}

function requireSessionListAttentionContinuation(
  continuation: ReturnType<typeof readSessionListAttentionContinuation>,
): Exclude<ReturnType<typeof readSessionListAttentionContinuation>, null> {
  if (continuation === null) {
    throw new Error('Strict Session query response omitted attention continuation');
  }
  return continuation;
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
  /** Already-bound Home Account snapshot for proof-bound Action execution. */
  accountSettings?: AccountSettings | null;
  sessionId: string;
  resolveAuthorizationHeaders?: ListSessionsParams['resolveAuthorizationHeaders'];
}>): Promise<ListSessionsLastMessagePreview | undefined> {
  try {
    const res = await getSessionTranscript({
      credentials: params.credentials,
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
      idOrPrefix: params.sessionId,
      limit: 1,
      sessionListPreview: true,
      roles: ['user', 'assistant'],
      maxCharsPerMessage: LIST_SESSION_PREVIEW_TEXT_LIMIT,
    });
    if (!res.ok) return undefined;
    return toLastMessagePreview(res.items[0]);
  } catch {
    return undefined;
  }
}

/**
 * The host-admitted corpus as one page. Each admitted Session is read through the
 * detail route the principal already holds, so the cost is the size of the admitted
 * corpus rather than the size of the Account's.
 */
async function readAdmittedSessionsPage(params: Readonly<{
  token: string;
  sessionIds: readonly string[];
  query?: SessionListQueryV1;
  resolveAuthorizationHeaders?: ListSessionsParams['resolveAuthorizationHeaders'];
  signal?: AbortSignal;
}>): Promise<Readonly<{
  sessions: RawSessionRecord[];
  nextCursor: null;
  hasNext: false;
  // The admitted one-Session corpus has no attention continuation; naming the
  // fields as absent keeps it assignable to the continuation reader.
  attentionNextCursor?: never;
  attentionHasNext?: never;
  metadataUpgradeRequiredCount?: never;
}>> {
  const rawSessions = await Promise.all(params.sessionIds.map((sessionId) => fetchSessionById({
    token: params.token,
    sessionId,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  })));
  const query = params.query;
  const sessions: RawSessionRecord[] = [];
  for (const rawSession of rawSessions) {
    if (!rawSession) continue;
    if (!query) {
      sessions.push(rawSession);
      continue;
    }
    const admission = resolveAdmittedSessionListQueryAdmission(query, rawSession);
    if (admission.kind === 'unsupported') {
      throw new SessionListAdmittedQueryUnsupportedError(admission.arms);
    }
    if (admission.kind === 'match') sessions.push(rawSession);
  }
  return { sessions, nextCursor: null, hasNext: false };
}

type ListSessionsParams = Readonly<{
  credentials: StoredCredentials;
  /** Already-bound Account snapshot; external Actions must not fetch Account-wide settings. */
  accountSettings?: AccountSettings | null;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET' | 'POST'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
  query?: SessionListQueryV1;
  view?: SessionListViewV1;
  activeOnly?: boolean;
  archivedOnly?: boolean;
  includeSystem: boolean;
  resumableOnly: boolean;
  includeRows?: boolean;
  includeLastMessagePreview?: boolean;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
  /** Host-admitted corpus; applied before any row, awareness, or preview projection. */
  allowedSessionIds?: readonly string[];
}>;

export function listSessions(params: ListSessionsParams & { view: 'awareness' }): Promise<SessionAwarenessListResultV1>;
export function listSessions(params: ListSessionsParams & { view?: 'summary' }): Promise<ListSessionsResult>;
export function listSessions(params: ListSessionsParams): Promise<ListSessionsResult | SessionAwarenessListResultV1>;
export async function listSessions(params: ListSessionsParams): Promise<ListSessionsResult | SessionAwarenessListResultV1> {
  const allowedSessionIds = params.allowedSessionIds
    ? new Set(params.allowedSessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))
    : null;
  const query = params.query;
  const accountEncryptionAuthorizationHeaders = params.resolveAuthorizationHeaders?.({
    method: 'GET', path: '/v1/account/encryption/currentness',
  });
  if (params.resolveAuthorizationHeaders && !accountEncryptionAuthorizationHeaders) {
    throw new Error('External Action authorization unavailable');
  }
  const [initialPage, accountSettingsContext, accountEncryptionCurrentness] = await Promise.all([
    // A Session-bound principal is not an Account-wide list client: its admitted
    // corpus is read exactly, through the detail route, instead of paging the
    // Account corpus until the admitted row appears.
    allowedSessionIds
      ? readAdmittedSessionsPage({
          token: params.credentials.token,
          sessionIds: [...allowedSessionIds],
          ...(params.query ? { query: params.query } : {}),
          ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
          ...(params.signal ? { signal: params.signal } : {}),
        })
      : query
        ? fetchSessionsQueryPage({
            token: params.credentials.token,
            query,
            ...(params.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
              : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          })
        : fetchSessionsPage({
            token: params.credentials.token,
            ...(params.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
              : {}),
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
            activeOnly: params.activeOnly === true,
            archivedOnly: params.archivedOnly === true,
            ...(params.signal ? { signal: params.signal } : {}),
          }),
    Object.hasOwn(params, 'accountSettings')
      ? Promise.resolve({ settings: params.accountSettings ?? null })
      : bootstrapAccountSettingsContext({
          credentials: params.credentials,
          mode: 'fast',
          ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
        }),
    fetchAccountEncryptionCurrentness({
      token: params.credentials.token,
      ...(params.resolveAuthorizationHeaders
        ? { authorizationHeaders: accountEncryptionAuthorizationHeaders! }
        : {}),
    }),
  ]);
  const resultLimit = normalizeResultLimit(params.limit);
  const rawRowById = new Map<string, (typeof initialPage.sessions)[number]>();
  const activityAtBySessionId = new Map<string, number>();
  const rowModels: CliSessionRowModel[] = [];
  let botFilterUnavailableCount = 0;
  const appendPageRows = (rawRows: typeof initialPage.sessions) => {
    for (const rawRow of rawRows) {
      if (allowedSessionIds && !allowedSessionIds.has(rawRow.id)) continue;
      if (query?.bot !== undefined) {
        const match = matchSessionBotFilterV1(tryDecryptSessionPresentationMetadataView({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          rawSession: rawRow,
        }), query.bot);
        if (match === 'unavailable') botFilterUnavailableCount += 1;
        if (match !== 'match') continue;
      }
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
  const presentationRows = () => params.activeOnly
    ? rowModels.filter((row) => row.active === true)
    : rowModels;
  const filteredRows = () => params.resumableOnly
    ? presentationRows()
        .filter((row) => row.vendorResume.eligible === true && row.archivedAt === null && row.active !== true)
        .sort((a, b) => {
          const activityOrder = (activityAtBySessionId.get(b.id) ?? b.updatedAt)
            - (activityAtBySessionId.get(a.id) ?? a.updatedAt);
          if (activityOrder !== 0) return activityOrder;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        })
    : presentationRows();

  let page = initialPage;
  // Count omitted candidates across consumed pages, not unique missing Sessions.
  // Pagination still follows the Home's cursors, independently of these omissions.
  let metadataUpgradeRequiredCount = initialPage.metadataUpgradeRequiredCount ?? 0;
  const shouldFillVisibleLimit = (params.includeSystem === false || params.resumableOnly)
    // The active endpoint intentionally has no cursor contract.
    && params.activeOnly === false
    && params.query === undefined
    && allowedSessionIds === null;
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
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
      cursor,
      // The server cursor is after the whole raw page, so do not fetch more
      // raw rows than can still be returned after client-side filtering.
      limit: resultLimit - filteredRows().length,
      // The visible-limit fill only runs for a non-active, unfiltered listing.
      activeOnly: false,
      archivedOnly: params.archivedOnly === true,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    metadataUpgradeRequiredCount += page.metadataUpgradeRequiredCount ?? 0;
    appendPageRows(page.sessions);
  }

  const limitedRows = resultLimit === null ? filteredRows() : filteredRows().slice(0, resultLimit);
  // A server continuation describes the authenticated Account corpus, not the
  // host-admitted subset. Never expose it to a Session-scoped autonomous caller.
  const nextCursor = allowedSessionIds ? null : page.nextCursor;
  const hasNext = allowedSessionIds ? false : page.hasNext;
  const attentionContinuation = allowedSessionIds
    ? query
      ? { attentionNextCursor: null, attentionHasNext: false } as const
      : null
    : readSessionListAttentionContinuation(page);
  if (params.view === 'awareness') {
    const nowMs = Date.now();
    const sessions = limitedRows.map((row) => {
      const rawRow = rawRowById.get(row.id);
      if (!rawRow) throw new Error(`Missing raw session row for ${row.id}`);
      return projectCliSessionAwarenessV1({
        credentials: params.credentials,
        accountEncryption: accountEncryptionCurrentness,
        row: rawRow,
        nowMs,
      });
    });
    const pageResult = {
      sessions,
      nextCursor,
      hasNext,
      ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
      ...(botFilterUnavailableCount > 0 ? { botFilterUnavailableCount } : {}),
    };
    return query
      ? buildSessionAwarenessListResultV1({
          ...pageResult,
          ...requireSessionListAttentionContinuation(attentionContinuation),
        })
      : buildSessionAwarenessListResultV1(pageResult);
  }
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
    const previews = await mapWithConcurrency(sessions, LIST_SESSION_PREVIEW_CONCURRENCY, async (session) => [
      session.id,
      await loadLastMessagePreview({
        credentials: params.credentials,
        sessionId: session.id,
        ...(params.resolveAuthorizationHeaders
          ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
          : {}),
      }),
    ] as const);
    const previewBySessionId = new Map(previews.filter((entry): entry is readonly [string, ListSessionsLastMessagePreview] => entry[1] !== undefined));
    sessions = sessions.map((session) => {
      const preview = previewBySessionId.get(session.id);
      return preview ? { ...session, lastMessagePreview: preview } : session;
    });
  }

  const result = {
    sessions,
    nextCursor,
    hasNext,
    ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
    ...(botFilterUnavailableCount > 0 ? { botFilterUnavailableCount } : {}),
    ...(params.includeRows === true ? { rows: limitedRows } : {}),
  };
  if (!query) {
    return attentionContinuation === null
      ? result
      : { ...result, ...attentionContinuation };
  }
  return markSessionListQueryResultV1({
    ...result,
    ...requireSessionListAttentionContinuation(attentionContinuation),
  });
}
