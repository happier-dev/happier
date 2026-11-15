import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { RuntimeDescriptorV1Schema } from '../metadata/runtimeDescriptorV1.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { PluginAgentExternalSessionLinkDataSchema } from '../../plugins/contributions/agentExternalSessions.js';
import { readSessionInputPromptTitleTextV1 } from '../messages/sessionInputPromptContextV1.js';
import {
  ExternalSessionsAgentIdSchema,
  ExternalSessionsSourceSchema,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
} from './sourceCatalog.js';
import { ExternalSessionsRpcErrorCodeSchema } from './rpcErrorCodes.js';
import { ExternalAgentObservationSnapshotV1Schema } from './externalAgentObservationV1.js';
import {
  ExternalSessionsAutoLinkSourcePolicyIdV1Schema,
} from './followLifecycleV1.js';
import {
  LinkedExternalSessionQualifiedIdentityV1Schema,
} from './linkedSessionMetadata.js';
import {
  ExternalSessionRefreshCursorV1Schema,
  ExternalSessionRefreshReadDiagnosticV1Schema,
} from './secureRefreshV1.js';
import { createExternalSessionTranscriptSourceItemV1Schema, ExternalSessionTranscriptItemIdV1Schema, ExternalSessionTranscriptDisplayUserTextV1Schema } from './sourceTranscriptItemV1.js';

export {
  ExternalSessionsAgentIdSchema,
  ExternalSessionsSourceSchema,
};
export type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
};

export const ExternalSessionsSearchModeSchema = lazyZodSchema(() => z.enum(['fast', 'full']));
export type ExternalSessionsSearchMode = z.infer<typeof ExternalSessionsSearchModeSchema>;
export const ExternalSessionsSearchTargetSchema = lazyZodSchema(() => z.enum(['metadata', 'content']));
export type ExternalSessionsSearchTarget = z.infer<typeof ExternalSessionsSearchTargetSchema>;
export const ExternalSessionsContentCoverageSchema = lazyZodSchema(() => z.enum(['complete', 'partial', 'unsupported']));
export type ExternalSessionsContentCoverage = z.infer<typeof ExternalSessionsContentCoverageSchema>;

/** A decoded visible-text hit; the ordinal never substitutes for a Happier seq. */
export const ExternalSessionCandidateMatchV1Schema = lazyZodSchema(() => z.strictObject({
  snippet: z.string(),
  sourceItemId: ExternalSessionTranscriptItemIdV1Schema,
  messageIndex: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type ExternalSessionCandidateMatchV1 = z.infer<typeof ExternalSessionCandidateMatchV1Schema>;

function asRequestRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  const leftRecord = asRequestRecord(left);
  const rightRecord = asRequestRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key]),
    );
}

function normalizeReleasedExternalSessionRequest(
  value: unknown,
  options: Readonly<{
    runtimeDescriptor?: boolean;
    codexBackendMode?: boolean;
  }> = {},
): unknown {
  const record = asRequestRecord(value);
  if (!record) return value;
  const hasProviderId = Object.hasOwn(record, 'providerId');
  const hasAgentId = Object.hasOwn(record, 'agentId');
  const hasReleasedRuntimeDescriptor = Object.hasOwn(record, 'runtimeDescriptor');
  const hasCanonicalRuntimeDescriptor = Object.hasOwn(record, 'runtimeDescriptorV1');
  const hasReleasedCodexBackendMode = Object.hasOwn(record, 'codexBackendMode');
  if (hasReleasedCodexBackendMode && !options.codexBackendMode) return undefined;
  if (hasProviderId && hasAgentId) return undefined;
  // The released descriptor spelling existed only on provider-only link-ensure
  // requests; admitting it elsewhere would make strict current requests lossy.
  if (
    hasReleasedRuntimeDescriptor
    && (!options.runtimeDescriptor || !hasProviderId || hasCanonicalRuntimeDescriptor)
  ) {
    return undefined;
  }
  if (hasProviderId && hasCanonicalRuntimeDescriptor) return undefined;
  const releasedAgentId = hasProviderId
    ? ExternalSessionsAgentIdSchema.safeParse(record.providerId)
    : null;
  if (hasProviderId && !releasedAgentId?.success) return undefined;

  const {
    providerId: _releasedProviderId,
    runtimeDescriptor: _releasedRuntimeDescriptor,
    ...canonical
  } = record;
  const normalized: Record<string, unknown> = {
    ...canonical,
    ...(releasedAgentId?.success ? { agentId: releasedAgentId.data } : {}),
  };
  if (hasReleasedCodexBackendMode) {
    const normalizedAgentId = releasedAgentId?.success ? releasedAgentId.data : record.agentId;
    const mode = typeof record.codexBackendMode === 'string' ? record.codexBackendMode.trim() : '';
    if (normalizedAgentId !== 'codex' || !mode) return undefined;
    const existingLinkData = asRequestRecord(record.linkData);
    if (record.linkData !== undefined && !existingLinkData) return undefined;
    if (
      existingLinkData
      && Object.hasOwn(existingLinkData, 'codexBackendMode')
      && existingLinkData.codexBackendMode !== mode
    ) return undefined;
    delete normalized.codexBackendMode;
    normalized.linkData = {
      ...(existingLinkData ?? {}),
      codexBackendMode: mode,
    };
  }
  if (!hasReleasedRuntimeDescriptor) return normalized;

  const releasedDescriptor = RuntimeDescriptorV1Schema.safeParse(record.runtimeDescriptor);
  if (!releasedDescriptor.success) return undefined;
  if (Object.hasOwn(record, 'runtimeDescriptorV1')) {
    const canonicalDescriptor = RuntimeDescriptorV1Schema.safeParse(record.runtimeDescriptorV1);
    if (!canonicalDescriptor.success
      || !jsonValuesEqual(canonicalDescriptor.data, releasedDescriptor.data)) return undefined;
  }
  normalized.runtimeDescriptorV1 = releasedDescriptor.data;
  return normalized;
}

// Match the existing identity normalizer without erasing the schema's public
// input carrier to unknown. Parsing still owns all semantic validation.
type ExternalSessionRequestInput<TCanonical extends { agentId: ExternalSessionsAgentId }> =
  | (TCanonical & { providerId?: never })
  | (Omit<TCanonical, 'agentId'> & { providerId: TCanonical['agentId']; agentId?: never });

const ExternalSessionsCandidatesListCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  source: ExternalSessionsSourceSchema,
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
  searchTerm: z.optional(z.string().check(z.minLength(1), z.maxLength(2000))),
  searchMode: z.optional(ExternalSessionsSearchModeSchema),
  searchTarget: z.optional(ExternalSessionsSearchTargetSchema),
  /** Remaining caller scan budget at dispatch; expiry returns a partial content page. */
  budgetMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  /**
   * Include the Agent's internal threads (approval reviewers, spawned sub-agents). Absent: only
   * top-level sessions, which is also what a daemon that predates the field lists.
   */
  includeThreads: z.optional(z.boolean()),
}));

type ExternalSessionsCandidatesListInput = ExternalSessionRequestInput<z.input<typeof ExternalSessionsCandidatesListCanonicalRequestSchema>>;

export const ExternalSessionsCandidatesListRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionsCandidatesListInput, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionsCandidatesListCanonicalRequestSchema));
export type ExternalSessionsCandidatesListRequest = z.infer<typeof ExternalSessionsCandidatesListRequestSchema>;

export const ExternalSessionsAutoLinkPolicyScopeV1Schema = lazyZodSchema(() => z.strictObject({
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  sourcePolicyId: ExternalSessionsAutoLinkSourcePolicyIdV1Schema,
}));
export type ExternalSessionsAutoLinkPolicyScopeV1 = z.infer<
  typeof ExternalSessionsAutoLinkPolicyScopeV1Schema
>;

/**
 * Destructive candidate operations the listing that produced these rows proved
 * available on its own connection to the Agent. This is a capability fact about
 * that listing, never a durable Agent property: the daemon re-checks it at the
 * real boundary before it acts.
 */
export const ExternalSessionsCandidateCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  deleteCandidate: z.boolean(),
}));
export type ExternalSessionsCandidateCapabilitiesV1 = z.infer<
  typeof ExternalSessionsCandidateCapabilitiesV1Schema
>;

export const ExternalSessionsCandidatesListResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      candidates: z.array(z.lazy(() => ExternalSessionCandidateV1Schema)),
      nextCursor: z.nullish(z.string().check(z.minLength(1))),
      searchIncomplete: z.optional(z.boolean()),
      contentCoverage: z.optional(ExternalSessionsContentCoverageSchema),
      contentCoverageReason: z.optional(z.literal('standard_search_disabled')),
      /**
       * Positive `linkedSessionId` / `imported` projections are present when
       * known. When this is true, omitted projections are not a negative fact:
       * the bounded canonical Session scan did not cover every matching owner
       * record.
       */
      annotationsIncomplete: z.optional(z.boolean()),
      /**
       * The continuation cursor the request carried can no longer address a
       * page: the Agent no longer recognises it, or it was minted by the
       * retired candidate index. This is not a listing failure
       * and not an empty last page — the only recovery is to drop that
       * continuation and rebuild the listing from the root, so retrying the
       * same cursor can never succeed. Rows already on screen stay visible but
       * stop being authoritative until the rebuild publishes.
       */
      cursorReset: z.optional(z.boolean()),
      autoLinkPolicyScopeV1: z.optional(ExternalSessionsAutoLinkPolicyScopeV1Schema),
      /**
       * Absence is not a negative fact a caller may invert into an offer: only
       * an explicit capability advertises a destructive candidate affordance.
       */
      capabilities: z.optional(ExternalSessionsCandidateCapabilitiesV1Schema),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
      // Older producers omit the hint; explicit user retries remain available.
      retryable: z.optional(z.boolean()),
    }).check(z.refine((value) => !Object.hasOwn(value, 'autoLinkPolicyScopeV1'), {
      message: 'Auto-link policy scope is available only on successful candidate-list responses.',
      path: ['autoLinkPolicyScopeV1'],
    })),
]));
export type ExternalSessionsCandidatesListResponse = z.infer<typeof ExternalSessionsCandidatesListResponseSchema>;

/**
 * Delete one Agent-owned session a resume-only listing surfaced. The Happier
 * Session store is untouched: this is the Agent's own record, addressed by the
 * opaque identifier the listing handed out, so the id crosses the wire verbatim.
 */
const ExternalSessionCandidateDeleteCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  source: ExternalSessionsSourceSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
}));

type ExternalSessionCandidateDeleteInput = ExternalSessionRequestInput<z.input<typeof ExternalSessionCandidateDeleteCanonicalRequestSchema>>;

/**
 * Released `daemon.directSessions.candidate.delete` callers name the Agent
 * `providerId`; they reach this same canonical reader through the one shared
 * released-identity normalization its siblings use. Normalization touches
 * request identity only — `remoteSessionId` stays byte-exact.
 */
export const ExternalSessionCandidateDeleteRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionCandidateDeleteInput, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionCandidateDeleteCanonicalRequestSchema));
export type ExternalSessionCandidateDeleteRequest = z.infer<
  typeof ExternalSessionCandidateDeleteRequestSchema
>;

export const ExternalSessionCandidateDeleteResponseSchema = lazyZodSchema(() => z.union([
  // `deleted` is a literal: an outcome the Agent did not commit must never
  // reach a caller as a successful deletion it can act on.
  z.looseObject({ ok: z.literal(true), deleted: z.literal(true) }),
  z.looseObject({
    ok: z.literal(false),
    errorCode: ExternalSessionsRpcErrorCodeSchema,
    error: z.string().check(z.minLength(1)),
  }),
]));
export type ExternalSessionCandidateDeleteResponse = z.infer<
  typeof ExternalSessionCandidateDeleteResponseSchema
>;

const ExternalSessionLinkEnsureCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
  titleHint: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  directoryHint: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
  linkData: z.optional(PluginAgentExternalSessionLinkDataSchema),
  source: ExternalSessionsSourceSchema,
}));

type ExternalSessionLinkEnsureCanonicalInput = z.input<typeof ExternalSessionLinkEnsureCanonicalRequestSchema>;
type ExternalSessionLinkEnsureInput = (
  | (ExternalSessionLinkEnsureCanonicalInput & { providerId?: never; runtimeDescriptor?: never })
  | (Omit<ExternalSessionLinkEnsureCanonicalInput, 'agentId' | 'runtimeDescriptorV1'> & {
    providerId: ExternalSessionLinkEnsureCanonicalInput['agentId'];
    agentId?: never;
    runtimeDescriptor?: z.input<typeof RuntimeDescriptorV1Schema>;
    runtimeDescriptorV1?: never;
  })
) & { codexBackendMode?: string };

export const ExternalSessionLinkEnsureRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionLinkEnsureInput, unknown>((value) => normalizeReleasedExternalSessionRequest(value, {
    runtimeDescriptor: true,
    codexBackendMode: true,
  })), ExternalSessionLinkEnsureCanonicalRequestSchema));
export type ExternalSessionLinkEnsureRequest = z.infer<typeof ExternalSessionLinkEnsureRequestSchema>;


export const ExternalSessionLinkEnsureResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      sessionId: z.string().check(z.minLength(1)),
      created: z.boolean(),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionLinkEnsureResponse = z.infer<typeof ExternalSessionLinkEnsureResponseSchema>;

export const ExternalSessionActivityV1Schema = lazyZodSchema(() => z.enum(['running', 'active_recently', 'idle', 'unknown']));
export type ExternalSessionActivityV1 = z.infer<typeof ExternalSessionActivityV1Schema>;

export const MAX_EXTERNAL_SESSION_CANDIDATE_TITLE_CODE_UNITS = 10_000;

/** Preserve a usable candidate when native title text exceeds its existing wire field. */
export function projectExternalSessionCandidateTitle(title: string, options?: Readonly<{ source: 'prompt' }>): string {
  if (options?.source === 'prompt') title = readSessionInputPromptTitleTextV1(title);
  if (title.length <= MAX_EXTERNAL_SESSION_CANDIDATE_TITLE_CODE_UNITS) return title;
  const prefix = title.slice(0, MAX_EXTERNAL_SESSION_CANDIDATE_TITLE_CODE_UNITS - 3)
    .replace(/[\uD800-\uDBFF]$/, '');
  return `${prefix}...`;
}

/**
 * An Agent's internal thread rather than a session a person started: an approval reviewer judging
 * another thread's action, or a sub-agent a session spawned. Classified by the Agent's own
 * projection from its native markers; absent means a top-level session.
 */
export const ExternalSessionCandidateThreadV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['reviewer', 'subagent']),
  /** The thread that spawned or is reviewed by this one, when the Agent records it. */
  parentRemoteSessionId: z.nullable(NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000))),
  /** The parent's title, when the Agent's index knows it without an extra read. */
  parentTitle: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_EXTERNAL_SESSION_CANDIDATE_TITLE_CODE_UNITS))),
}));
export type ExternalSessionCandidateThreadV1 = z.infer<typeof ExternalSessionCandidateThreadV1Schema>;

export const ExternalSessionCandidateV1Schema = lazyZodSchema(() => z.looseObject({
    remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
    candidateKey: z.optional(z.string().check(z.minLength(1), z.maxLength(128))),
    title: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_EXTERNAL_SESSION_CANDIDATE_TITLE_CODE_UNITS))),
    cwd: z.optional(z.string().check(z.minLength(1))),
    messageCount: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
    updatedAtMs: z.number().check(z.int(), z.minimum(0)),
    createdAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    activity: z.optional(ExternalSessionActivityV1Schema),
    archived: z.optional(z.boolean()),
    details: z.optional(z.looseObject({})),
    linkData: z.optional(PluginAgentExternalSessionLinkDataSchema),
    linkedSessionId: z.optional(z.string().check(z.minLength(1), z.maxLength(2000))),
    imported: z.optional(z.boolean()),
    materializedThrough: z.optional(z.number().check(z.int(), z.minimum(0))),
    thread: z.optional(ExternalSessionCandidateThreadV1Schema),
    match: z.optional(ExternalSessionCandidateMatchV1Schema),
  }));
export type ExternalSessionCandidateV1 = z.infer<typeof ExternalSessionCandidateV1Schema>;

const ExternalSessionStatusGetCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  sessionId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
  source: ExternalSessionsSourceSchema,
}));

export const ExternalSessionStatusGetRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionRequestInput<z.input<typeof ExternalSessionStatusGetCanonicalRequestSchema>>, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionStatusGetCanonicalRequestSchema));
export type ExternalSessionStatusGetRequest = z.infer<typeof ExternalSessionStatusGetRequestSchema>;

const ExternalSessionAttachCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  sessionId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
  source: ExternalSessionsSourceSchema,
  leaseId: z.optional(z.string().check(z.minLength(1), z.maxLength(2000))),
  ttlMs: z.optional(z.number().check(z.int(), z.minimum(1_000), z.maximum(15 * 60_000))),
  acceptedTailCursor: z.optional(ExternalSessionRefreshCursorV1Schema),
}));

export const ExternalSessionAttachRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionRequestInput<z.input<typeof ExternalSessionAttachCanonicalRequestSchema>>, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionAttachCanonicalRequestSchema));
export type ExternalSessionAttachRequest = z.infer<typeof ExternalSessionAttachRequestSchema>;

export const ExternalSessionAttachResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      leaseId: z.string().check(z.minLength(1)),
      expiresAtMs: z.number().check(z.int(), z.minimum(0)),
      renewed: z.optional(z.boolean()),
      acceptedTailCursor: z.optional(ExternalSessionRefreshCursorV1Schema),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
      /**
       * Whether re-attaching can plausibly succeed. The daemon classifies the
       * corridor failure once; a viewer must not poll a failure it already
       * knows is terminal. Released producers omit it — absent stays retryable.
       */
      retryable: z.optional(z.boolean()),
    }),
]));
export type ExternalSessionAttachResponse = z.infer<typeof ExternalSessionAttachResponseSchema>;

export const ExternalSessionDetachRequestSchema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.minLength(1)),
    sessionId: z.string().check(z.minLength(1)),
    leaseId: z.string().check(z.minLength(1), z.maxLength(2000)),
  }));
export type ExternalSessionDetachRequest = z.infer<typeof ExternalSessionDetachRequestSchema>;

export const ExternalSessionDetachResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      detached: z.boolean(),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionDetachResponse = z.infer<typeof ExternalSessionDetachResponseSchema>;

const ExternalSessionFollowPolicySetCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  sessionId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
  source: ExternalSessionsSourceSchema,
  enabled: z.boolean(),
}));

export const ExternalSessionFollowPolicySetRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionRequestInput<z.input<typeof ExternalSessionFollowPolicySetCanonicalRequestSchema>>, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionFollowPolicySetCanonicalRequestSchema));
export type ExternalSessionFollowPolicySetRequest = z.infer<typeof ExternalSessionFollowPolicySetRequestSchema>;

export const ExternalSessionFollowPolicySetResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      enabled: z.boolean(),
      leaseActive: z.boolean(),
      updatedAtMs: z.number().check(z.int(), z.minimum(0)),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionFollowPolicySetResponse = z.infer<typeof ExternalSessionFollowPolicySetResponseSchema>;

export const ExternalSessionStatusGetResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      machineOnline: z.boolean(),
      runnerActive: z.boolean(),
      activity: ExternalSessionActivityV1Schema,
      canTakeOverDirect: z.boolean(),
      canTakeOverPersist: z.boolean(),
      canForceStop: z.boolean(),
      trustedPid: z.nullish(z.number().check(z.int(), z.minimum(1))),
      lastKnownActivityAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
      externalAgent: z.optional(z.nullable(ExternalAgentObservationSnapshotV1Schema)),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionStatusGetResponse = z.infer<typeof ExternalSessionStatusGetResponseSchema>;

const ExternalSessionActionSessionIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(191), z.refine((value) => value === value.trim(), 'Session id must already be trimmed.')));
const ExternalSessionActionLeaseIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(2_000), z.refine((value) => value === value.trim(), 'Lease id must already be trimmed.')));
export const ExternalSessionStatusActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: ExternalSessionActionSessionIdSchema,
}));

export const ExternalSessionViewerFollowActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: ExternalSessionActionSessionIdSchema,
  leaseId: z.optional(ExternalSessionActionLeaseIdSchema),
  ttlMs: z.optional(z.number().check(z.int(), z.minimum(1_000), z.maximum(15 * 60_000))),
  acceptedTailCursor: z.optional(ExternalSessionRefreshCursorV1Schema),
}));

export const ExternalSessionViewerUnfollowActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: ExternalSessionActionSessionIdSchema,
  leaseId: ExternalSessionActionLeaseIdSchema,
}));

export const ExternalSessionBackgroundFollowActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: ExternalSessionActionSessionIdSchema,
  enabled: z.boolean(),
}));

const ExternalSessionActionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: ExternalSessionsRpcErrorCodeSchema,
  error: z.string().check(z.minLength(1), z.maxLength(2_000)),
}));

export const ExternalSessionStatusActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    machineOnline: z.boolean(),
    runnerActive: z.boolean(),
    activity: ExternalSessionActivityV1Schema,
    canTakeOverDirect: z.boolean(),
    canTakeOverPersist: z.boolean(),
    canForceStop: z.boolean(),
    lastKnownActivityAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
  }),
  ExternalSessionActionFailureV1Schema,
]));

/**
 * A follow lease is the one External Session result its caller re-requests on a
 * timer, so the daemon's terminal classification travels to the public surface
 * too — otherwise a plugin polls a failure the daemon already answered forever.
 * Released daemons omit it; absent stays retryable.
 */
const ExternalSessionViewerFollowActionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: ExternalSessionsRpcErrorCodeSchema,
  error: z.string().check(z.minLength(1), z.maxLength(2_000)),
  retryable: z.optional(z.boolean()),
}));

export const ExternalSessionViewerFollowActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    leaseId: ExternalSessionActionLeaseIdSchema,
    expiresAtMs: z.number().check(z.int(), z.minimum(0)),
    renewed: z.boolean(),
    acceptedTailCursor: z.optional(ExternalSessionRefreshCursorV1Schema),
  }),
  ExternalSessionViewerFollowActionFailureV1Schema,
]));

export const ExternalSessionViewerUnfollowActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    detached: z.boolean(),
  }),
  ExternalSessionActionFailureV1Schema,
]));

export const ExternalSessionBackgroundFollowActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    enabled: z.boolean(),
    leaseActive: z.boolean(),
    updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  }),
  ExternalSessionActionFailureV1Schema,
]));

export const ExternalSessionTranscriptRawMessageV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(createExternalSessionTranscriptSourceItemV1Schema({
    identifier: z.string().check(z.minLength(1)),
    /**
     * Historical-import and recipient-read wire carrier. Current Agent
     * contributions use AgentExternalSessionTranscriptRawRecord instead; this
     * retained compatibility reader never authorizes a user row as terminal
     * input by itself.
     */
    raw: z.looseObject({}),
  }), {
    /** Host-derived presentation only; raw remains the native/import/input authority. */
    displayUserText: z.optional(ExternalSessionTranscriptDisplayUserTextV1Schema),
  })));
export type ExternalSessionTranscriptRawMessageV1 = z.infer<typeof ExternalSessionTranscriptRawMessageV1Schema>;

const ExternalSessionTranscriptPageCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
  source: ExternalSessionsSourceSchema,
  /** Selected preview item; safely ignorable and never a completeness claim. */
  sourceItemId: z.optional(ExternalSessionTranscriptItemIdV1Schema),
  direction: z.enum(['older', 'newer']),
  cursor: z.optional(z.string().check(z.minLength(1))),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(10 * 1024 * 1024))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(5000))),
}));

export const ExternalSessionTranscriptPageRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionRequestInput<z.input<typeof ExternalSessionTranscriptPageCanonicalRequestSchema>>, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionTranscriptPageCanonicalRequestSchema));
export type ExternalSessionTranscriptPageRequest = z.infer<typeof ExternalSessionTranscriptPageRequestSchema>;

export const ExternalSessionTranscriptPageResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      items: z.array(ExternalSessionTranscriptRawMessageV1Schema),
      nextCursor: z.nullish(z.string().check(z.minLength(1))),
      tailCursor: z.nullish(z.string().check(z.minLength(1))),
      hasMore: z.boolean(),
      truncated: z.optional(z.boolean()),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionTranscriptPageResponse = z.infer<typeof ExternalSessionTranscriptPageResponseSchema>;

const ExternalSessionTranscriptReadAfterCanonicalRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: NonBlankOpaqueIdentifierSchema.check(z.maxLength(2000)),
  source: ExternalSessionsSourceSchema,
  cursor: z.string().check(z.minLength(1)),
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(10 * 1024 * 1024))),
  maxItems: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(5000))),
}));

export const ExternalSessionTranscriptReadAfterRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform<ExternalSessionRequestInput<z.input<typeof ExternalSessionTranscriptReadAfterCanonicalRequestSchema>>, unknown>((value) => normalizeReleasedExternalSessionRequest(value)), ExternalSessionTranscriptReadAfterCanonicalRequestSchema));
export type ExternalSessionTranscriptReadAfterRequest = z.infer<typeof ExternalSessionTranscriptReadAfterRequestSchema>;

export const ExternalSessionTranscriptReadAfterResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      items: z.array(ExternalSessionTranscriptRawMessageV1Schema),
      nextCursor: z.nullish(z.string().check(z.minLength(1))),
      truncated: z.boolean(),
      // Additive rich read-after continuation facts (open/drop for released
      // readers). Released daemons never emit them; the current UI applies
      // the shared Protocol read-after decision when present and degrades to
      // the released lossy semantics when absent.
      hasMore: z.optional(z.boolean()),
      diagnostics: z.optional(z.array(
        ExternalSessionRefreshReadDiagnosticV1Schema,
      ).check(z.maxLength(32))),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionTranscriptReadAfterResponse = z.infer<typeof ExternalSessionTranscriptReadAfterResponseSchema>;
