import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { z } from 'zod';

import { AgentExternalSessionTranscriptRawRecordSchema, ExternalSessionUserProjectionSchema } from '@happier-dev/protocol/sessions/messages/agentExternalSessionTranscriptRawRecord';
import { AgentIdV1Schema } from '@happier-dev/protocol/agents/agentIdV1';
import { ExternalSessionTranscriptItemIdV1Schema, ExternalSessionTerminalSourceObservationV1Schema, ExternalSessionTranscriptSourceTimestampV1Schema } from '@happier-dev/protocol/sessions/external/sourceTranscriptItemV1';
import { SidechainIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { ExternalSessionOperationStateV1Schema } from '@happier-dev/protocol/sessions/external/operationV1';
import { ExternalSessionTranscriptRawMessageV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { SessionStateAcpConfigOptionValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/acpConfigOption';
import { AcpSessionModeOverrideV1Schema as SessionStateAcpSessionModeValueSchema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { SessionStateAttentionValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/attention';
import { ExternalAgentObservationSnapshotV1Schema as SessionStateExternalAgentValueSchema } from '@happier-dev/protocol/sessions/external/externalAgentObservationV1';
import { SessionStateModelValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/model';
import { SessionStatePermissionModeValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/permissionMode';
import { SessionStateProviderSessionIdValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/providerSessionId';
import { SessionStateReadStateValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/readState';
import { SessionRuntimeActivitySnapshotSchema as SessionStateRuntimeActivityValueSchema } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { RuntimeDescriptorV1Schema as SessionStateRuntimeDescriptorValueSchema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { SessionStateTitleValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/title';
import { SessionStateUsageLimitRecoveryValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { SessionWorkStateV1Schema as SessionStateWorkStateValueSchema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { resolveTranscriptBodySemanticEvent } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import type { PluginContributionIdentityV1, VoiceProviderContribution } from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import {
  AgentRuntimeDaemonServiceTurnWitnessV1Schema,
} from './agentRuntimeDaemonServiceTurnWitness';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

/** Happier-minted ids on this seam (request/follow/boundary/generation). */
const BoundedIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(512));
const HostPluginContributionIdentityV1Schema = lazyZodSchema(() => asHostProtocolZod(
  PluginContributionIdentityV1Schema,
));
/**
 * An Agent-minted external Session id crossing the runner/daemon seam. The
 * runtime transports it back to its issuer, so this schema bounds and
 * presence-checks it through Protocol's one opaque-identifier rule owner and
 * never re-canonicalizes the bytes.
 */
const ExternalSessionRemoteIdSchema =
  lazyZodSchema(() => NonBlankOpaqueIdentifierSchema.max(2_000));
const ExternalSessionJsonObjectSchema = lazyZodSchema(() => z.record(
  z.string(),
  AgentRuntimeJsonValueV1Schema,
));
export const RunnerAgentDaemonExternalSessionCursorV1Schema =
  lazyZodSchema(() => z.string().max(32_768));
export const RunnerAgentDaemonExternalSessionRefV1Schema = lazyZodSchema(() => z.object({
  agentId: AgentIdV1Schema,
  remoteSessionId: ExternalSessionRemoteIdSchema,
  // A plugin-declared contribution id, not an Agent-minted identity.
  sourceId: z.string().trim().min(1).max(2_000),
}).strict());

const ExternalSessionTranscriptItemSchema = lazyZodSchema(() => z.object({
  id: ExternalSessionTranscriptItemIdV1Schema,
  localId: ExternalSessionTranscriptItemIdV1Schema.optional(),
  sidechainId: SidechainIdSchema.nullable().optional(),
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
}));
const ExternalSessionTerminalObservationSchema = lazyZodSchema(() => z.object({
  id: ExternalSessionTranscriptItemIdV1Schema,
  timestampMs: ExternalSessionTranscriptSourceTimestampV1Schema,
  kind: z.literal('source_observation'),
  data: ExternalSessionTerminalSourceObservationV1Schema.shape.raw.shape.content,
}).strict());

const AgentSessionRealtimeVoiceDeclarationV1Schema =
  lazyZodSchema(() => VoiceProviderContributionSchema.transform(
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
  ));

export const AgentRuntimeDaemonExternalSessionFollowEventV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('data'),
      phase: z.literal('initial_replay').optional(),
      providerSessionId: ExternalSessionRemoteIdSchema.optional(),
      items: z.array(z.union([ExternalSessionTranscriptItemSchema, ExternalSessionTerminalObservationSchema])).max(200),
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
  ]));

export const AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
    z.object({
      status: z.literal('following'),
      startingCursor:
        RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      code: z.string().trim().min(1).max(256),
    }).strict(),
  ]));

const FollowTargetSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('externalSession'),
    ref: RunnerAgentDaemonExternalSessionRefV1Schema,
    source: ExternalSessionsSourceSchema,
  }).strict(),
  z.object({
    kind: z.literal('providerSession'),
    agentId: AgentIdV1Schema,
    providerSessionId: NonBlankOpaqueIdentifierSchema.max(2_000),
  }).strict(),
]));

const ExternalSessionTranscriptMediaReadRootsSchema = lazyZodSchema(() => z.array(
  z.string().min(1).max(4_096),
).max(16).optional());

const ExternalSessionSourceValidationResultSchema = lazyZodSchema(() => z.discriminatedUnion(
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
));

const ExternalSessionStateUpdateBase = {
  updatedAt: z.number().finite().optional(),
} as const;

const ExternalSessionStateUpdateSchema = lazyZodSchema(() => z.discriminatedUnion(
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
));

const ExternalSessionLinkIdentitySchema = lazyZodSchema(() => z.object({
  remoteSessionId: ExternalSessionRemoteIdSchema,
  source: ExternalSessionsSourceSchema,
  transcriptMediaReadRoots: ExternalSessionTranscriptMediaReadRootsSchema,
  runtimeDescriptor: RuntimeDescriptorV1Schema.nullable().optional(),
  vendorMetadata: ExternalSessionJsonObjectSchema.optional(),
  externalSessionMetadata: ExternalSessionJsonObjectSchema.optional(),
  sessionStateUpdates:
    z.array(ExternalSessionStateUpdateSchema).max(128).optional(),
}).strict());

const ExternalSessionTranscriptPageSchema = lazyZodSchema(() => z.object({
  items: z.array(z.union([ExternalSessionTranscriptRawMessageV1Schema, ExternalSessionTerminalSourceObservationV1Schema])).max(5_000),
  nextCursor:
    RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
  tailCursor:
    RunnerAgentDaemonExternalSessionCursorV1Schema.nullable(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
}).strict());

const ExternalSessionTranscriptReadAfterSchema = lazyZodSchema(() => z.discriminatedUnion(
  'outcome',
  [
    z.object({ outcome: z.literal('already_current') }).strict(),
    z.object({
      outcome: z.literal('advanced'),
      items: z.array(z.union([ExternalSessionTranscriptRawMessageV1Schema, ExternalSessionTerminalSourceObservationV1Schema])).max(5_000),
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
));

export const RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
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
      projection: z.literal('terminal').optional(),
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
      projection: z.literal('terminal').optional(),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      cursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
      maxBytes: z.number().int().min(1).max(524_288),
      maxItems: z.number().int().min(1).max(200),
      deadlineAtMs: z.number().int().nonnegative().safe().optional(),
    }).strict(),
  ]));

const RunnerAgentDaemonExternalSessionFollowProviderSuccessV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
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
  ]));

export const RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
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
  ]));

export type RunnerAgentDaemonExternalSessionFollowProviderRequestV1 =
  z.infer<
    typeof RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema
  >;
export type RunnerAgentDaemonExternalSessionFollowProviderResponseV1 =
  z.infer<
    typeof RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema
  >;

export const RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS = [
  lazyZodSchema(() => z.object({
    kind: z.literal('external_session.follow.open'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    target: FollowTargetSchema,
    cursor:
      RunnerAgentDaemonExternalSessionCursorV1Schema.optional(),
    initialReplay: z.boolean().optional(),
    projection: z.literal('terminal').optional(),
    replay: z.literal('fresh').optional(),
    admissionDeadlineAtMs:
      z.number().int().nonnegative().safe().optional(),
    witness:
      AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
  }).strict()),
  lazyZodSchema(() => z.object({
    kind: z.literal('external_session.follow.next'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    acknowledgeEventId: BoundedIdSchema.optional(),
    providerResponse:
      RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema
        .optional(),
    witness:
      AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
  }).strict()),
  lazyZodSchema(() => z.object({
    kind: z.literal('external_session.follow.close'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    acknowledgeEventId: BoundedIdSchema.optional(),
  }).strict()),
  lazyZodSchema(() => z.object({
    kind: z.literal('voice.authority.snapshot'),
    requestId: BoundedIdSchema,
  }).strict()),
  lazyZodSchema(() => z.object({
    kind: z.literal('voice.authority.waitRetired'),
    requestId: BoundedIdSchema,
    provider: HostPluginContributionIdentityV1Schema,
    providerGeneration: BoundedIdSchema,
    witness:
      AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
  }).strict()),
] as const;

export const RunnerAgentDaemonFacetOperationV1Schema =
  lazyZodSchema(() => z.discriminatedUnion(
    'kind',
    RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
  ));

export type RunnerAgentDaemonFacetOperationV1 =
  z.infer<typeof RunnerAgentDaemonFacetOperationV1Schema>;

export const RunnerAgentDaemonFacetResultV1Schema:
  z.ZodType<RunnerAgentDaemonFacetResultV1> = lazyZodSchema(() => z.discriminatedUnion(
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
      agentSourceCustody: PluginSourceCustodyV1Schema,
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
));

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
    agentSourceCustody: z.infer<typeof PluginSourceCustodyV1Schema>;
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
