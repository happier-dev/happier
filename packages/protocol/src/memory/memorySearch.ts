import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactActionsV1.js';
import { PromptDocArtifactRefV1Schema } from '../prompts/library/promptArtifactRefsV1.js';
import { MemoryTopicSummaryV1Schema } from '../prompts/library/memoryDocV1.js';
import { isRpcMethodNotFoundError } from '../rpc/errors.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';

export const MemorySearchScopeSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('global') }),
  z.looseObject({ type: z.literal('session'), sessionId: z.string().check(z.minLength(1)) }),
  z.strictObject({ type: z.literal('project'), projectRef: QualifiedProjectKeyV1Schema }),
]));
export type MemorySearchScope = z.infer<typeof MemorySearchScopeSchema>;

/** Native identity is independent of any imported Happier Session or seq. */
export const MemoryExternalTranscriptSourceV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('external_transcript'),
  agentId: z.string().check(z.minLength(1)),
  sourceKey: z.string().check(z.minLength(1)),
  nativeSessionId: z.string().check(z.minLength(1)),
}));
export const MemorySourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('happier_session'), sessionId: z.string().check(z.minLength(1)) }),
  MemoryExternalTranscriptSourceV1Schema,
]));
export type MemorySourceV1 = z.infer<typeof MemorySourceV1Schema>;
export type MemoryExternalTranscriptSourceV1 = z.infer<typeof MemoryExternalTranscriptSourceV1Schema>;

export const MemoryExternalTranscriptSearchHitV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('external_transcript'),
  source: MemoryExternalTranscriptSourceV1Schema,
  sourceItemId: z.string().check(z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1))),
  createdAtFromMs: z.number().check(z.int(), z.nonnegative()),
  createdAtToMs: z.number().check(z.int(), z.nonnegative()),
  summary: z.string().check(z.minLength(1)),
  score: z.number().check(z.minimum(0), z.maximum(1)),
}).check(z.refine(value => value.createdAtFromMs <= value.createdAtToMs, {
  path: ['createdAtFromMs'], message: 'createdAtFromMs must be <= createdAtToMs',
})));
export type MemoryExternalTranscriptSearchHitV1 = z.infer<typeof MemoryExternalTranscriptSearchHitV1Schema>;

export const MemorySearchModeSchema = lazyZodSchema(() => z.enum(['hints', 'deep', 'auto']));
export type MemorySearchMode = z.infer<typeof MemorySearchModeSchema>;

// Stable error code vocabulary for memory RPC + action surfaces.
export const MemorySearchErrorCodeSchema = lazyZodSchema(() => z.enum([
  'memory_disabled',
  'memory_key_unavailable',
  'memory_index_missing',
  'memory_invalid_query',
  'memory_project_scope_unsupported',
  'memory_failed',
]));
export type MemorySearchErrorCode = z.infer<typeof MemorySearchErrorCodeSchema>;

export const MemoryCitationV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  seqFrom: z.number().check(z.int(), z.minimum(0)),
  seqTo: z.number().check(z.int(), z.minimum(0)),
}).check(z.superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: "custom", message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
})));
export type MemoryCitationV1 = z.infer<typeof MemoryCitationV1Schema>;

export const MemorySearchHitV1Schema = lazyZodSchema(() => z.looseObject({
  // Released transcript hits are untagged. Never admit an artifact discriminator
  // as a passthrough annotation on an otherwise transcript-shaped row.
  type: z.optional(z.never()),
  sessionId: z.string().check(z.minLength(1)),
  seqFrom: z.number().check(z.int(), z.minimum(0)),
  seqTo: z.number().check(z.int(), z.minimum(0)),
  createdAtFromMs: z.number().check(z.int(), z.minimum(0)),
  createdAtToMs: z.number().check(z.int(), z.minimum(0)),
  summary: z.string().check(z.minLength(1)),
  score: z.number().check(z.minimum(0), z.maximum(1)),
}).check(z.superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: "custom", message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
  if (value.createdAtFromMs > value.createdAtToMs) {
    ctx.addIssue({ code: "custom", message: 'createdAtFromMs must be <= createdAtToMs', path: ['createdAtFromMs'] });
  }
})));
export type MemorySearchHitV1 = z.infer<typeof MemorySearchHitV1Schema>;

/** Document navigation uses the Artifact revision and qualified address owners. */
export const MemoryDocumentSearchHitV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('artifact'),
  ref: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PromptDocArtifactRefV1Schema, { serverId: z.string().check(z.minLength(1)) })),
  revision: ArtifactRevisionV1Schema,
  location: z.union([
    z.enum(['facts', 'archive', 'document']),
    z.strictObject({ type: z.literal('topic'), title: MemoryTopicSummaryV1Schema.shape.title }),
  ]),
  factId: z.optional(z.string().check(z.minLength(1))),
  summary: z.string().check(z.minLength(1)),
  score: z.number().check(z.minimum(0), z.maximum(1)),
}));
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

export const MemoryDocumentSearchCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['ready', 'pending', 'partial', 'unavailable']),
}));
export type MemoryDocumentSearchCoverageV1 = z.infer<typeof MemoryDocumentSearchCoverageV1Schema>;

export const MemoryProjectSearchCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['ready', 'partial', 'unavailable']),
}));
export type MemoryProjectSearchCoverageV1 = z.infer<typeof MemoryProjectSearchCoverageV1Schema>;

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

export const MemorySearchQueryV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  query: z.string().check(z.minLength(1), z.maxLength(MEMORY_SEARCH_QUERY_MAX_LENGTH)),
  scope: MemorySearchScopeSchema,
  mode: MemorySearchModeSchema,
  /**
   * Omission retains the released Session-only contract for global/Session
   * scope; new Project scope searches Sessions and attached documents. Documents are never
   * safely ignorable: callers first require documentSearchSupported === true
   * from this exact daemon, or report explicit unavailable document coverage.
   */
  corpora: z.optional(z.array(MemorySearchCorpusV1Schema).check(z.minLength(1))),
  /**
   * Optional caller-owned contextual eligibility. Current providers apply it
   * before their result limit. Absence preserves the released global/session
   * request semantics; older tolerant readers may ignore the additive field.
   */
  eligibleSessionIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  /** Exact native History scope; the index applies it before ranking and paging. */
  externalSource: z.optional(z.strictObject({ agentId: z.string().check(z.minLength(1)), sourceKey: z.string().check(z.minLength(1)) })),
  maxResults: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  minScore: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
  cursor: z.optional(z.string().check(z.minLength(1))),
  createdAfterMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  createdBeforeMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}).check(z.superRefine((value, ctx) => {
  if (value.createdAfterMs !== undefined && value.createdBeforeMs !== undefined && value.createdAfterMs > value.createdBeforeMs) {
    ctx.addIssue({ code: 'custom', path: ['createdAfterMs'], message: 'createdAfterMs must be <= createdBeforeMs' });
  }
})));
export type MemorySearchQueryV1 = z.infer<typeof MemorySearchQueryV1Schema>;

const SESSION_SEARCH_CORPORA: readonly MemorySearchCorpusV1[] = ['sessions'];
const PROJECT_SEARCH_CORPORA: readonly MemorySearchCorpusV1[] = ['sessions', 'documents'];

/** Shared by direct daemon ingress and negotiated clients; omission is scope-specific. */
export function resolveMemorySearchCorporaV1(
  query: Pick<MemorySearchQueryV1, 'scope' | 'corpora'>,
): readonly MemorySearchCorpusV1[] {
  return query.corpora ?? (query.scope.type === 'project' ? PROJECT_SEARCH_CORPORA : SESSION_SEARCH_CORPORA);
}

export const MemorySearchResultV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
    v: z.literal(1),
    ok: z.literal(true),
    hits: z.array(MemorySearchResultHitV1Schema),
    documents: z.optional(MemoryDocumentSearchCoverageV1Schema),
    project: z.optional(MemoryProjectSearchCoverageV1Schema),
    nextCursor: z.optional(z.string().check(z.minLength(1))),
    hasMore: z.optional(z.boolean()),
  }),
  z.looseObject({
    v: z.literal(1),
    ok: z.literal(false),
    errorCode: MemorySearchErrorCodeSchema,
    error: z.string().check(z.minLength(1)),
  }),
]));
export type MemorySearchResultV1 = z.infer<typeof MemorySearchResultV1Schema>;

/** One mixed-version corpus policy; callbacks retain their exact authenticated target. */
export async function negotiateMemorySearchV1(params: Readonly<{
  query: MemorySearchQueryV1;
  readDocumentSearchSupport: () => Promise<boolean>;
  readProjectSearchSupport?: () => Promise<boolean>;
  search: (query: MemorySearchQueryV1) => Promise<unknown>;
  signal?: AbortSignal;
}>): Promise<MemorySearchResultV1> {
  params.signal?.throwIfAborted();
  const requestedQuery: MemorySearchQueryV1 = params.query.scope.type === 'project' && params.query.corpora === undefined
    ? { ...params.query, corpora: [...resolveMemorySearchCorporaV1(params.query)] } : params.query;
  if (requestedQuery.scope.type === 'project') {
    let supported = false;
    try {
      supported = await params.readProjectSearchSupport?.() === true;
    } catch (error) {
      params.signal?.throwIfAborted();
      if (!isRpcMethodNotFoundError(error)) throw error;
    }
    params.signal?.throwIfAborted();
    if (!supported) return { v: 1, ok: false, errorCode: 'memory_project_scope_unsupported',
      error: 'Project memory search is unsupported by this daemon.' };
  }
  const documentsRequested = requestedQuery.corpora?.includes('documents') === true;
  let documentSearchSupported = false;
  if (documentsRequested) {
    try {
      documentSearchSupported = await params.readDocumentSearchSupport() === true;
    } catch (error) {
      params.signal?.throwIfAborted();
      if (!isRpcMethodNotFoundError(error)) throw error;
    }
    params.signal?.throwIfAborted();
    if (!documentSearchSupported && !requestedQuery.corpora?.includes('sessions')
      && !requestedQuery.corpora?.includes('external_transcripts')) {
      return { v: 1, ok: true, hits: [], documents: { state: 'unavailable' },
        ...(requestedQuery.scope.type === 'project' ? { project: { state: 'unavailable' as const } } : {}) };
    }
  }
  const { corpora, ...legacyQuery } = requestedQuery;
  const query = documentsRequested && !documentSearchSupported
    ? requestedQuery.scope.type === 'project' || corpora?.includes('external_transcripts')
      ? { ...legacyQuery, corpora: resolveMemorySearchCorporaV1(requestedQuery).filter(corpus => corpus !== 'documents') }
      : legacyQuery
    : requestedQuery;
  const result = MemorySearchResultV1Schema.parse(await params.search(query));
  params.signal?.throwIfAborted();
  if (!result.ok) return result;
  const scopedResult = requestedQuery.scope.type === 'project'
    ? { ...result, project: result.project ?? { state: 'unavailable' as const } }
    : result;
  if (!corpora) return scopedResult;
  return {
    ...scopedResult,
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
