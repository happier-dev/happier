import type { Credentials } from '@/persistence';

import { fetchTranscriptSemanticPage, type FetchTranscriptSemanticPageResult } from './transcript/fetchTranscriptSemanticPage';
import type { SemanticTranscriptItem, TranscriptDirection, TranscriptScope } from './transcript/semanticTranscriptItem';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type GetSessionTranscriptResult =
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

export async function getSessionTranscript(params: Readonly<{
  credentials: Credentials;
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
}>): Promise<GetSessionTranscriptResult> {
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
  const limit = clampInt(params.limit, { min: 1, max: 100, fallback: 20 });
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
