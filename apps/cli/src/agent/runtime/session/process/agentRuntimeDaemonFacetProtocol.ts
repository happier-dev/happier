import { z } from 'zod';

import {
  AgentExternalSessionTranscriptRawRecordSchema,
  ExternalSessionTranscriptItemIdV1Schema,
  ExternalSessionTranscriptSourceTimestampV1Schema,
  ExternalSessionUserProjectionSchema,
  ExternalSessionOperationStateV1Schema,
  ExternalSessionTranscriptRawMessageV1Schema,
  ExternalSessionsSourceSchema,
  PluginContributionIdentityV1Schema,
  VoiceProviderContributionSchema,
  RuntimeDescriptorV1Schema,
  SessionRunnerRuntimeStateV1Schema,
  SessionStateAcpConfigOptionValueSchema,
  SessionStateAcpSessionModeValueSchema,
  SessionStateAttentionValueSchema,
  SessionStateExternalAgentValueSchema,
  SessionStateModelValueSchema,
  SessionStatePermissionModeValueSchema,
  SessionStateProviderSessionIdValueSchema,
  SessionStateReadStateValueSchema,
  SessionStateRuntimeActivityValueSchema,
  SessionStateRuntimeDescriptorValueSchema,
  SessionStateTitleValueSchema,
  SessionStateUsageLimitRecoveryValueSchema,
  SessionStateWorkStateValueSchema,
  resolveTranscriptBodySemanticEvent,
  type PluginContributionIdentityV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import {
  AgentRuntimeDaemonServiceTurnWitnessV1Schema,
} from './agentRuntimeDaemonServiceTurnWitness';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const BoundedIdSchema = z.string().trim().min(1).max(512);
const HostPluginContributionIdentityV1Schema = asHostProtocolZod(
  PluginContributionIdentityV1Schema,
);
const ExternalSessionIdSchema =
  z.string().trim().min(1).max(256);
const ExternalSessionRemoteIdSchema =
  z.string().trim().min(1).max(2_000);
const ExternalSessionJsonObjectSchema = z.record(
  z.string(),
  AgentRuntimeJsonValueV1Schema,
);
export const RunnerAgentDaemonExternalSessionCursorV1Schema =
  z.string().max(32_768);
export const RunnerAgentDaemonExternalSessionRefV1Schema = z.object({
  agentId: ExternalSessionIdSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  sourceId: z.string().trim().min(1).max(2_000),
}).strict();

const ExternalSessionTranscriptItemSchema = z.object({
  id: ExternalSessionTranscriptItemIdV1Schema,
  localId: ExternalSessionTranscriptItemIdV1Schema.optional(),
  userProjection: ExternalSessionUserProjectionSchema.optional(),
  timestampMs: ExternalSessionTranscriptSourceTimestampV1Schema.optional(),
  kind: z.enum(['user', 'agent', 'system', 'event']),
  data: AgentExternalSessionTranscriptRawRecordSchema,
}).strict().superRefine((item, context) => {
  const semanticRole = item.data.role === 'user'
    ? 'user'
    : resolveTranscriptBodySemanticEvent({
      protocol: 'acp',
      body: item.data.content,
    })?.role;
  if (!semanticRole || item.kind !== semanticRole) {
    context.addIssue({
      code: 'custom',
      path: ['kind'],
      message: 'External Session follow item kind must match its strict raw envelope',
    });
  }
  if (item.userProjection !== undefined && semanticRole !== 'user') {
    context.addIssue({
      code: 'custom',
      path: ['userProjection'],
      message: 'External Session user projection requires a user raw envelope',
    });
  }
});
const AgentSessionRealtimeVoiceDeclarationV1Schema =
  VoiceProviderContributionSchema.transform(
    (declaration, context) => {
      if (
        declaration.kind !== 'conversation'
        || declaration.execution?.kind
          !== 'experimental_agent_session_realtime'
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Only Agent-session realtime Voice declarations are allowed',
        });
        return z.NEVER;
      }
      return declaration;
    },
  );

export const AgentRuntimeDaemonExternalSessionFollowEventV1Schema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('data'),
      phase: z.literal('initial_replay').optional(),
      items: z.array(ExternalSessionTranscriptItemSchema).max(200),
      fromCursor:
        RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
      nextCursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('resyncRequired'),
      reason: z.enum([
        'cursorDiscontinuity',
        'providerTruncated',
        'bufferOverflow',
      ]),
      cursor: RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
    }).strict(),
    z.object({
      kind: z.literal('terminated'),
      reason: z.enum([
        'disposed',
        'aborted',
        'retired',
        'providerFailure',
        'resyncRequired',
      ]),
      cursor: RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
      code: z.string().trim().min(1).max(256).optional(),
    }).strict(),
  ]);

export const AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('following'),
      startingCursor:
        RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      code: z.string().trim().min(1).max(256),
    }).strict(),
  ]);

const FollowTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('externalSession'),
    ref: RunnerAgentDaemonExternalSessionRefV1Schema,
    source: ExternalSessionsSourceSchema,
  }).strict(),
  z.object({
    kind: z.literal('providerSession'),
    agentId: BoundedIdSchema,
    providerSessionId: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

const ExternalSessionTranscriptMediaReadRootsSchema = z.array(
  z.string().min(1).max(4_096),
).max(16).optional();

const ExternalSessionSourceValidationResultSchema = z.discriminatedUnion(
  'ok',
  [
    z.object({
      ok: z.literal(true),
      source: ExternalSessionsSourceSchema,
      transcriptMediaReadRoots: ExternalSessionTranscriptMediaReadRootsSchema,
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: z.string().trim().min(1).max(2_000),
    }).strict(),
  ],
);

const ExternalSessionStateUpdateBase = {
  updatedAt: z.number().finite().optional(),
} as const;

const ExternalSessionStateUpdateSchema = z.discriminatedUnion(
  'fieldId',
  [
    z.object({
      fieldId: z.literal('identity.runtimeDescriptor'),
      value: SessionStateRuntimeDescriptorValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('identity.providerSessionId'),
      value: SessionStateProviderSessionIdValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('intent.model'),
      value: SessionStateModelValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('intent.permissionMode'),
      value: SessionStatePermissionModeValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('intent.acpSessionMode'),
      value: SessionStateAcpSessionModeValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('intent.acpConfigOption'),
      value: SessionStateAcpConfigOptionValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('display.title'),
      value: SessionStateTitleValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('runtime.workState'),
      value: SessionStateWorkStateValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('runtime.activity'),
      value: SessionStateRuntimeActivityValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('runtime.externalAgent'),
      value: SessionStateExternalAgentValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('runtime.externalSessionOperation'),
      value: ExternalSessionOperationStateV1Schema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('runtime.usageLimitRecovery'),
      value: SessionStateUsageLimitRecoveryValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('runtime.sessionRunner'),
      value: SessionRunnerRuntimeStateV1Schema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('view.readState'),
      value: SessionStateReadStateValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
    z.object({
      fieldId: z.literal('view.attention'),
      value: SessionStateAttentionValueSchema,
      ...ExternalSessionStateUpdateBase,
    }).strict(),
  ],
);

const ExternalSessionLinkIdentitySchema = z.object({
  remoteSessionId: ExternalSessionRemoteIdSchema,
  source: ExternalSessionsSourceSchema,
  transcriptMediaReadRoots: ExternalSessionTranscriptMediaReadRootsSchema,
  runtimeDescriptor: RuntimeDescriptorV1Schema.nullable().optional(),
  vendorMetadata: ExternalSessionJsonObjectSchema.optional(),
  externalSessionMetadata: ExternalSessionJsonObjectSchema.optional(),
  sessionStateUpdates:
    z.array(ExternalSessionStateUpdateSchema).max(128).optional(),
}).strict();

const ExternalSessionTranscriptPageSchema = z.object({
  items: z.array(ExternalSessionTranscriptRawMessageV1Schema).max(5_000),
  nextCursor:
    RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
  tailCursor:
    RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
}).strict();

const ExternalSessionTranscriptReadAfterSchema = z.discriminatedUnion(
  'outcome',
  [
    z.object({ outcome: z.literal('already_current') }).strict(),
    z.object({
      outcome: z.literal('advanced'),
      items: z.array(ExternalSessionTranscriptRawMessageV1Schema).max(5_000),
      nextCursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
      boundary: BoundedIdSchema,
      hasMore: z.boolean(),
      diagnostics: z.array(z.object({
        code: BoundedIdSchema,
        severity: z.enum(['benign', 'required']),
        count: z.number().int().nonnegative(),
        positions: z.array(z.number().int().nonnegative()).max(5_000),
      }).strict()).max(128).optional(),
    }).strict(),
    z.object({ outcome: z.literal('gap_or_cursor_expired') }).strict(),
    z.object({ outcome: z.literal('source_replaced') }).strict(),
    z.object({ outcome: z.literal('source_unavailable') }).strict(),
    z.object({ outcome: z.literal('read_failed') }).strict(),
  ],
);

export const RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('validateSource'),
      source: ExternalSessionsSourceSchema,
    }).strict(),
    z.object({
      kind: z.literal('resolveLinkIdentity'),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      runtimeDescriptor: RuntimeDescriptorV1Schema.nullable().optional(),
      metadata: ExternalSessionJsonObjectSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('pageTranscript'),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      direction: z.enum(['older', 'newer']),
      cursor: RunnerAgentDaemonExternalSessionCursorV1Schema.optional(),
      maxBytes: z.number().int().min(1).max(524_288),
      maxItems: z.number().int().min(1).max(200),
      deadlineAtMs: z.number().int().nonnegative().safe().optional(),
    }).strict(),
    z.object({
      kind: z.literal('readAfterTranscript'),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      cursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
      maxBytes: z.number().int().min(1).max(524_288),
      maxItems: z.number().int().min(1).max(200),
      deadlineAtMs: z.number().int().nonnegative().safe().optional(),
    }).strict(),
  ]);

const RunnerAgentDaemonExternalSessionFollowProviderSuccessV1Schema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('validateSource'),
      value: ExternalSessionSourceValidationResultSchema,
    }).strict(),
    z.object({
      kind: z.literal('resolveLinkIdentity'),
      value: ExternalSessionLinkIdentitySchema,
    }).strict(),
    z.object({
      kind: z.literal('pageTranscript'),
      value: ExternalSessionTranscriptPageSchema,
    }).strict(),
    z.object({
      kind: z.literal('readAfterTranscript'),
      value: ExternalSessionTranscriptReadAfterSchema,
    }).strict(),
  ]);

export const RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema =
  z.discriminatedUnion('status', [
    z.object({
      providerRequestId: BoundedIdSchema,
      status: z.literal('success'),
      result:
        RunnerAgentDaemonExternalSessionFollowProviderSuccessV1Schema,
    }).strict(),
    z.object({
      providerRequestId: BoundedIdSchema,
      status: z.literal('failure'),
      code: z.string().trim().min(1).max(256),
      message: z.string().trim().min(1).max(2_000),
    }).strict(),
  ]);

export type RunnerAgentDaemonExternalSessionFollowProviderRequestV1 =
  z.infer<
    typeof RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema
  >;
export type RunnerAgentDaemonExternalSessionFollowProviderResponseV1 =
  z.infer<
    typeof RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema
  >;

export const RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS = [
  z.object({
    kind: z.literal('external_session.follow.open'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    target: FollowTargetSchema,
    cursor:
      RunnerAgentDaemonExternalSessionCursorV1Schema.optional(),
    initialReplay: z.boolean().optional(),
    admissionDeadlineAtMs:
      z.number().int().nonnegative().safe().optional(),
    witness:
      AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('external_session.follow.next'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    acknowledgeEventId: BoundedIdSchema.optional(),
    providerResponse:
      RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema
        .optional(),
    witness:
      AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('external_session.follow.close'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    acknowledgeEventId: BoundedIdSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('voice.authority.snapshot'),
    requestId: BoundedIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('voice.authority.waitRetired'),
    requestId: BoundedIdSchema,
    provider: HostPluginContributionIdentityV1Schema,
    providerGeneration: BoundedIdSchema,
    witness:
      AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
  }).strict(),
] as const;

export const RunnerAgentDaemonFacetOperationV1Schema =
  z.discriminatedUnion(
    'kind',
    RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
  );

export type RunnerAgentDaemonFacetOperationV1 =
  z.infer<typeof RunnerAgentDaemonFacetOperationV1Schema>;

export const RunnerAgentDaemonFacetResultV1Schema:
  z.ZodType<RunnerAgentDaemonFacetResultV1> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('external_session.follow.open'),
      followId: BoundedIdSchema,
      result:
        AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('external_session.follow.event'),
      followId: BoundedIdSchema,
      eventId: BoundedIdSchema,
      event: AgentRuntimeDaemonExternalSessionFollowEventV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('external_session.follow.provider_request'),
      followId: BoundedIdSchema,
      providerRequestId: BoundedIdSchema,
      request:
        RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('external_session.follow.closed'),
      followId: BoundedIdSchema,
    }).strict(),
    z.object({
      kind: z.literal('voice.authority.snapshot'),
      agentGeneration: BoundedIdSchema,
      providers: z.array(
        z.object({
          provider: HostPluginContributionIdentityV1Schema,
          providerGeneration: BoundedIdSchema,
          declaration:
            AgentSessionRealtimeVoiceDeclarationV1Schema,
        }).strict(),
      ).max(64),
    }).strict(),
    z.object({
      kind: z.literal('voice.authority.retired'),
      providerGeneration: BoundedIdSchema,
    }).strict(),
  ],
);

type AgentSessionRealtimeVoiceDeclarationV1 = Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
>;

export type RunnerAgentDaemonFacetResultV1 =
  | Readonly<{
    kind: 'external_session.follow.open';
    followId: string;
    result: z.infer<
      typeof AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema
    >;
  }>
  | Readonly<{
    kind: 'external_session.follow.event';
    followId: string;
    eventId: string;
    event: z.infer<
      typeof AgentRuntimeDaemonExternalSessionFollowEventV1Schema
    >;
  }>
  | Readonly<{
    kind: 'external_session.follow.provider_request';
    followId: string;
    providerRequestId: string;
    request: RunnerAgentDaemonExternalSessionFollowProviderRequestV1;
  }>
  | Readonly<{
    kind: 'external_session.follow.closed';
    followId: string;
  }>
  | Readonly<{
    kind: 'voice.authority.snapshot';
    agentGeneration: string;
    providers: readonly Readonly<{
      provider: PluginContributionIdentityV1;
      providerGeneration: string;
      declaration: AgentSessionRealtimeVoiceDeclarationV1;
    }>[];
  }>
  | Readonly<{
    kind: 'voice.authority.retired';
    providerGeneration: string;
  }>;
