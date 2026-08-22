import type { StoredCredentials } from '@/persistence';
import {
  SESSION_TRANSCRIPT_GET_MAX_LIMIT,
  type SessionTranscriptGetExternalShareableResultV1,
  type SessionTranscriptGetResult,
} from '@happier-dev/protocol/actions';

import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { fetchTranscriptSemanticPage } from './transcript/fetchTranscriptSemanticPage';
import { projectExternalShareableTranscriptPage } from './transcript/projectExternalShareableTranscriptPage';
import type { TranscriptDirection, TranscriptScope } from './transcript/semanticTranscriptItem';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

type GetSessionTranscriptErrorResult = Extract<SessionTranscriptGetResult, Readonly<{ ok: false }>>;

export type GetSessionTranscriptResult = Exclude<
  SessionTranscriptGetResult,
  Readonly<{ projection: 'externalShareableV1' }>
>;

export type GetExternalShareableSessionTranscriptResult =
  | SessionTranscriptGetExternalShareableResultV1
  | GetSessionTranscriptErrorResult;

type GetSessionTranscriptParams = Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  limit?: number;
  cursor?: string | null;
  direction?: TranscriptDirection;
  scope?: TranscriptScope;
  sidechainId?: string | null;
  roles?: readonly ('user' | 'assistant')[];
  includeTools?: boolean;
  includeReasoning?: boolean;
  includeEvents?: boolean;
  includeMeta?: boolean;
  includeRaw?: boolean;
  includeStructuredPayload?: boolean;
  maxCharsPerMessage?: number | null;
  maxRawPayloadChars?: number | null;
  projection?: 'externalShareableV1';
  callerPluginId?: string | null;
  signal?: AbortSignal;
}>;

function clampInt(value: unknown, params: Readonly<{ min: number; max: number; fallback: number }>): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return params.fallback;
  return Math.max(params.min, Math.min(params.max, Math.floor(parsed)));
}

function normalizeDirection(value: unknown): TranscriptDirection {
  return value === 'after' ? 'after' : 'before';
}

function normalizeScope(value: unknown, fallback: TranscriptScope): TranscriptScope {
  return value === 'main' || value === 'sidechain' || value === 'all' ? value : fallback;
}

function normalizeTranscriptRoles(value: readonly ('user' | 'assistant')[] | undefined): readonly ('user' | 'assistant')[] {
  if (!value) return ['user', 'assistant'];
  return value.filter((role) => role === 'user' || role === 'assistant');
}

function mapTranscriptRolesToStoredRoles(roles: readonly ('user' | 'assistant')[]): readonly ('user' | 'agent')[] {
  const out: Array<'user' | 'agent'> = [];
  if (roles.includes('user')) out.push('user');
  if (roles.includes('assistant')) out.push('agent');
  return out;
}

function parseExternalCursor(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = value.trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== normalized) {
    throw new Error('invalid_cursor');
  }
  return parsed;
}

export function getSessionTranscript(
  params: GetSessionTranscriptParams & Readonly<{ projection: 'externalShareableV1' }>,
): Promise<GetExternalShareableSessionTranscriptResult>;
export function getSessionTranscript(
  params: GetSessionTranscriptParams & Readonly<{ projection?: undefined; callerPluginId?: undefined }>,
): Promise<GetSessionTranscriptResult>;
export function getSessionTranscript(
  params: GetSessionTranscriptParams,
): Promise<GetSessionTranscriptResult | GetExternalShareableSessionTranscriptResult>;
export async function getSessionTranscript(
  params: GetSessionTranscriptParams,
): Promise<GetSessionTranscriptResult | GetExternalShareableSessionTranscriptResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      errorCode: sessionTarget.code,
      errorMessage: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  if (params.projection === 'externalShareableV1') {
    try {
      const cursorSeq = parseExternalCursor(params.cursor);
      const limit = clampInt(params.limit, { min: 1, max: SESSION_TRANSCRIPT_GET_MAX_LIMIT, fallback: 20 });
      const rawPage = await fetchEncryptedTranscriptMessagesPage({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        limit: 100,
        afterSeq: cursorSeq,
        scope: 'main',
        roles: ['user', 'agent'],
        projection: 'externalShareableV1',
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.signal?.throwIfAborted();
      const snapshot = rawPage.externalShareableSnapshot;
      if (!snapshot) {
        return {
          ok: false,
          errorCode: 'external_shareable_snapshot_unavailable',
          errorMessage: 'external_shareable_snapshot_unavailable',
        };
      }
      const page = await projectExternalShareableTranscriptPage({
        sessionId: sessionTarget.sessionId,
        rows: rawPage.messages,
        turns: snapshot.turns,
        ctx: sessionTarget.ctx,
        callerPluginId: params.callerPluginId,
        cursorSeq,
        limit,
        upstreamHasMore: rawPage.hasMore,
        publicationBlocked: rawPage.publicationBlocked === true,
        ...(snapshot.publicationBlockedFromSeq !== undefined
          ? { publicationBlockedFromSeq: snapshot.publicationBlockedFromSeq }
          : {}),
        ...(snapshot.turnSettlementBlockedFromSeq !== undefined
          ? { turnSettlementBlockedFromSeq: snapshot.turnSettlementBlockedFromSeq }
          : {}),
        ...(snapshot.referencedUserRows !== undefined
          ? { referencedUserRows: snapshot.referencedUserRows }
          : {}),
      });
      params.signal?.throwIfAborted();
      return {
        ok: true,
        sessionId: sessionTarget.sessionId,
        projection: 'externalShareableV1',
        ...page,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (message === 'invalid_cursor') {
        return { ok: false, errorCode: 'invalid_cursor', errorMessage: 'invalid_cursor' };
      }
      throw error;
    }
  }

  const roles = normalizeTranscriptRoles(params.roles);
  if (roles.length === 0) {
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 0, scanLimitReached: false, payloadTruncations: 0 },
    };
  }

  const includeRaw = params.includeRaw === true || params.includeStructuredPayload === true;
  const includeEventLikeItems =
    params.includeTools === true || params.includeReasoning === true || params.includeEvents === true;
  const limit = clampInt(params.limit, { min: 1, max: SESSION_TRANSCRIPT_GET_MAX_LIMIT, fallback: 20 });
  const maxCharsPerMessage = params.maxCharsPerMessage === null
    ? null
    : params.maxCharsPerMessage === undefined
      ? null
      : clampInt(params.maxCharsPerMessage, { min: 0, max: 50_000, fallback: 50_000 });
  const maxRawPayloadChars = params.maxRawPayloadChars === null
    ? 8192
    : clampInt(params.maxRawPayloadChars, { min: 1, max: 32768, fallback: 8192 });

  try {
    const page = await fetchTranscriptSemanticPage({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      limit,
      rawPageLimit: includeRaw ? Math.min(50, Math.max(limit, 20)) : Math.min(100, Math.max(limit, 20)),
      maxRawRowsToScan: Math.max(40, limit * 20),
      direction: normalizeDirection(params.direction),
      cursor: params.cursor ?? null,
      scope: normalizeScope(params.scope, 'main'),
      ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
      ...(includeEventLikeItems ? {} : { serverRoles: mapTranscriptRolesToStoredRoles(roles) }),
      mode: 'transcript',
      transcriptRoles: roles,
      includeTools: params.includeTools === true,
      includeReasoning: params.includeReasoning === true,
      includeEvents: params.includeEvents === true,
      includeRaw,
      includeStructuredPayload: params.includeStructuredPayload === true,
      maxTextChars: maxCharsPerMessage,
      maxPayloadChars: maxRawPayloadChars,
      maxTotalPayloadBytes: 256 * 1024,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return { ok: true, sessionId: sessionTarget.sessionId, ...page };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (message === 'invalid_cursor') {
      return { ok: false, errorCode: 'invalid_cursor', errorMessage: 'invalid_cursor' };
    }
    throw error;
  }
}
