import { z } from 'zod';

import { RuntimeDescriptorV1Schema } from '../../sessionMetadata/runtimeDescriptorV1.js';
import { CODEX_BACKEND_MODES } from '../../providers/codex/backendMode.js';
import {
  ExternalSessionsProviderIdSchema,
  ExternalSessionsSourceSchema,
  type ExternalSessionsProviderId,
  type ExternalSessionsSource,
} from './sourceCatalog.js';

export {
  ExternalSessionsProviderIdSchema,
  ExternalSessionsSourceSchema,
};
export type {
  ExternalSessionsProviderId,
  ExternalSessionsSource,
};

export const ExternalSessionsSearchModeSchema = z.enum(['fast', 'full']);
export type ExternalSessionsSearchMode = z.infer<typeof ExternalSessionsSearchModeSchema>;

export const ExternalSessionsCandidatesListRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    source: ExternalSessionsSourceSchema,
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    searchTerm: z.string().min(1).max(2000).optional(),
    searchMode: ExternalSessionsSearchModeSchema.optional(),
  })
  .passthrough();
export type ExternalSessionsCandidatesListRequest = z.infer<typeof ExternalSessionsCandidatesListRequestSchema>;

export const ExternalSessionsCandidatesListResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      candidates: z.array(z.lazy(() => ExternalSessionCandidateV1Schema)),
      nextCursor: z.string().min(1).nullish(),
      searchIncomplete: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionsCandidatesListResponse = z.infer<typeof ExternalSessionsCandidatesListResponseSchema>;

export const ExternalSessionLinkEnsureRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    titleHint: z.string().min(1).max(10_000).optional(),
    directoryHint: z.string().min(1).max(10_000).optional(),
    codexBackendMode: z.enum(CODEX_BACKEND_MODES).optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    source: ExternalSessionsSourceSchema,
  })
  .passthrough();
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
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
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
    title: z.string().min(1).max(10_000).optional(),
    updatedAtMs: z.number().int().min(0),
    createdAtMs: z.number().int().min(0).optional(),
    activity: ExternalSessionActivityV1Schema.optional(),
    archived: z.boolean().optional(),
    details: z.object({}).passthrough().optional(),
  })
  .passthrough();
export type ExternalSessionCandidateV1 = z.infer<typeof ExternalSessionCandidateV1Schema>;

export const ExternalSessionStatusGetRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
  })
  .passthrough();
export type ExternalSessionStatusGetRequest = z.infer<typeof ExternalSessionStatusGetRequestSchema>;

export const ExternalSessionAttachRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    leaseId: z.string().min(1).max(2000).optional(),
    ttlMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
  })
  .passthrough();
export type ExternalSessionAttachRequest = z.infer<typeof ExternalSessionAttachRequestSchema>;

export const ExternalSessionAttachResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      leaseId: z.string().min(1),
      expiresAtMs: z.number().int().min(0),
      renewed: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
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
  .passthrough();
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
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionDetachResponse = z.infer<typeof ExternalSessionDetachResponseSchema>;

export const ExternalSessionFollowPolicySetRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    enabled: z.boolean(),
  })
  .passthrough();
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
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
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
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionStatusGetResponse = z.infer<typeof ExternalSessionStatusGetResponseSchema>;

export const ExternalSessionTranscriptRawMessageV1Schema = z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    localId: z.string().min(1).nullable().optional(),
    raw: z.object({}).passthrough(),
  })
  .passthrough();
export type ExternalSessionTranscriptRawMessageV1 = z.infer<typeof ExternalSessionTranscriptRawMessageV1Schema>;

export const ExternalSessionTranscriptPageRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    direction: z.enum(['older', 'newer']),
    cursor: z.string().min(1).optional(),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  })
  .passthrough();
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
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTranscriptPageResponse = z.infer<typeof ExternalSessionTranscriptPageResponseSchema>;

export const ExternalSessionTranscriptReadAfterRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: ExternalSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: ExternalSessionsSourceSchema,
    cursor: z.string().min(1),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  })
  .passthrough();
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
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTranscriptReadAfterResponse = z.infer<typeof ExternalSessionTranscriptReadAfterResponseSchema>;

export const ExternalSessionTakeoverRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
  })
  .passthrough();
export type ExternalSessionTakeoverRequest = z.infer<typeof ExternalSessionTakeoverRequestSchema>;

export const ExternalSessionTakeoverResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTakeoverResponse = z.infer<typeof ExternalSessionTakeoverResponseSchema>;

export const ExternalSessionTakeoverPersistRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
  })
  .passthrough();
export type ExternalSessionTakeoverPersistRequest = z.infer<typeof ExternalSessionTakeoverPersistRequestSchema>;

export const ExternalSessionTakeoverPersistResponseSchema = z.union([
  z.object({ ok: z.literal(true), converted: z.boolean().optional() }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTakeoverPersistResponse = z.infer<typeof ExternalSessionTakeoverPersistResponseSchema>;
