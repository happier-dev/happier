import { z } from 'zod';

import { ActionOperationSnapshotV1Schema } from '../actions/operations/actionOperationV1.js';
import { SpawnSessionTerminalSchema } from '../spawnSession.js';

import { AgentRuntimeDescriptorV1Schema } from '../sessionMetadata/agentRuntimeDescriptorV1.js';
import { CODEX_BACKEND_MODES } from '../providers/codex/backendMode.js';
import { AgentProviderIdV1Schema } from '../providers/agentProviderIdsV1.js';
import { SessionMessageRoleSchema } from '../sessionMessages/sessionMessageRole.js';
import { lazySchema } from '../lazySchema.js';

export const DirectSessionsProviderIdSchema = AgentProviderIdV1Schema;
export type DirectSessionsProviderId = z.infer<typeof DirectSessionsProviderIdSchema>;

const DirectSessionsCodexHomeSourceSchema = lazySchema(() => z
  .object({
    kind: z.literal('codexHome'),
    home: z.enum(['user', 'connectedService']),
    homePath: z.string().min(1).optional(),
    connectedServiceId: z.string().min(1).optional(),
    connectedServiceProfileId: z.string().min(1).optional(),
    connectedServiceGroupId: z.string().min(1).optional(),
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
    if (value.connectedServiceGroupId) {
      ctx.addIssue({ code: 'custom', message: 'connectedServiceGroupId is not allowed when home=user', path: ['connectedServiceGroupId'] });
    }
  }));

const DirectSessionsClaudeConfigSourceSchema = lazySchema(() => z
  .object({
    kind: z.literal('claudeConfig'),
    configDir: z.string().min(1).max(10_000).nullish(),
    projectId: z.string().min(1).max(2000).nullish(),
  })
  .passthrough());

const DirectSessionsOpenCodeServerSourceSchema = lazySchema(() => z
  .object({
    kind: z.literal('opencodeServer'),
    baseUrl: z.string().url().nullish(),
    directory: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough());

const DirectSessionsPiAgentDirSourceSchema = lazySchema(() => z
  .object({
    kind: z.literal('piAgentDir'),
    // Resolved ~/.pi/agent directory; falls back to env PI_CODING_AGENT_DIR / ~/.pi/agent when nullish.
    agentDir: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough());

/**
 * Generic source for agents whose ACP server advertises `session/list`. It carries no provider
 * identity and no filesystem location: candidates are produced by the agent itself over ACP and are
 * resume-only. `cwd` is the optional ACP working-directory filter and must be absolute.
 */
const DirectSessionsAcpSessionListSourceSchema = lazySchema(() => z
  .object({
    kind: z.literal('acpSessionList'),
    cwd: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough());

export const DirectSessionsSourceSchema = lazySchema(() => z.discriminatedUnion('kind', [
  DirectSessionsCodexHomeSourceSchema,
  DirectSessionsClaudeConfigSourceSchema,
  DirectSessionsOpenCodeServerSourceSchema,
  DirectSessionsPiAgentDirSourceSchema,
  DirectSessionsAcpSessionListSourceSchema,
]));
export type DirectSessionsSource = z.infer<typeof DirectSessionsSourceSchema>;

/**
 * Negotiates only the generic ACP `session/list` browse source. This capability is intentionally
 * resume-only and grants no transcript, follow, takeover, terminal, or writer authority.
 */
export const DirectSessionsAcpSessionListCapabilityRequestSchema = lazySchema(() => z.object({}).strict());
export type DirectSessionsAcpSessionListCapabilityRequest = z.infer<typeof DirectSessionsAcpSessionListCapabilityRequestSchema>;

export const DirectSessionsAcpSessionListCapabilityResponseSchema = lazySchema(() => z.object({
  ok: z.literal(true),
  capability: z.literal('acp_session_list_v1'),
  protocolVersion: z.literal(1),
  sourceKind: z.literal('acpSessionList'),
  resumeOnly: z.literal(true),
}).strict());
export type DirectSessionsAcpSessionListCapabilityResponse = z.infer<typeof DirectSessionsAcpSessionListCapabilityResponseSchema>;

export const DirectSessionsSearchModeSchema = lazySchema(() => z.enum(['fast', 'full']));
export type DirectSessionsSearchMode = z.infer<typeof DirectSessionsSearchModeSchema>;

export const DirectSessionsCandidatesListRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    source: DirectSessionsSourceSchema,
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    searchTerm: z.string().min(1).max(2000).optional(),
    searchMode: DirectSessionsSearchModeSchema.optional(),
  })
  .passthrough());
export type DirectSessionsCandidatesListRequest = z.infer<typeof DirectSessionsCandidatesListRequestSchema>;

export const DirectSessionsCandidatesListResponseSchema = lazySchema(() => z.union([
  z
    .object({
      ok: z.literal(true),
      candidates: z.array(z.lazy(() => DirectSessionCandidateV1Schema)),
      nextCursor: z.string().min(1).nullish(),
      searchIncomplete: z.boolean().optional(),
      capabilities: z.object({
        deleteCandidate: z.boolean(),
      }).optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]));
export type DirectSessionsCandidatesListResponse = z.infer<typeof DirectSessionsCandidatesListResponseSchema>;

export const DirectSessionCandidateDeleteRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    source: DirectSessionsSourceSchema,
    remoteSessionId: z.string().min(1).max(2000),
  })
  .passthrough());
export type DirectSessionCandidateDeleteRequest = z.infer<typeof DirectSessionCandidateDeleteRequestSchema>;

export const DirectSessionCandidateDeleteResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true), deleted: z.literal(true) }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
    error: z.string().min(1),
  }).passthrough(),
]));
export type DirectSessionCandidateDeleteResponse = z.infer<typeof DirectSessionCandidateDeleteResponseSchema>;

export const DirectSessionLinkEnsureRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    titleHint: z.string().min(1).max(10_000).optional(),
    directoryHint: z.string().min(1).max(10_000).optional(),
    codexBackendMode: z.enum(CODEX_BACKEND_MODES).optional(),
    runtimeDescriptor: AgentRuntimeDescriptorV1Schema.optional(),
    source: DirectSessionsSourceSchema,
  })
  .passthrough());
export type DirectSessionLinkEnsureRequest = z.infer<typeof DirectSessionLinkEnsureRequestSchema>;


export const DirectSessionLinkEnsureResponseSchema = lazySchema(() => z.union([
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
]));
export type DirectSessionLinkEnsureResponse = z.infer<typeof DirectSessionLinkEnsureResponseSchema>;

export const DirectSessionActivityV1Schema = lazySchema(() => z.enum(['running', 'active_recently', 'idle', 'unknown']));
export type DirectSessionActivityV1 = z.infer<typeof DirectSessionActivityV1Schema>;

export const DirectSessionCandidateV1Schema = lazySchema(() => z
  .object({
    remoteSessionId: z.string().min(1).max(2000),
    title: z.string().min(1).max(10_000).optional(),
    updatedAtMs: z.number().int().min(0),
    createdAtMs: z.number().int().min(0).optional(),
    activity: DirectSessionActivityV1Schema.optional(),
    archived: z.boolean().optional(),
    details: z.object({}).passthrough().optional(),
  })
  .passthrough());
export type DirectSessionCandidateV1 = z.infer<typeof DirectSessionCandidateV1Schema>;

export const DirectSessionStatusGetRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
  })
  .passthrough());
export type DirectSessionStatusGetRequest = z.infer<typeof DirectSessionStatusGetRequestSchema>;

export const DirectSessionAttachRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
    leaseId: z.string().min(1).max(2000).optional(),
    ttlMs: z.number().int().min(1_000).max(15 * 60_000).optional(),
  })
  .passthrough());
export type DirectSessionAttachRequest = z.infer<typeof DirectSessionAttachRequestSchema>;

export const DirectSessionAttachResponseSchema = lazySchema(() => z.union([
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
]));
export type DirectSessionAttachResponse = z.infer<typeof DirectSessionAttachResponseSchema>;

export const DirectSessionDetachRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    leaseId: z.string().min(1).max(2000),
  })
  .passthrough());
export type DirectSessionDetachRequest = z.infer<typeof DirectSessionDetachRequestSchema>;

export const DirectSessionDetachResponseSchema = lazySchema(() => z.union([
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
]));
export type DirectSessionDetachResponse = z.infer<typeof DirectSessionDetachResponseSchema>;

export const DirectSessionFollowPolicySetRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
    enabled: z.boolean(),
  })
  .passthrough());
export type DirectSessionFollowPolicySetRequest = z.infer<typeof DirectSessionFollowPolicySetRequestSchema>;

export const DirectSessionFollowPolicySetResponseSchema = lazySchema(() => z.union([
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
]));
export type DirectSessionFollowPolicySetResponse = z.infer<typeof DirectSessionFollowPolicySetResponseSchema>;

export const DirectSessionStatusGetResponseSchema = lazySchema(() => z.union([
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
]));
export type DirectSessionStatusGetResponse = z.infer<typeof DirectSessionStatusGetResponseSchema>;

export const DirectTranscriptRawMessageV1Schema = lazySchema(() => z
  .object({
    id: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    localId: z.string().min(1).nullable().optional(),
    messageRole: SessionMessageRoleSchema.nullable().optional(),
    raw: z.object({}).passthrough(),
  })
  .passthrough());
export type DirectTranscriptRawMessageV1 = z.infer<typeof DirectTranscriptRawMessageV1Schema>;

export const DirectTranscriptPageRequestSchema = lazySchema(() => z
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
  .passthrough());
export type DirectTranscriptPageRequest = z.infer<typeof DirectTranscriptPageRequestSchema>;

// Keep `truncated` for released readers; only a page limit permits adjacent continuation.
export const DirectTranscriptTruncationReasonSchema = lazySchema(() => z.enum(['page_limit', 'source_discontinuity']));
export type DirectTranscriptTruncationReason = z.infer<typeof DirectTranscriptTruncationReasonSchema>;

export const DirectTranscriptPageResponseSchema = lazySchema(() => z.union([
  z
    .object({
      ok: z.literal(true),
      items: z.array(DirectTranscriptRawMessageV1Schema),
      nextCursor: z.string().min(1).nullish(),
      tailCursor: z.string().min(1).nullish(),
      hasMore: z.boolean(),
      truncated: z.boolean().optional(),
      truncationReason: DirectTranscriptTruncationReasonSchema.optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (value.truncationReason === 'page_limit' && typeof value.nextCursor !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'page-limit transcript continuation requires a next cursor',
          path: ['nextCursor'],
        });
      }
    }),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]));
export type DirectTranscriptPageResponse = z.infer<typeof DirectTranscriptPageResponseSchema>;

export const DirectTranscriptReadAfterRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    providerId: DirectSessionsProviderIdSchema,
    remoteSessionId: z.string().min(1).max(2000),
    source: DirectSessionsSourceSchema,
    cursor: z.string().min(1),
    maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    maxItems: z.number().int().min(1).max(5000).optional(),
  })
  .passthrough());
export type DirectTranscriptReadAfterRequest = z.infer<typeof DirectTranscriptReadAfterRequestSchema>;

export function resolveDirectTranscriptContinuation(params: Readonly<{
  truncated?: boolean;
  truncationReason?: DirectTranscriptTruncationReason;
}>): 'complete' | DirectTranscriptTruncationReason {
  // Explicit facts are authoritative; providers retain their released boolean semantics.
  return params.truncationReason ?? (params.truncated === true ? 'source_discontinuity' : 'complete');
}

export const DirectTranscriptReadAfterResponseSchema = lazySchema(() => z.union([
  z
    .object({
      ok: z.literal(true),
      items: z.array(DirectTranscriptRawMessageV1Schema),
      nextCursor: z.string().min(1).nullish(),
      truncated: z.boolean(),
      truncationReason: DirectTranscriptTruncationReasonSchema.optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (value.truncationReason === 'page_limit' && typeof value.nextCursor !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'page-limit transcript continuation requires a next cursor',
          path: ['nextCursor'],
        });
      }
    }),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]));
export type DirectTranscriptReadAfterResponse = z.infer<typeof DirectTranscriptReadAfterResponseSchema>;

export const DIRECT_SESSION_TAKEOVER_ACTION_IDS = Object.freeze({
  direct: 'session.direct.takeover',
  persisted: 'session.direct.takeover_persist',
} as const);

export const DirectSessionTakeoverRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
    requestId: z.string().trim().min(1).optional(),
    terminal: SpawnSessionTerminalSchema.optional(),
  })
  .passthrough());
export type DirectSessionTakeoverRequest = z.infer<typeof DirectSessionTakeoverRequestSchema>;

export const DirectSessionTakeoverResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]));
export type DirectSessionTakeoverResponse = z.infer<typeof DirectSessionTakeoverResponseSchema>;

export const DirectSessionTakeoverPersistRequestSchema = lazySchema(() => z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
    requestId: z.string().trim().min(1).optional(),
    terminal: SpawnSessionTerminalSchema.optional(),
  })
  .passthrough());
export type DirectSessionTakeoverPersistRequest = z.infer<typeof DirectSessionTakeoverPersistRequestSchema>;

export const DirectSessionTakeoverPersistResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true), converted: z.boolean().optional() }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]));
export type DirectSessionTakeoverPersistResponse = z.infer<typeof DirectSessionTakeoverPersistResponseSchema>;

// Start acknowledges the same daemon-local Action Operation observed via list/get/cancel.
export const DirectSessionTakeoverPersistStartResponseSchema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true), operation: ActionOperationSnapshotV1Schema }),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'machine_offline', 'provider_unavailable', 'internal_error']),
    error: z.string().min(1),
  }),
]));
export type DirectSessionTakeoverPersistStartResponse = z.infer<typeof DirectSessionTakeoverPersistStartResponseSchema>;
