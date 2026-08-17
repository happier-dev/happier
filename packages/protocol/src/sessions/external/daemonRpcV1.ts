import { z } from 'zod';

import { RuntimeDescriptorV1Schema } from '../metadata/runtimeDescriptorV1.js';
import { PluginAgentExternalSessionLinkDataSchema } from '../../plugins/contributions/agentExternalSessions.js';
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
import { ExternalSessionRefreshCursorV1Schema } from './secureRefreshV1.js';
import { createExternalSessionTranscriptSourceItemV1Schema } from './sourceTranscriptItemV1.js';

export {
  ExternalSessionsAgentIdSchema,
  ExternalSessionsSourceSchema,
};
export type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
};

export const ExternalSessionsSearchModeSchema = z.enum(['fast', 'full']);
export type ExternalSessionsSearchMode = z.infer<typeof ExternalSessionsSearchModeSchema>;

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
  options: Readonly<{ runtimeDescriptor?: boolean }> = {},
): unknown {
  const record = asRequestRecord(value);
  if (!record) return value;
  const hasProviderId = Object.hasOwn(record, 'providerId');
  const hasAgentId = Object.hasOwn(record, 'agentId');
  const hasReleasedRuntimeDescriptor = Object.hasOwn(record, 'runtimeDescriptor');
  const hasCanonicalRuntimeDescriptor = Object.hasOwn(record, 'runtimeDescriptorV1');
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

export const ExternalSessionsCandidatesListRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value),
  z.object({
    machineId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    source: ExternalSessionsSourceSchema,
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    searchTerm: z.string().min(1).max(2000).optional(),
    searchMode: ExternalSessionsSearchModeSchema.optional(),
  }).strict(),
);
export type ExternalSessionsCandidatesListRequest = z.infer<typeof ExternalSessionsCandidatesListRequestSchema>;

export const ExternalSessionsCandidatePreparationSchema = z
  .object({
    kind: z.literal('building_candidate_index'),
    scanned: z.number().int().min(0),
    total: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((value) => value.total === undefined || value.total >= value.scanned, {
    message: 'Candidate-index preparation total must be at least scanned',
  });
export type ExternalSessionsCandidatePreparation = z.infer<typeof ExternalSessionsCandidatePreparationSchema>;

export const ExternalSessionsAutoLinkPolicyScopeV1Schema = z.object({
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  sourcePolicyId: ExternalSessionsAutoLinkSourcePolicyIdV1Schema,
}).strict();
export type ExternalSessionsAutoLinkPolicyScopeV1 = z.infer<
  typeof ExternalSessionsAutoLinkPolicyScopeV1Schema
>;

export const ExternalSessionsCandidatesListResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      candidates: z.array(z.lazy(() => ExternalSessionCandidateV1Schema)),
      nextCursor: z.string().min(1).nullish(),
      searchIncomplete: z.boolean().optional(),
      /**
       * Positive `linkedSessionId` / `imported` projections are present when
       * known. When this is true, omitted projections are not a negative fact:
       * the bounded canonical Session scan or candidate preparation did not
       * cover every matching owner record.
       */
      annotationsIncomplete: z.boolean().optional(),
      preparation: ExternalSessionsCandidatePreparationSchema.optional(),
      autoLinkPolicyScopeV1: ExternalSessionsAutoLinkPolicyScopeV1Schema.optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough()
    .refine((value) => !Object.hasOwn(value, 'autoLinkPolicyScopeV1'), {
      message: 'Auto-link policy scope is available only on successful candidate-list responses.',
      path: ['autoLinkPolicyScopeV1'],
    }),
]);
export type ExternalSessionsCandidatesListResponse = z.infer<typeof ExternalSessionsCandidatesListResponseSchema>;

export const ExternalSessionLinkEnsureRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value, { runtimeDescriptor: true }),
  z.object({
    machineId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    titleHint: z.string().min(1).max(10_000).optional(),
    directoryHint: z.string().min(1).max(10_000).optional(),
    // Shared wire parsing stays forward-compatible; the Codex plugin validates this in resolveLinkIdentity.
    codexBackendMode: z.string().optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
    source: ExternalSessionsSourceSchema,
  }).strict(),
);
export type ExternalSessionLinkEnsureRequest = z.infer<typeof ExternalSessionLinkEnsureRequestSchema>;


export const ExternalSessionLinkEnsureResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      sessionId: z.string().min(1),
      created: z.boolean(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionLinkEnsureResponse = z.infer<typeof ExternalSessionLinkEnsureResponseSchema>;

export const ExternalSessionActivityV1Schema = z.enum(['running', 'active_recently', 'idle', 'unknown']);
export type ExternalSessionActivityV1 = z.infer<typeof ExternalSessionActivityV1Schema>;

export const ExternalSessionCandidateV1Schema = z
  .object({
    remoteSessionId: z.string().min(1).max(2000),
    candidateKey: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(10_000).optional(),
    updatedAtMs: z.number().int().min(0),
    createdAtMs: z.number().int().min(0).optional(),
    activity: ExternalSessionActivityV1Schema.optional(),
    archived: z.boolean().optional(),
    details: z.object({}).passthrough().optional(),
    linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
    linkedSessionId: z.string().min(1).max(2000).optional(),
    imported: z.boolean().optional(),
    materializedThrough: z.number().int().min(0).optional(),
  })
  .passthrough();
export type ExternalSessionCandidateV1 = z.infer<typeof ExternalSessionCandidateV1Schema>;

export const ExternalSessionStatusGetRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value),
  z.object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    takeoverReadiness: z.literal('fresh').optional(),
  }).strict(),
);
export type ExternalSessionStatusGetRequest = z.infer<typeof ExternalSessionStatusGetRequestSchema>;

export const ExternalSessionAttachRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value),
  z.object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    leaseId: z.string().min(1).max(2000).optional(),
    ttlMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
    acceptedTailCursor: ExternalSessionRefreshCursorV1Schema.optional(),
  }).strict(),
);
export type ExternalSessionAttachRequest = z.infer<typeof ExternalSessionAttachRequestSchema>;

export const ExternalSessionAttachResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      leaseId: z.string().min(1),
      expiresAtMs: z.number().int().min(0),
      renewed: z.boolean().optional(),
      acceptedTailCursor: ExternalSessionRefreshCursorV1Schema.optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
      /**
       * Whether re-attaching can plausibly succeed. The daemon classifies the
       * corridor failure once; a viewer must not poll a failure it already
       * knows is terminal. Released producers omit it — absent stays retryable.
       */
      retryable: z.boolean().optional(),
    })
    .passthrough(),
]);
export type ExternalSessionAttachResponse = z.infer<typeof ExternalSessionAttachResponseSchema>;

export const ExternalSessionDetachRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    leaseId: z.string().min(1).max(2000),
  })
  .strict();
export type ExternalSessionDetachRequest = z.infer<typeof ExternalSessionDetachRequestSchema>;

export const ExternalSessionDetachResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      detached: z.boolean(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionDetachResponse = z.infer<typeof ExternalSessionDetachResponseSchema>;

export const ExternalSessionFollowPolicySetRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value),
  z.object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    enabled: z.boolean(),
  }).strict(),
);
export type ExternalSessionFollowPolicySetRequest = z.infer<typeof ExternalSessionFollowPolicySetRequestSchema>;

export const ExternalSessionFollowPolicySetResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      enabled: z.boolean(),
      leaseActive: z.boolean(),
      updatedAtMs: z.number().int().min(0),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionFollowPolicySetResponse = z.infer<typeof ExternalSessionFollowPolicySetResponseSchema>;

export const ExternalSessionStatusGetResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      machineOnline: z.boolean(),
      runnerActive: z.boolean(),
      activity: ExternalSessionActivityV1Schema,
      canTakeOverDirect: z.boolean(),
      canTakeOverPersist: z.boolean(),
      canForceStop: z.boolean(),
      trustedPid: z.number().int().min(1).nullish(),
      lastKnownActivityAtMs: z.number().int().min(0).optional(),
      externalAgent: ExternalAgentObservationSnapshotV1Schema.nullable().optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionStatusGetResponse = z.infer<typeof ExternalSessionStatusGetResponseSchema>;

const ExternalSessionActionSessionIdSchema = z.string()
  .min(1)
  .max(191)
  .refine((value) => value === value.trim(), 'Session id must already be trimmed.');
const ExternalSessionActionLeaseIdSchema = z.string()
  .min(1)
  .max(2_000)
  .refine((value) => value === value.trim(), 'Lease id must already be trimmed.');
const ExternalSessionActionCursorSchema = z.string()
  .min(1)
  .max(4_096)
  .regex(/^happier_external_cursor_v1:[A-Za-z0-9_-]+$/)
  .refine((value) => value === value.trim(), 'Cursor must already be trimmed.');

export const ExternalSessionStatusActionInputV1Schema = z.object({
  sessionId: ExternalSessionActionSessionIdSchema,
  takeoverReadiness: z.literal('fresh').optional(),
}).strict();

export const ExternalSessionViewerFollowActionInputV1Schema = z.object({
  sessionId: ExternalSessionActionSessionIdSchema,
  leaseId: ExternalSessionActionLeaseIdSchema.optional(),
  ttlMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
  acceptedTailCursor: ExternalSessionActionCursorSchema.optional(),
}).strict();

export const ExternalSessionViewerUnfollowActionInputV1Schema = z.object({
  sessionId: ExternalSessionActionSessionIdSchema,
  leaseId: ExternalSessionActionLeaseIdSchema,
}).strict();

export const ExternalSessionBackgroundFollowActionInputV1Schema = z.object({
  sessionId: ExternalSessionActionSessionIdSchema,
  enabled: z.boolean(),
}).strict();

const ExternalSessionActionFailureV1Schema = z.object({
  ok: z.literal(false),
  errorCode: ExternalSessionsRpcErrorCodeSchema,
  error: z.string().min(1).max(2_000),
}).strict();

export const ExternalSessionStatusActionResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    machineOnline: z.boolean(),
    runnerActive: z.boolean(),
    activity: ExternalSessionActivityV1Schema,
    canTakeOverDirect: z.boolean(),
    canTakeOverPersist: z.boolean(),
    canForceStop: z.boolean(),
    lastKnownActivityAtMs: z.number().int().min(0).optional(),
  }).strict(),
  ExternalSessionActionFailureV1Schema,
]);

/**
 * A follow lease is the one External Session result its caller re-requests on a
 * timer, so the daemon's terminal classification travels to the public surface
 * too — otherwise a plugin polls a failure the daemon already answered forever.
 * Released daemons omit it; absent stays retryable.
 */
const ExternalSessionViewerFollowActionFailureV1Schema = z.object({
  ok: z.literal(false),
  errorCode: ExternalSessionsRpcErrorCodeSchema,
  error: z.string().min(1).max(2_000),
  retryable: z.boolean().optional(),
}).strict();

export const ExternalSessionViewerFollowActionResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    leaseId: ExternalSessionActionLeaseIdSchema,
    expiresAtMs: z.number().int().min(0),
    renewed: z.boolean(),
    acceptedTailCursor: ExternalSessionActionCursorSchema.optional(),
  }).strict(),
  ExternalSessionViewerFollowActionFailureV1Schema,
]);

export const ExternalSessionViewerUnfollowActionResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    detached: z.boolean(),
  }).strict(),
  ExternalSessionActionFailureV1Schema,
]);

export const ExternalSessionBackgroundFollowActionResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    enabled: z.boolean(),
    leaseActive: z.boolean(),
    updatedAtMs: z.number().int().min(0),
  }).strict(),
  ExternalSessionActionFailureV1Schema,
]);

export const ExternalSessionTranscriptRawMessageV1Schema =
  createExternalSessionTranscriptSourceItemV1Schema({
    identifier: z.string().min(1),
    /**
     * Historical-import and recipient-read wire carrier. Current Agent
     * contributions use AgentExternalSessionTranscriptRawRecord instead; this
     * retained compatibility reader never authorizes a user row as terminal
     * input by itself.
     */
    raw: z.object({}).passthrough(),
  })
  .passthrough();
export type ExternalSessionTranscriptRawMessageV1 = z.infer<typeof ExternalSessionTranscriptRawMessageV1Schema>;

export const ExternalSessionTranscriptPageRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value),
  z.object({
    machineId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    direction: z.enum(['older', 'newer']),
    cursor: z.string().min(1).optional(),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  }).strict(),
);
export type ExternalSessionTranscriptPageRequest = z.infer<typeof ExternalSessionTranscriptPageRequestSchema>;

export const ExternalSessionTranscriptPageResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      items: z.array(ExternalSessionTranscriptRawMessageV1Schema),
      nextCursor: z.string().min(1).nullish(),
      tailCursor: z.string().min(1).nullish(),
      hasMore: z.boolean(),
      truncated: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTranscriptPageResponse = z.infer<typeof ExternalSessionTranscriptPageResponseSchema>;

export const ExternalSessionTranscriptReadAfterRequestSchema = z.preprocess(
  (value) => normalizeReleasedExternalSessionRequest(value),
  z.object({
    machineId: z.string().min(1),
    agentId: ExternalSessionsAgentIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    cursor: z.string().min(1),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  }).strict(),
);
export type ExternalSessionTranscriptReadAfterRequest = z.infer<typeof ExternalSessionTranscriptReadAfterRequestSchema>;

export const ExternalSessionTranscriptReadAfterResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      items: z.array(ExternalSessionTranscriptRawMessageV1Schema),
      nextCursor: z.string().min(1).nullish(),
      truncated: z.boolean(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTranscriptReadAfterResponse = z.infer<typeof ExternalSessionTranscriptReadAfterResponseSchema>;
