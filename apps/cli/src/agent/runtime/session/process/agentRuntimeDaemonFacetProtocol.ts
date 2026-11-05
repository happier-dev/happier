import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';

import { AgentExternalSessionTranscriptRawRecordSchema, ExternalSessionUserProjectionSchema } from '@happier-dev/protocol/sessions/messages/agentExternalSessionTranscriptRawRecord';
import { AgentIdV1Schema } from '@happier-dev/protocol/agents/agentIdV1';
import { ExternalSessionToolResultMediaReferenceV1Schema, ExternalSessionTranscriptItemIdV1Schema, ExternalSessionTerminalSourceObservationV1Schema, ExternalSessionTranscriptSourceTimestampV1Schema } from '@happier-dev/protocol/sessions/external/sourceTranscriptItemV1';
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
const BoundedIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));
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
  lazyZodSchema(() => NonBlankOpaqueIdentifierSchema.check(
    zMini.maxLength(2_000),
  ));
const ExternalSessionJsonObjectSchema = lazyZodSchema(() => z.record(
  z.string(),
  AgentRuntimeJsonValueV1Schema,
));
export const RunnerAgentDaemonExternalSessionCursorV1Schema =
  lazyZodSchema(() => z.string().check(z.maxLength(32_768)));
export const RunnerAgentDaemonExternalSessionRefV1Schema = lazyZodSchema(() => z.strictObject({
  agentId: AgentIdV1Schema,
  remoteSessionId: ExternalSessionRemoteIdSchema,
  // A plugin-declared contribution id, not an Agent-minted identity.
  sourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
}));

const ExternalSessionTranscriptItemSchema = lazyZodSchema(() => z.strictObject({
  id: ExternalSessionTranscriptItemIdV1Schema,
  toolResultMedia: zMini.optional(ExternalSessionToolResultMediaReferenceV1Schema),
  localId: zMini.optional(ExternalSessionTranscriptItemIdV1Schema),
  sidechainId: zMini.optional(zMini.nullable(SidechainIdSchema)),
  userProjection: zMini.optional(ExternalSessionUserProjectionSchema),
  timestampMs: zMini.optional(
    ExternalSessionTranscriptSourceTimestampV1Schema,
  ),
  kind: z.enum(['user', 'agent', 'system', 'event']),
  data: AgentExternalSessionTranscriptRawRecordSchema,
}).check(z.superRefine((item, context) => {
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
})));
const ExternalSessionTerminalObservationSchema = lazyZodSchema(() => z.strictObject({
  id: ExternalSessionTranscriptItemIdV1Schema,
  timestampMs: ExternalSessionTranscriptSourceTimestampV1Schema,
  kind: z.literal('source_observation'),
  data: ExternalSessionTerminalSourceObservationV1Schema.shape.raw.shape.content,
}));

const AgentSessionRealtimeVoiceDeclarationV1Schema =
  lazyZodSchema(() => z.pipe(asHostProtocolZod(VoiceProviderContributionSchema), z.transform((declaration, context) => {
      if (
        declaration.kind !== 'conversation'
        || declaration.execution?.kind
          !== 'experimental_agent_session_realtime'
      ) {
        context.issues.push({
          code: 'custom',
          message:
            'Only Agent-session realtime Voice declarations are allowed', input: context.value });
        return z.NEVER;
      }
      return declaration;
    })));

export const AgentRuntimeDaemonExternalSessionFollowEventV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('data'),
      phase: z.optional(z.literal('initial_replay')),
      providerSessionId: zMini.optional(ExternalSessionRemoteIdSchema),
      source: z.optional(ExternalSessionsSourceSchema),
      items: z.array(z.union([ExternalSessionTranscriptItemSchema, ExternalSessionTerminalObservationSchema])).check(z.maxLength(200)),
      fromCursor:
        z.nullable(RunnerAgentDaemonExternalSessionCursorV1Schema),
      nextCursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
    }),
    z.strictObject({
      kind: z.literal('resyncRequired'),
      reason: z.enum([
        'cursorDiscontinuity',
        'providerTruncated',
        'bufferOverflow',
      ]),
      cursor: z.nullable(RunnerAgentDaemonExternalSessionCursorV1Schema),
    }),
    z.strictObject({
      kind: z.literal('terminated'),
      reason: z.enum([
        'disposed',
        'aborted',
        'retired',
        'providerFailure',
        'resyncRequired',
      ]),
      cursor: z.nullable(RunnerAgentDaemonExternalSessionCursorV1Schema),
      code: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    }),
  ]));

export const AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('following'),
      startingCursor:
        z.nullable(RunnerAgentDaemonExternalSessionCursorV1Schema),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      code: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    }),
  ]));

const FollowTargetSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('externalSession'),
    ref: RunnerAgentDaemonExternalSessionRefV1Schema,
    source: ExternalSessionsSourceSchema,
  }),
  z.strictObject({
    kind: z.literal('providerSession'),
    agentId: AgentIdV1Schema,
    providerSessionId: NonBlankOpaqueIdentifierSchema.check(
      zMini.maxLength(2_000),
    ),
  }),
]));

const ExternalSessionTranscriptMediaReadRootsSchema = lazyZodSchema(() => z.optional(z.array(
  z.string().check(z.minLength(1), z.maxLength(4_096)),
).check(z.maxLength(16))));

const ExternalSessionSourceValidationResultSchema = lazyZodSchema(() => z.discriminatedUnion(
  'ok',
  [
    z.strictObject({
      ok: z.literal(true),
      source: ExternalSessionsSourceSchema,
      transcriptMediaReadRoots: ExternalSessionTranscriptMediaReadRootsSchema,
    }),
    z.strictObject({
      ok: z.literal(false),
      error: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
    }),
  ],
));

const ExternalSessionStateUpdateBase = {
  updatedAt: z.optional(z.number()),
} as const;

const ExternalSessionStateUpdateSchema = lazyZodSchema(() => z.discriminatedUnion(
  'fieldId',
  [
    z.strictObject({
      fieldId: z.literal('identity.runtimeDescriptor'),
      value: SessionStateRuntimeDescriptorValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('identity.providerSessionId'),
      value: SessionStateProviderSessionIdValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('intent.model'),
      value: SessionStateModelValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('intent.permissionMode'),
      value: SessionStatePermissionModeValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('intent.acpSessionMode'),
      value: SessionStateAcpSessionModeValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('intent.acpConfigOption'),
      value: SessionStateAcpConfigOptionValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('display.title'),
      value: SessionStateTitleValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('runtime.workState'),
      value: SessionStateWorkStateValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('runtime.activity'),
      value: SessionStateRuntimeActivityValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('runtime.externalAgent'),
      value: SessionStateExternalAgentValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('runtime.externalSessionOperation'),
      value: ExternalSessionOperationStateV1Schema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('runtime.usageLimitRecovery'),
      value: SessionStateUsageLimitRecoveryValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('runtime.sessionRunner'),
      value: SessionRunnerRuntimeStateV1Schema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('view.readState'),
      value: SessionStateReadStateValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
    z.strictObject({
      fieldId: z.literal('view.attention'),
      value: SessionStateAttentionValueSchema,
      ...ExternalSessionStateUpdateBase,
    }),
  ],
));

const ExternalSessionLinkIdentitySchema = lazyZodSchema(() => z.strictObject({
  remoteSessionId: ExternalSessionRemoteIdSchema,
  source: ExternalSessionsSourceSchema,
  transcriptMediaReadRoots: ExternalSessionTranscriptMediaReadRootsSchema,
  runtimeDescriptor: zMini.optional(zMini.nullable(RuntimeDescriptorV1Schema)),
  vendorMetadata: z.optional(ExternalSessionJsonObjectSchema),
  externalSessionMetadata: z.optional(ExternalSessionJsonObjectSchema),
  sessionStateUpdates:
    z.optional(z.array(ExternalSessionStateUpdateSchema).check(z.maxLength(128))),
}));

const ExternalSessionTranscriptPageSchema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.union([ExternalSessionTranscriptRawMessageV1Schema, ExternalSessionTerminalSourceObservationV1Schema])).check(z.maxLength(5_000)),
  nextCursor:
    z.nullable(RunnerAgentDaemonExternalSessionCursorV1Schema),
  tailCursor:
    z.nullable(RunnerAgentDaemonExternalSessionCursorV1Schema),
  hasMore: z.boolean(),
  truncated: z.boolean(),
}));

const ExternalSessionTranscriptReadAfterSchema = lazyZodSchema(() => z.discriminatedUnion(
  'outcome',
  [
    z.strictObject({ outcome: z.literal('already_current') }),
    z.strictObject({
      outcome: z.literal('advanced'),
      items: z.array(z.union([ExternalSessionTranscriptRawMessageV1Schema, ExternalSessionTerminalSourceObservationV1Schema])).check(z.maxLength(5_000)),
      nextCursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
      boundary: BoundedIdSchema,
      hasMore: z.boolean(),
      diagnostics: z.optional(z.array(z.strictObject({
        code: BoundedIdSchema,
        severity: z.enum(['benign', 'required']),
        count: z.number().check(z.int(), z.nonnegative()),
        positions: z.array(z.number().check(z.int(), z.nonnegative())).check(z.maxLength(5_000)),
      })).check(z.maxLength(128))),
    }),
    z.strictObject({ outcome: z.literal('gap_or_cursor_expired') }),
    z.strictObject({ outcome: z.literal('source_replaced') }),
    z.strictObject({ outcome: z.literal('source_unavailable') }),
    z.strictObject({ outcome: z.literal('read_failed') }),
  ],
));

export const RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('validateSource'),
      source: ExternalSessionsSourceSchema,
    }),
    z.strictObject({
      kind: z.literal('resolveLinkIdentity'),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      runtimeDescriptor: zMini.optional(zMini.nullable(RuntimeDescriptorV1Schema)),
      metadata: z.optional(ExternalSessionJsonObjectSchema),
    }),
    z.strictObject({
      kind: z.literal('pageTranscript'),
      projection: z.optional(z.literal('terminal')),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      direction: z.enum(['older', 'newer']),
      cursor: z.optional(RunnerAgentDaemonExternalSessionCursorV1Schema),
      maxBytes: z.number().check(z.int(), z.minimum(1), z.maximum(524_288)),
      maxItems: z.number().check(z.int(), z.minimum(1), z.maximum(200)),
      deadlineAtMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    }),
    z.strictObject({
      kind: z.literal('readAfterTranscript'),
      projection: z.optional(z.literal('terminal')),
      source: ExternalSessionsSourceSchema,
      remoteSessionId: ExternalSessionRemoteIdSchema,
      cursor: RunnerAgentDaemonExternalSessionCursorV1Schema,
      maxBytes: z.number().check(z.int(), z.minimum(1), z.maximum(524_288)),
      maxItems: z.number().check(z.int(), z.minimum(1), z.maximum(200)),
      deadlineAtMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    }),
  ]));

const RunnerAgentDaemonExternalSessionFollowProviderSuccessV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('validateSource'),
      value: ExternalSessionSourceValidationResultSchema,
    }),
    z.strictObject({
      kind: z.literal('resolveLinkIdentity'),
      value: ExternalSessionLinkIdentitySchema,
    }),
    z.strictObject({
      kind: z.literal('pageTranscript'),
      value: ExternalSessionTranscriptPageSchema,
    }),
    z.strictObject({
      kind: z.literal('readAfterTranscript'),
      value: ExternalSessionTranscriptReadAfterSchema,
    }),
  ]));

export const RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({
      providerRequestId: BoundedIdSchema,
      status: z.literal('success'),
      result:
        RunnerAgentDaemonExternalSessionFollowProviderSuccessV1Schema,
    }),
    z.strictObject({
      providerRequestId: BoundedIdSchema,
      status: z.literal('failure'),
      code: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
      message: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
    }),
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
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('external_session.follow.open'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    target: FollowTargetSchema,
    cursor:
      z.optional(RunnerAgentDaemonExternalSessionCursorV1Schema),
    initialReplay: z.optional(z.boolean()),
    projection: z.optional(z.literal('terminal')),
    replay: z.optional(z.literal('fresh')),
    admissionDeadlineAtMs:
      z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    witness:
      z.optional(AgentRuntimeDaemonServiceTurnWitnessV1Schema),
  })),
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('external_session.follow.next'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    acknowledgeEventId: z.optional(BoundedIdSchema),
    providerResponse:
      z.optional(RunnerAgentDaemonExternalSessionFollowProviderResponseV1Schema),
    witness:
      z.optional(AgentRuntimeDaemonServiceTurnWitnessV1Schema),
  })),
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('external_session.follow.close'),
    requestId: BoundedIdSchema,
    followId: BoundedIdSchema,
    acknowledgeEventId: z.optional(BoundedIdSchema),
  })),
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('voice.authority.snapshot'),
    requestId: BoundedIdSchema,
  })),
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('voice.authority.waitRetired'),
    requestId: BoundedIdSchema,
    provider: HostPluginContributionIdentityV1Schema,
    providerGeneration: BoundedIdSchema,
    witness:
      z.optional(AgentRuntimeDaemonServiceTurnWitnessV1Schema),
  })),
] as const;

export const RunnerAgentDaemonFacetOperationV1Schema =
  lazyZodSchema(() => z.discriminatedUnion(
    'kind',
    RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
  ));

export type RunnerAgentDaemonFacetOperationV1 =
  z.infer<typeof RunnerAgentDaemonFacetOperationV1Schema>;

export const RunnerAgentDaemonFacetResultV1Schema:
  z.ZodMiniType<RunnerAgentDaemonFacetResultV1> = lazyZodSchema(() => z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('external_session.follow.open'),
      followId: BoundedIdSchema,
      result:
        AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema,
    }),
    z.strictObject({
      kind: z.literal('external_session.follow.event'),
      followId: BoundedIdSchema,
      eventId: BoundedIdSchema,
      event: AgentRuntimeDaemonExternalSessionFollowEventV1Schema,
    }),
    z.strictObject({
      kind: z.literal('external_session.follow.provider_request'),
      followId: BoundedIdSchema,
      providerRequestId: BoundedIdSchema,
      request:
        RunnerAgentDaemonExternalSessionFollowProviderRequestV1Schema,
    }),
    z.strictObject({
      kind: z.literal('external_session.follow.closed'),
      followId: BoundedIdSchema,
    }),
    z.strictObject({
      kind: z.literal('voice.authority.snapshot'),
      agentSourceCustody: PluginSourceCustodyV1Schema,
      providers: z.array(
        z.strictObject({
          provider: HostPluginContributionIdentityV1Schema,
          providerGeneration: BoundedIdSchema,
          declaration:
            AgentSessionRealtimeVoiceDeclarationV1Schema,
        }),
      ).check(z.maxLength(64)),
    }),
    z.strictObject({
      kind: z.literal('voice.authority.retired'),
      providerGeneration: BoundedIdSchema,
    }),
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
