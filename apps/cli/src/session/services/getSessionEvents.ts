import type { StoredCredentials } from '@/persistence';

import { fetchTranscriptSemanticPage, type FetchTranscriptSemanticPageResult } from './transcript/fetchTranscriptSemanticPage';
import type {
  SemanticTranscriptItem,
  StoredTranscriptRole,
  TranscriptDirection,
  TranscriptScope,
} from './transcript/semanticTranscriptItem';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type GetSessionEventsResult =
  | Readonly<{
      ok: true;
      sessionId: string;
      items: readonly SemanticTranscriptItem[];
      nextCursor: string | null;
      hasMore: boolean;
      diagnostics: FetchTranscriptSemanticPageResult['diagnostics'];
    }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; candidates?: string[] }>;

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

function normalizeStoredRoles(value: readonly StoredTranscriptRole[] | undefined): readonly StoredTranscriptRole[] | undefined {
  if (!value) return undefined;
  return value.filter((role) => role === 'user' || role === 'agent' || role === 'event' || role === 'unknown');
}

export async function getSessionEvents(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  limit?: number;
  cursor?: string | null;
  direction?: TranscriptDirection;
  scope?: TranscriptScope;
  sidechainId?: string | null;
  roles?: readonly StoredTranscriptRole[];
  kinds?: readonly string[];
  format?: 'compact' | 'raw';
  includeMeta?: boolean;
  includeRaw?: boolean;
  includeStructuredPayload?: boolean;
  maxTextChars?: number;
  maxPayloadChars?: number;
}>): Promise<GetSessionEventsResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      errorCode: sessionTarget.code,
      errorMessage: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const roles = normalizeStoredRoles(params.roles);
  if (roles && roles.length === 0) {
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 0, scanLimitReached: false, payloadTruncations: 0 },
    };
  }

  const includeRaw = params.includeRaw === true || params.includeStructuredPayload === true || params.format === 'raw';
  const limit = includeRaw
    ? clampInt(params.limit, { min: 1, max: 50, fallback: 20 })
    : clampInt(params.limit, { min: 1, max: 200, fallback: 50 });
  const maxTextChars = clampInt(params.maxTextChars, { min: 0, max: 4000, fallback: 1000 });
  const maxPayloadChars = clampInt(params.maxPayloadChars, { min: 1, max: 32768, fallback: 8192 });

  try {
    const page = await fetchTranscriptSemanticPage({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      limit,
      rawPageLimit: includeRaw ? Math.min(50, limit) : Math.min(200, Math.max(limit, 50)),
      maxRawRowsToScan: Math.max(50, limit * 20),
      direction: normalizeDirection(params.direction),
      cursor: params.cursor ?? null,
      scope: normalizeScope(params.scope, 'all'),
      ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
      ...(roles ? { serverRoles: roles } : {}),
      mode: 'events',
      includeRaw,
      includeStructuredPayload: params.includeStructuredPayload === true || params.format === 'raw',
      ...(params.kinds ? { eventKinds: params.kinds } : {}),
      maxTextChars,
      maxPayloadChars,
      maxTotalPayloadBytes: 256 * 1024,
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
