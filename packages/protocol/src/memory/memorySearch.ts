import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactActionsV1.js';
import { PromptDocArtifactRefV1Schema } from '../prompts/library/promptArtifactRefsV1.js';
import { MemoryTopicSummaryV1Schema } from '../prompts/library/memoryDocV1.js';
import { RPC_ERROR_CODES, readRpcErrorCode } from '../rpc/errors.js';

export const MemorySearchScopeSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).passthrough(),
  z.object({ type: z.literal('session'), sessionId: z.string().min(1) }).passthrough(),
]));
export type MemorySearchScope = z.infer<typeof MemorySearchScopeSchema>;

/** Native identity is independent of any imported Happier Session or seq. */
export const MemoryExternalTranscriptSourceV1Schema = lazyZodSchema(() => z.object({
  type: z.literal('external_transcript'),
  agentId: z.string().min(1),
  sourceKey: z.string().min(1),
  nativeSessionId: z.string().min(1),
}).strict());
export const MemorySourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('happier_session'), sessionId: z.string().min(1) }).strict(),
  MemoryExternalTranscriptSourceV1Schema,
]));
export type MemorySourceV1 = z.infer<typeof MemorySourceV1Schema>;
export type MemoryExternalTranscriptSourceV1 = z.infer<typeof MemoryExternalTranscriptSourceV1Schema>;

export const MemoryExternalTranscriptSearchHitV1Schema = lazyZodSchema(() => z.object({
  type: z.literal('external_transcript'),
  source: MemoryExternalTranscriptSourceV1Schema,
  sourceItemId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  createdAtFromMs: z.number().int().nonnegative(),
  createdAtToMs: z.number().int().nonnegative(),
  summary: z.string().min(1),
  score: z.number().min(0).max(1),
}).strict().refine(value => value.createdAtFromMs <= value.createdAtToMs, {
  path: ['createdAtFromMs'], message: 'createdAtFromMs must be <= createdAtToMs',
}));
export type MemoryExternalTranscriptSearchHitV1 = z.infer<typeof MemoryExternalTranscriptSearchHitV1Schema>;

export const MemorySearchModeSchema = lazyZodSchema(() => z.enum(['hints', 'deep', 'auto']));
export type MemorySearchMode = z.infer<typeof MemorySearchModeSchema>;

// Stable error code vocabulary for memory RPC + action surfaces.
export const MemorySearchErrorCodeSchema = lazyZodSchema(() => z.enum([
  'memory_disabled',
  'memory_key_unavailable',
  'memory_index_missing',
  'memory_invalid_query',
  'memory_failed',
]));
export type MemorySearchErrorCode = z.infer<typeof MemorySearchErrorCodeSchema>;

export const MemoryCitationV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
}));
export type MemoryCitationV1 = z.infer<typeof MemoryCitationV1Schema>;

export const MemorySearchHitV1Schema = lazyZodSchema(() => z.object({
  // Released transcript hits are untagged. Never admit an artifact discriminator
  // as a passthrough annotation on an otherwise transcript-shaped row.
  type: z.never().optional(),
  sessionId: z.string().min(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
  createdAtFromMs: z.number().int().min(0),
  createdAtToMs: z.number().int().min(0),
  summary: z.string().min(1),
  score: z.number().min(0).max(1),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
  if (value.createdAtFromMs > value.createdAtToMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'createdAtFromMs must be <= createdAtToMs', path: ['createdAtFromMs'] });
  }
}));
export type MemorySearchHitV1 = z.infer<typeof MemorySearchHitV1Schema>;

/** Document navigation uses the Artifact revision and qualified address owners. */
export const MemoryDocumentSearchHitV1Schema = lazyZodSchema(() => z.object({
  type: z.literal('artifact'),
  ref: PromptDocArtifactRefV1Schema.extend({ serverId: z.string().min(1) }).strict(),
  revision: ArtifactRevisionV1Schema,
  location: z.union([
    z.enum(['facts', 'archive', 'document']),
    z.object({ type: z.literal('topic'), title: MemoryTopicSummaryV1Schema.shape.title }).strict(),
  ]),
  factId: z.string().min(1).optional(),
  summary: z.string().min(1),
  score: z.number().min(0).max(1),
}).strict());
export type MemoryDocumentSearchHitV1 = z.infer<typeof MemoryDocumentSearchHitV1Schema>;

export const MemorySearchResultHitV1Schema = lazyZodSchema(() => z.union([
  MemorySearchHitV1Schema,
  MemoryDocumentSearchHitV1Schema,
  MemoryExternalTranscriptSearchHitV1Schema,
]));
export type MemorySearchResultHitV1 = z.infer<typeof MemorySearchResultHitV1Schema>;

export function isMemoryDocumentSearchHitV1(hit: MemorySearchResultHitV1): hit is MemoryDocumentSearchHitV1 {
  return hit.type === 'artifact';
}

export function isMemoryExternalTranscriptSearchHitV1(hit: MemorySearchResultHitV1): hit is MemoryExternalTranscriptSearchHitV1 {
  return hit.type === 'external_transcript';
}

export function isMemorySessionSearchHitV1(hit: MemorySearchResultHitV1): hit is MemorySearchHitV1 {
  return hit.type === undefined;
}

export const MemorySearchCorpusV1Schema = lazyZodSchema(() => z.enum(['sessions', 'documents', 'external_transcripts']));
export type MemorySearchCorpusV1 = z.infer<typeof MemorySearchCorpusV1Schema>;

export const MemoryDocumentSearchCoverageV1Schema = lazyZodSchema(() => z.object({
  state: z.enum(['ready', 'pending', 'unavailable']),
}).strict());
export type MemoryDocumentSearchCoverageV1 = z.infer<typeof MemoryDocumentSearchCoverageV1Schema>;

/**
 * One shared query-length bound for every memory-search consumer (Home FTS route, daemon RPC,
 * and their UI/CLI adapters).
 *
 * Measured at the real Home FTS5 boundary on 2026-09-01: the term-per-query cost is superlinear
 * once a query stops being a query. 1,000 terms ran in 10ms and 10,000 terms in 289ms, but a
 * 50,000-term query blocked the synchronous SQLite call for 16.1s, and a 20,000-character CJK run
 * (which the index expands into overlapping unigrams/bigrams) blocked for 4.9s. A single
 * authenticated request must not be able to occupy the server that long, so the bound protects the
 * request path rather than expressing a product preference. 1,024 characters keeps the worst
 * observed shape (an all-CJK run, ~2 tokens per character) inside the cheap 10ms–300ms band while
 * staying far above any real search box input.
 */
export const MEMORY_SEARCH_QUERY_MAX_LENGTH = 1024;

export const MemorySearchQueryV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  query: z.string().min(1).max(MEMORY_SEARCH_QUERY_MAX_LENGTH),
  scope: MemorySearchScopeSchema,
  mode: MemorySearchModeSchema,
  /**
   * Omission retains the released Session-only contract. Documents are never
   * safely ignorable: callers first require documentSearchSupported === true
   * from this exact daemon, or report explicit unavailable document coverage.
   */
  corpora: z.array(MemorySearchCorpusV1Schema).min(1).optional(),
  /**
   * Optional caller-owned contextual eligibility. Current providers apply it
   * before their result limit. Absence preserves the released global/session
   * request semantics; older tolerant readers may ignore the additive field.
   */
  eligibleSessionIds: z.array(z.string().min(1)).optional(),
  /** Exact native History scope; the index applies it before ranking and paging. */
  externalSource: z.object({ agentId: z.string().min(1), sourceKey: z.string().min(1) }).strict().optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  minScore: z.number().min(0).max(1).optional(),
  cursor: z.string().min(1).optional(),
  createdAfterMs: z.number().int().nonnegative().optional(),
  createdBeforeMs: z.number().int().nonnegative().optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.createdAfterMs !== undefined && value.createdBeforeMs !== undefined && value.createdAfterMs > value.createdBeforeMs) {
    ctx.addIssue({ code: 'custom', path: ['createdAfterMs'], message: 'createdAfterMs must be <= createdBeforeMs' });
  }
}));
export type MemorySearchQueryV1 = z.infer<typeof MemorySearchQueryV1Schema>;

export const MemorySearchResultV1Schema = lazyZodSchema(() => z.union([
  z.object({
    v: z.literal(1),
    ok: z.literal(true),
    hits: z.array(MemorySearchResultHitV1Schema),
    documents: MemoryDocumentSearchCoverageV1Schema.optional(),
    nextCursor: z.string().min(1).optional(),
    hasMore: z.boolean().optional(),
  }).passthrough(),
  z.object({
    v: z.literal(1),
    ok: z.literal(false),
    errorCode: MemorySearchErrorCodeSchema,
    error: z.string().min(1),
  }).passthrough(),
]));
export type MemorySearchResultV1 = z.infer<typeof MemorySearchResultV1Schema>;

/** One mixed-version corpus policy; callbacks retain their exact authenticated target. */
export async function negotiateMemorySearchV1(params: Readonly<{
  query: MemorySearchQueryV1;
  readDocumentSearchSupport: () => Promise<boolean>;
  search: (query: MemorySearchQueryV1) => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<MemorySearchResultV1> {
  params.signal?.throwIfAborted();
  const documentsRequested = params.query.corpora?.includes('documents') === true;
  let documentSearchSupported = false;
  if (documentsRequested) {
    try {
      documentSearchSupported = await params.readDocumentSearchSupport() === true;
    } catch (error) {
      params.signal?.throwIfAborted();
      const code = readRpcErrorCode(error);
      if (code !== RPC_ERROR_CODES.METHOD_NOT_AVAILABLE && code !== RPC_ERROR_CODES.METHOD_NOT_FOUND) throw error;
    }
    params.signal?.throwIfAborted();
    if (!documentSearchSupported && !params.query.corpora?.includes('sessions')
      && !params.query.corpora?.includes('external_transcripts')) {
      return { v: 1, ok: true, hits: [], documents: { state: 'unavailable' } };
    }
  }
  const { corpora, ...legacyQuery } = params.query;
  const query = documentsRequested && !documentSearchSupported
    ? corpora?.includes('external_transcripts')
      ? { ...legacyQuery, corpora: corpora.filter(corpus => corpus !== 'documents') }
      : legacyQuery
    : params.query;
  const result = MemorySearchResultV1Schema.parse(await params.search(query));
  params.signal?.throwIfAborted();
  if (!result.ok || !corpora) return result;
  return {
    ...result,
    hits: result.hits.filter((hit) => isMemoryDocumentSearchHitV1(hit)
      ? documentSearchSupported
      : isMemoryExternalTranscriptSearchHitV1(hit)
        ? corpora?.includes('external_transcripts') === true
        : corpora?.includes('sessions') === true),
    ...(documentsRequested ? {
      documents: documentSearchSupported && result.documents ? result.documents : { state: 'unavailable' as const },
    } : {}),
  };
}
