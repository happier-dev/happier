import { z } from 'zod';

import { AgentRuntimeDescriptorV1Schema } from '../sessionMetadata/agentRuntimeDescriptorV1.js';

export const DirectSessionsProviderIdSchema = z.enum(['codex', 'claude', 'opencode']);
export type DirectSessionsProviderId = z.infer<typeof DirectSessionsProviderIdSchema>;

const DirectSessionsCodexHomeSourceSchema = z
  .object({
    kind: z.literal('codexHome'),
    home: z.enum(['user', 'connectedService']),
    homePath: z.string().min(1).optional(),
    connectedServiceId: z.string().min(1).optional(),
    connectedServiceProfileId: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.home === 'connectedService') {
      if (!value.connectedServiceId) {
        ctx.addIssue({ code: 'custom', message: 'connectedServiceId is required when home=connectedService', path: ['connectedServiceId'] });
      }
      return;
    }
    if (value.connectedServiceId) {
      ctx.addIssue({ code: 'custom', message: 'connectedServiceId is not allowed when home=user', path: ['connectedServiceId'] });
    }
    if (value.connectedServiceProfileId) {
      ctx.addIssue({ code: 'custom', message: 'connectedServiceProfileId is not allowed when home=user', path: ['connectedServiceProfileId'] });
    }
  });

const DirectSessionsClaudeConfigSourceSchema = z
  .object({
    kind: z.literal('claudeConfig'),
    configDir: z.string().min(1).max(10_000).nullish(),
    projectId: z.string().min(1).max(2000).nullish(),
  })
  .passthrough();

const DirectSessionsOpenCodeServerSourceSchema = z
  .object({
    kind: z.literal('opencodeServer'),
    baseUrl: z.string().url().nullish(),
    directory: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough();

export const DirectSessionsSourceSchema = z.discriminatedUnion('kind', [
  DirectSessionsCodexHomeSourceSchema,
  DirectSessionsClaudeConfigSourceSchema,
  DirectSessionsOpenCodeServerSourceSchema,
]);
export type DirectSessionsSource = z.infer<typeof DirectSessionsSourceSchema>;

export const DirectSessionsCandidatesListRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    source: DirectSessionsSourceSchema,
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    searchTerm: z.string().min(1).max(2000).optional(),
  })
  .passthrough();
export type DirectSessionsCandidatesListRequest = z.infer<typeof DirectSessionsCandidatesListRequestSchema>;

export const DirectSessionsCandidatesListResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      candidates: z.array(z.lazy(() => DirectSessionCandidateV1Schema)),
      nextCursor: z.string().min(1).nullish(),
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
export type DirectSessionsCandidatesListResponse = z.infer<typeof DirectSessionsCandidatesListResponseSchema>;

export const DirectSessionLinkEnsureRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    titleHint: z.string().min(1).max(10_000).optional(),
    directoryHint: z.string().min(1).max(10_000).optional(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
    runtimeDescriptor: AgentRuntimeDescriptorV1Schema.optional(),
    source: DirectSessionsSourceSchema,
  })
  .passthrough();
export type DirectSessionLinkEnsureRequest = z.infer<typeof DirectSessionLinkEnsureRequestSchema>;

export const DirectSessionLinkEnsureResponseSchema = z.union([
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
export type DirectSessionLinkEnsureResponse = z.infer<typeof DirectSessionLinkEnsureResponseSchema>;

export const DirectSessionActivityV1Schema = z.enum(['running', 'active_recently', 'idle', 'unknown']);
export type DirectSessionActivityV1 = z.infer<typeof DirectSessionActivityV1Schema>;

export const DirectSessionCandidateV1Schema = z
  .object({
    remoteSessionId: z.string().min(1).max(2000),
    title: z.string().min(1).max(10_000).optional(),
    updatedAtMs: z.number().int().min(0),
    createdAtMs: z.number().int().min(0).optional(),
    activity: DirectSessionActivityV1Schema.optional(),
    archived: z.boolean().optional(),
    details: z.object({}).passthrough().optional(),
  })
  .passthrough();
export type DirectSessionCandidateV1 = z.infer<typeof DirectSessionCandidateV1Schema>;

export const DirectSessionStatusGetRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
  })
  .passthrough();
export type DirectSessionStatusGetRequest = z.infer<typeof DirectSessionStatusGetRequestSchema>;

export const DirectSessionStatusGetResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      machineOnline: z.boolean(),
      runnerActive: z.boolean(),
      activity: DirectSessionActivityV1Schema,
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
export type DirectSessionStatusGetResponse = z.infer<typeof DirectSessionStatusGetResponseSchema>;

export const DirectTranscriptRawMessageV1Schema = z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    localId: z.string().min(1).nullable().optional(),
    raw: z.object({}).passthrough(),
  })
  .passthrough();
export type DirectTranscriptRawMessageV1 = z.infer<typeof DirectTranscriptRawMessageV1Schema>;

export const DirectTranscriptPageRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
    direction: z.enum(['older', 'newer']),
    cursor: z.string().min(1).optional(),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  })
  .passthrough();
export type DirectTranscriptPageRequest = z.infer<typeof DirectTranscriptPageRequestSchema>;

export const DirectTranscriptPageResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      items: z.array(DirectTranscriptRawMessageV1Schema),
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
export type DirectTranscriptPageResponse = z.infer<typeof DirectTranscriptPageResponseSchema>;

export const DirectTranscriptReadAfterRequestSchema = z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
    cursor: z.string().min(1),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  })
  .passthrough();
export type DirectTranscriptReadAfterRequest = z.infer<typeof DirectTranscriptReadAfterRequestSchema>;

export const DirectTranscriptReadAfterResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      items: z.array(DirectTranscriptRawMessageV1Schema),
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
export type DirectTranscriptReadAfterResponse = z.infer<typeof DirectTranscriptReadAfterResponseSchema>;

export const DirectSessionTakeoverRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
  })
  .passthrough();
export type DirectSessionTakeoverRequest = z.infer<typeof DirectSessionTakeoverRequestSchema>;

export const DirectSessionTakeoverResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type DirectSessionTakeoverResponse = z.infer<typeof DirectSessionTakeoverResponseSchema>;

export const DirectSessionTakeoverPersistRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
  })
  .passthrough();
export type DirectSessionTakeoverPersistRequest = z.infer<typeof DirectSessionTakeoverPersistRequestSchema>;

export const DirectSessionTakeoverPersistResponseSchema = z.union([
  z.object({ ok: z.literal(true), converted: z.boolean().optional() }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type DirectSessionTakeoverPersistResponse = z.infer<typeof DirectSessionTakeoverPersistResponseSchema>;
