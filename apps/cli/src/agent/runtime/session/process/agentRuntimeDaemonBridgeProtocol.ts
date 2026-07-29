import { z } from 'zod';

import {
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1,
  AgentLaunchEnvironmentV1Schema,
  AgentRuntimeJsonValueV1Schema,
  AgentSessionCompactRequestV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionConfigurationUpdateV1Schema,
  AgentSessionConversationRollbackRequestV1Schema,
  AgentSessionRuntimeEventV1Schema,
  AgentSessionSendRequestV1Schema,
} from '@happier-dev/protocol/runtime';
import {
  AGENT_SESSION_REALTIME_SDP_MAX_BYTES,
  AgentModelOptionSchema,
  AgentModelOptionValueIdSchema,
  AgentSessionProviderBindingV1Schema,
  ExternalSessionsSourceSchema,
  ModelSelectionApplyPolicySchema,
  PluginPermissionCapabilityV1Schema,
  PluginContributionIdentityV1Schema,
  PluginVoiceProviderContributionV1Schema,
  PluginRuntimeCapabilityFamilyV1Schema,
  ProviderAgentTargetKeySchema,
  ProviderConnectionIdSchema,
  ProviderModelDescriptorV1Schema,
  ProviderModelIdSchema,
  ProviderRuntimeBindingBasisV1Schema,
  SessionProviderBindingMetadataV1Schema,
} from '@happier-dev/protocol';

import {
  AgentRuntimeDaemonAcpChildOperationV1Schema,
  AgentRuntimeDaemonAcpDaemonOperationV1Schema,
  createAgentRuntimeDaemonAcpOpenOperationV1Schema,
} from './agentRuntimeDaemonAcpReverseSessionProtocol';

export const AGENT_RUNTIME_DAEMON_BRIDGE_PATH = '/agent-runtime/session/bridge';
export const HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY =
  'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE';

const BoundedIdSchema = z.string().trim().min(1).max(256);
const BoundedPathSchema = z.string().min(1).max(32_768);
const RequestIdSchema = z.string().trim().min(1).max(256);
const BoundedFeatureIdsSchema = z.array(BoundedIdSchema).max(256);
const ExternalSessionRefSchema = z.object({
  agentId: BoundedIdSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  sourceId: z.string().trim().min(1).max(2_000),
}).strict();
const ExternalSessionCursorSchema = z.string().max(32_768);
const ExternalSessionTranscriptItemSchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  timestampMs: z.number().finite().optional(),
  kind: z.enum(['user', 'agent', 'system', 'event']),
  data: AgentRuntimeJsonValueV1Schema,
}).strict();
export const AgentRuntimeDaemonExternalSessionFollowEventV1Schema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('data'),
      items: z.array(ExternalSessionTranscriptItemSchema).max(200),
      fromCursor: ExternalSessionCursorSchema.nullable(),
      nextCursor: ExternalSessionCursorSchema,
    }).strict(),
    z.object({
      kind: z.literal('resyncRequired'),
      reason: z.enum([
        'cursorDiscontinuity',
        'providerTruncated',
        'bufferOverflow',
      ]),
      cursor: ExternalSessionCursorSchema.nullable(),
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
      cursor: ExternalSessionCursorSchema.nullable(),
      code: z.string().trim().min(1).max(256).optional(),
    }).strict(),
  ]);
export const AgentRuntimeDaemonExternalSessionTakeoverResultV1Schema = z.object({
  sessionId: BoundedIdSchema,
  status: z.enum(['attached', 'takenOver']),
}).strict();
export const AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('following'),
      startingCursor: ExternalSessionCursorSchema.nullable(),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      code: z.string().trim().min(1).max(256),
    }).strict(),
  ]);
export const AgentRuntimeDaemonTurnPayloadV1Schema = z.record(
  z.string(),
  AgentRuntimeJsonValueV1Schema,
);

const AgentRuntimeDaemonTurnContributionRequestV1Schema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('prompt'),
      selectedAsset: z.object({
        pluginId: BoundedIdSchema,
        localId: BoundedIdSchema,
      }).strict().optional(),
      machineId: BoundedIdSchema.optional(),
      featureIds: BoundedFeatureIdsSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('transformAgentContext'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('transformSessionInput'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }).strict(),
  ],
);

const AgentRuntimeDaemonPromptBlockV1Schema = z.object({
  id: BoundedIdSchema,
  scope: z.enum([
    'session',
    'first_turn',
    'turn',
    'provider_behavior',
    'tool_delivery',
    'user_prompt',
    'bootstrap',
  ]),
  text: z.string().min(1).max(262_144),
  enabled: z.boolean().optional(),
}).strict();

const AgentRuntimeDaemonToolPromptContributionV1Schema = z.object({
  id: BoundedIdSchema,
  name: z.string().max(4_096).nullable().optional(),
  title: z.string().max(4_096).nullable().optional(),
  promptSnippet: z.string().max(262_144).nullable().optional(),
  promptGuidelines: z.array(z.string().max(262_144)).max(256).nullable().optional(),
}).strict();

export const AgentRuntimeDaemonTurnContributionsResultV1Schema = z.union([
  z.object({
    kind: z.literal('prompt'),
    promptAssetBlocks: z.array(AgentRuntimeDaemonPromptBlockV1Schema).max(256),
    toolPromptContributions: z.array(
      AgentRuntimeDaemonToolPromptContributionV1Schema,
    ).max(256),
  }).strict(),
  z.object({
    kind: z.literal('transformAgentContext'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('transformSessionInput'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }).strict(),
]).superRefine((value, context) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (
    bytes
    > AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates
      .preWatchReplayBufferMaxJsonBytes
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Agent turn contribution result exceeds the aggregate byte bound',
    });
  }
});

export type AgentRuntimeDaemonTurnContributionsResultV1 =
  z.infer<typeof AgentRuntimeDaemonTurnContributionsResultV1Schema>;

export const AgentRuntimeDaemonUiApprovalRequestV1Schema = z.object({
  title: z.string().trim().min(1).max(262_144),
  description: z.string().max(262_144).optional(),
  subject: z.object({
    kind: z.literal('tool'),
    name: BoundedIdSchema,
    input: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  allowSessionPersistence: z.boolean().optional(),
}).strict();

const PluginRemediationDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry') }).strict(),
  z.object({
    kind: z.literal('openSettings'),
    path: z.string().trim().min(1).max(32_768),
  }).strict(),
  z.object({
    kind: z.literal('selectAccount'),
    service: z.object({
      pluginId: BoundedIdSchema,
      localId: BoundedIdSchema,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('installDependency'),
    dependencyId: BoundedIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('openUrl'),
    url: z.string().trim().min(1).max(32_768),
  }).strict(),
]);

const PluginDiagnosticDataSchema = z.object({
  code: z.string().trim().min(1).max(256),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(262_144).optional(),
  details: AgentRuntimeJsonValueV1Schema.optional(),
  remediation: PluginRemediationDataSchema.optional(),
}).strict();

const RealtimeSdpSchema = z.string().refine(
  (value) =>
    new TextEncoder().encode(value).byteLength
      <= AGENT_SESSION_REALTIME_SDP_MAX_BYTES,
  'Realtime SDP exceeds the bridge byte bound',
);

export const AgentRuntimeDaemonRealtimeAvailabilityV1Schema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('available'),
      transport: z.literal('webrtc'),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      reason: z.enum([
        'authentication_required',
        'session_unavailable',
        'unsupported_runtime',
        'update_required',
        'feature_unavailable',
      ]),
      diagnostic: PluginDiagnosticDataSchema,
    }).strict(),
  ]);

export const AgentRuntimeDaemonRealtimeStartResultV1Schema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('started'),
      transport: z.object({
        kind: z.literal('webrtc'),
        answerSdp: RealtimeSdpSchema,
      }).strict(),
      handleId: RequestIdSchema,
    }).strict(),
    z.object({ status: z.literal('busy') }).strict(),
    z.object({ status: z.literal('aborted') }).strict(),
    z.object({
      status: z.literal('unavailable'),
      diagnostic: PluginDiagnosticDataSchema,
    }).strict(),
    z.object({
      status: z.literal('failed'),
      diagnostic: PluginDiagnosticDataSchema,
    }).strict(),
  ]);

export const AgentRuntimeDaemonRealtimeStopResultV1Schema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.enum(['stopped', 'already_stopped', 'aborted']),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      diagnostic: PluginDiagnosticDataSchema,
    }).strict(),
  ]);

export const AgentRuntimeDaemonRealtimeLifecycleEventV1Schema = z.object({
  kind: z.literal('terminal'),
  reason: z.enum([
    'stopped',
    'upstream_closed',
    'agent_session_disposed',
    'aborted',
    'error',
  ]),
  diagnostic: PluginDiagnosticDataSchema.optional(),
}).strict();

export const AgentRuntimeDaemonUiApprovalResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('approved'),
    persistence: z.enum(['once', 'session']),
  }).strict(),
  z.object({
    status: z.literal('denied'),
    rationale: z.string().max(262_144).optional(),
  }).strict(),
  z.object({
    status: z.literal('cancelled'),
    diagnostic: PluginDiagnosticDataSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    diagnostic: PluginDiagnosticDataSchema,
  }).strict(),
]);

export const AgentRuntimeDaemonSessionDescriptorV1Schema = z.object({
  v: z.literal(1),
  pluginId: BoundedIdSchema,
  pluginVersion: z.string().trim().min(1).max(256),
  agentId: BoundedIdSchema,
  backendId: BoundedIdSchema,
  generation: BoundedIdSchema,
  immutableGenerationId: z.string().trim().min(1).max(512).optional(),
  runtimeAuthority: z.object({
    permissions: z.array(PluginPermissionCapabilityV1Schema).max(256)
      .refine((values) => new Set(values).size === values.length),
    runtimeCapabilities: z.array(PluginRuntimeCapabilityFamilyV1Schema).max(256)
      .refine((values) => new Set(values).size === values.length),
  }).strict().optional(),
  runtimeSurfaces: z.object({
    terminal: z.boolean(),
    realtimeConversation: z.object({
      providers: z.array(z.object({
        identity: PluginContributionIdentityV1Schema,
        manifestDigest: z.string().trim().min(1).max(512),
        generation: BoundedIdSchema,
        declaration: PluginVoiceProviderContributionV1Schema,
      }).strict()).max(64),
    }).strict().optional(),
  }).strict().optional(),
  factoryControls: z.object({
    continuation: z.boolean(),
    goals: z.boolean(),
    catalog: z.boolean(),
    usageLimitRecovery: z.boolean(),
  }).strict(),
}).strict();

export type AgentRuntimeDaemonSessionDescriptorV1 =
  z.infer<typeof AgentRuntimeDaemonSessionDescriptorV1Schema>;

export const AgentRuntimeDaemonBridgeContextV1Schema = z.object({
  token: z.string().min(1).max(4_096),
  sessionId: BoundedIdSchema,
  pluginId: BoundedIdSchema,
  agentId: BoundedIdSchema,
  generation: BoundedIdSchema,
}).strict();

const McpLaunchConfigSchema = z.object({
  command: BoundedPathSchema,
  args: z.array(z.string().max(32_768)).max(1_024).optional(),
  env: z.record(z.string().max(256), z.string().max(262_144)).optional(),
}).strict();

const ConnectedAccountSchema = z.object({
  purpose: z.string().trim().min(1).max(256),
  account: z.object({
    service: z.object({
      pluginId: BoundedIdSchema,
      localId: BoundedIdSchema,
    }).strict(),
    accountId: BoundedIdSchema,
  }).strict(),
}).strict();

const ProviderConnectionModelRefSchema = z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: ProviderConnectionIdSchema,
  modelId: ProviderModelIdSchema,
}).strict();

export const AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema =
  z.object({
    selection: ProviderConnectionModelRefSchema,
    policy: ModelSelectionApplyPolicySchema,
    model: ProviderModelDescriptorV1Schema,
    sessionBindingMetadata: SessionProviderBindingMetadataV1Schema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
  }).strict();

export type AgentRuntimeDaemonModelTransitionAuthorizationResultV1 =
  z.infer<
    typeof AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema
  >;

const AgentSessionOpenBaseSchema = z.object({
  sessionId: BoundedIdSchema,
  cwd: BoundedPathSchema,
  launchEnvironment: AgentLaunchEnvironmentV1Schema.optional(),
  configuration: AgentSessionConfigurationSnapshotV1Schema.optional(),
  connectedAccounts: z.array(ConnectedAccountSchema).max(256).optional(),
  mcpServers: z.record(BoundedIdSchema, McpLaunchConfigSchema).optional(),
  providerBinding: AgentSessionProviderBindingV1Schema.optional(),
});

export const AgentRuntimeDaemonSessionOpenRequestV1Schema = z.discriminatedUnion('kind', [
  AgentSessionOpenBaseSchema.extend({ kind: z.literal('create') }).strict(),
  AgentSessionOpenBaseSchema.extend({
    kind: z.literal('resume'),
    providerSessionId: BoundedIdSchema,
  }).strict(),
  AgentSessionOpenBaseSchema.extend({
    kind: z.literal('fork'),
    source: z.object({
      sessionId: BoundedIdSchema,
      providerSessionId: BoundedIdSchema,
      cwd: BoundedPathSchema,
      target: z.object({
        turnId: BoundedIdSchema,
        providerCheckpoint: AgentRuntimeJsonValueV1Schema,
      }).strict().optional(),
    }).strict(),
  }).strict(),
]);

export const AgentRuntimeDaemonTerminalLaunchRequestV1Schema = z.object({
  sessionId: BoundedIdSchema,
  cwd: BoundedPathSchema,
  metadata: z.record(z.string(), AgentRuntimeJsonValueV1Schema),
}).strict();

const RuntimeOperationSchema = z.discriminatedUnion('kind', [
  AgentRuntimeDaemonAcpDaemonOperationV1Schema,
  z.object({
    kind: z.literal('foreground.environment.claim'),
    requestId: RequestIdSchema,
    attemptId: RequestIdSchema,
    foregroundSatisfiedProfileSecretRequirementNames:
      z.array(BoundedIdSchema).max(256),
  }).strict(),
  z.object({
    kind: z.literal('factory.prepare'),
    requestId: RequestIdSchema,
    descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
    request: AgentRuntimeDaemonSessionOpenRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('factory.abandon'),
    requestId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.open'),
    requestId: RequestIdSchema,
    descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
    request: AgentRuntimeDaemonSessionOpenRequestV1Schema,
    featureDecisions: z.record(BoundedIdSchema, z.boolean()),
  }).strict(),
  z.object({
    kind: z.literal('runtime.terminal.resolveLaunch'),
    requestId: RequestIdSchema,
    request: AgentRuntimeDaemonTerminalLaunchRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('runtime.realtimeConversation.inspect'),
    requestId: RequestIdSchema,
    provider: z.object({
      identity: PluginContributionIdentityV1Schema,
      generation: BoundedIdSchema,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('runtime.realtimeConversation.start'),
    requestId: RequestIdSchema,
    transport: z.object({
      kind: z.literal('webrtc'),
      offerSdp: RealtimeSdpSchema,
    }).strict(),
    provider: z.object({
      identity: PluginContributionIdentityV1Schema,
      generation: BoundedIdSchema,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('runtime.realtimeConversation.handle.stop'),
    requestId: RequestIdSchema,
    handleId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('runtime.realtimeConversation.handle.watch'),
    requestId: RequestIdSchema,
    handleId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('runtime.realtimeConversation.handle.dispose'),
    requestId: RequestIdSchema,
    handleId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.send'),
    requestId: RequestIdSchema,
    request: AgentSessionSendRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.cancel'),
    requestId: RequestIdSchema,
    turnId: BoundedIdSchema,
    reason: z.enum(['user', 'hostShutdown', 'sessionDispose', 'runtimeRecovery']),
  }).strict(),
  z.object({
    kind: z.literal('session.updateConfiguration'),
    requestId: RequestIdSchema,
    request: AgentSessionConfigurationUpdateV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.modelTransition.authorize'),
    requestId: RequestIdSchema,
    selection: ProviderConnectionModelRefSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.compact'),
    requestId: RequestIdSchema,
    request: AgentSessionCompactRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.rollback'),
    requestId: RequestIdSchema,
    request: AgentSessionConversationRollbackRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.reconcileRollback'),
    requestId: RequestIdSchema,
    request: AgentSessionConversationRollbackRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('factory.continuation.verify'),
    requestId: RequestIdSchema,
    request: AgentRuntimeDaemonSessionOpenRequestV1Schema,
    context: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('factory.goals.get'),
    requestId: RequestIdSchema,
    context: AgentRuntimeJsonValueV1Schema,
    goalSourceId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('factory.goals.set'),
    requestId: RequestIdSchema,
    mutation: AgentRuntimeJsonValueV1Schema,
    context: AgentRuntimeJsonValueV1Schema,
    goalSourceId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('factory.goals.clear'),
    requestId: RequestIdSchema,
    context: AgentRuntimeJsonValueV1Schema,
    goalSourceId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('factory.catalog.list'),
    requestId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
    context: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('factory.usageLimitRecovery.execute'),
    requestId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
    context: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.dispose'),
    requestId: RequestIdSchema,
    reason: z.enum([
      'session_closed',
      'plugin_deactivated',
      'host_shutdown',
      'runtime_recovery',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('channel.poll'),
    requestId: RequestIdSchema,
    afterSequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    kind: z.literal('effect.complete'),
    requestId: RequestIdSchema,
    effectId: RequestIdSchema,
    result: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('effect.fail'),
    requestId: RequestIdSchema,
    effectId: RequestIdSchema,
    error: z.object({
      code: z.string().trim().min(1).max(256),
      message: z.string().max(4_096),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('request.cancel'),
    requestId: RequestIdSchema,
    targetRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('activeInput.onPromptQueued'),
    requestId: RequestIdSchema,
    bindingId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('activeInput.applyPermissionIntent'),
    requestId: RequestIdSchema,
    bindingId: RequestIdSchema,
    permissionIntent: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('activeInput.clearTerminalComposer'),
    requestId: RequestIdSchema,
    bindingId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('activeInput.interruptPendingInputAndRun'),
    requestId: RequestIdSchema,
    bindingId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.callback'),
    requestId: RequestIdSchema,
    callbackId: RequestIdSchema,
    callbackKind: z.enum([
      'session',
      'permission',
      'statusline',
      'defaultPermission',
      'permissionTimeoutForTool',
    ]),
    payload: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.transcripts.fileFollow.callback'),
    requestId: RequestIdSchema,
    callbackId: RequestIdSchema,
    callbackKind: z.enum(['line', 'reset', 'error']),
    payload: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.turnContributions.resolve'),
    requestId: RequestIdSchema,
    request: AgentRuntimeDaemonTurnContributionRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.externalSession.takeover'),
    requestId: RequestIdSchema,
    ref: ExternalSessionRefSchema,
    source: ExternalSessionsSourceSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.externalSession.follow.open'),
    requestId: RequestIdSchema,
    followId: RequestIdSchema,
    ref: ExternalSessionRefSchema,
    source: ExternalSessionsSourceSchema,
    cursor: ExternalSessionCursorSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal(
      'session.externalSession.follow.openProviderSession',
    ),
    requestId: RequestIdSchema,
    followId: RequestIdSchema,
    agentId: BoundedIdSchema,
    providerSessionId: z.string().trim().min(1).max(2_000),
    cursor: ExternalSessionCursorSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('session.externalSession.follow.close'),
    requestId: RequestIdSchema,
    followId: RequestIdSchema,
  }).strict(),
]);

export const AgentRuntimeDaemonBridgeRequestV1Schema = z.object({
  v: z.literal(1),
  context: AgentRuntimeDaemonBridgeContextV1Schema,
  operation: RuntimeOperationSchema,
}).strict();

export type AgentRuntimeDaemonBridgeRequestV1 =
  z.infer<typeof AgentRuntimeDaemonBridgeRequestV1Schema>;

const AgentRuntimeDaemonSessionModelOptionValueV1Schema = z.union([
  AgentModelOptionValueIdSchema,
  z.number(),
  z.boolean(),
  z.null(),
]);

// Agent session model options use the wider public session-control scalar
// contract. All other model facts and bounds stay owned by the canonical
// Provider descriptor schema below.
const AgentRuntimeDaemonSessionModelOptionChoiceV1Schema =
  AgentModelOptionSchema.shape.options.unwrap().element.extend({
    value: AgentRuntimeDaemonSessionModelOptionValueV1Schema,
  }).strict();
const AgentRuntimeDaemonSessionModelOptionV1Schema =
  AgentModelOptionSchema.extend({
    currentValue: AgentRuntimeDaemonSessionModelOptionValueV1Schema,
    options: z.array(
      AgentRuntimeDaemonSessionModelOptionChoiceV1Schema,
    ).max(128).optional(),
  }).strict();

const AgentRuntimeDaemonSessionModelV1Schema =
  ProviderModelDescriptorV1Schema.extend({
    modelOptions: z.array(
      AgentRuntimeDaemonSessionModelOptionV1Schema,
    ).max(64).optional(),
  }).strict();

export const AgentRuntimeDaemonSessionModelsSnapshotV1Schema = z.object({
  models: z.array(AgentRuntimeDaemonSessionModelV1Schema).max(2_048).nullable(),
  currentModelId: ProviderModelIdSchema.nullable().optional(),
}).strict();

export const AgentRuntimeDaemonBridgeEffectV1Schema = z.discriminatedUnion('kind', [
  createAgentRuntimeDaemonAcpOpenOperationV1Schema(
    AgentRuntimeDaemonSessionOpenRequestV1Schema,
  ),
  AgentRuntimeDaemonAcpChildOperationV1Schema,
  z.object({
    kind: z.literal('effect.cancel'),
    effectId: RequestIdSchema,
    targetEffectId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('ui.requestApproval'),
    effectId: RequestIdSchema,
    request: AgentRuntimeDaemonUiApprovalRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('ui.askQuestions'),
    effectId: RequestIdSchema,
    questions: AgentRuntimeJsonValueV1Schema,
    options: AgentRuntimeJsonValueV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('ui.confirm'),
    effectId: RequestIdSchema,
    message: z.string().max(262_144),
    options: AgentRuntimeJsonValueV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('ui.notify'),
    effectId: RequestIdSchema,
    message: z.string().max(262_144),
    options: AgentRuntimeJsonValueV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('ui.status.set'),
    effectId: RequestIdSchema,
    key: BoundedIdSchema,
    text: z.string().max(262_144).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('ui.widget.set'),
    effectId: RequestIdSchema,
    key: BoundedIdSchema,
    widget: AgentRuntimeJsonValueV1Schema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('ui.title.set'),
    effectId: RequestIdSchema,
    title: z.string().max(262_144).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('ui.composer.replace'),
    effectId: RequestIdSchema,
    text: z.string().max(262_144),
  }).strict(),
  z.object({
    kind: z.literal('session.interactions.request'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
    permissionContext: z.object({
      origin: z.literal('host_acp_fs_write'),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('session.media.registerSourceRoot'),
    effectId: RequestIdSchema,
    rootPath: BoundedPathSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.media.publishGenerated'),
    effectId: RequestIdSchema,
    sourceId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.media.disposeSourceRoot'),
    effectId: RequestIdSchema,
    sourceId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.current.summary'),
    effectId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.current.send'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.models.publish'),
    effectId: RequestIdSchema,
    snapshot: AgentRuntimeDaemonSessionModelsSnapshotV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.activeInput.publishStatus'),
    effectId: RequestIdSchema,
    status: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.activeInput.bind'),
    effectId: RequestIdSchema,
    bindingId: RequestIdSchema,
    isTurnInFlight: z.boolean(),
    canSteer: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('session.activeInput.unbind'),
    effectId: RequestIdSchema,
    bindingId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.systemRecords.read'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.systemRecords.write'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.workflow.publishHeadline'),
    effectId: RequestIdSchema,
    headline: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.workState.publish'),
    effectId: RequestIdSchema,
    declaredSourceId: BoundedIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('factory.goalSource.publish'),
    effectId: RequestIdSchema,
    goalSourceId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.resolve'),
    effectId: RequestIdSchema,
    request: z.object({
      preference: z.enum(['auto', 'tmux', 'zellij', 'windows_console']),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.createOrAttachHost'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.injectUserPrompt'),
    effectId: RequestIdSchema,
    handle: AgentRuntimeJsonValueV1Schema,
    input: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.interruptTurn'),
    effectId: RequestIdSchema,
    handle: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.evaluateLiveness'),
    effectId: RequestIdSchema,
    handle: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.captureInputState'),
    effectId: RequestIdSchema,
    handle: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.controlPort.open'),
    effectId: RequestIdSchema,
    handle: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.controlPort.call'),
    effectId: RequestIdSchema,
    controlPortId: RequestIdSchema,
    method: z.enum([
      'sendLiteralText',
      'sendRawSequence',
      'sendSpecialKey',
      'captureScreen',
    ]),
    argument: z.string().max(262_144).optional(),
  }).strict(),
  z.object({
    kind: z.literal('session.terminal.dispose'),
    effectId: RequestIdSchema,
    handle: AgentRuntimeJsonValueV1Schema,
    intent: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.startServer'),
    effectId: RequestIdSchema,
    callbackId: RequestIdSchema,
    request: z.object({
      hasSessionHook: z.boolean(),
      hasPermissionHook: z.boolean(),
      hasStatuslineUpdate: z.boolean(),
      hasDefaultPermissionHookResponse: z.boolean(),
      hasPermissionRequestTimeoutForTool: z.boolean(),
      sessionHookSecret: z.string().max(4_096).optional(),
      permissionHookSecret: z.string().max(4_096).optional(),
      permissionRequestTimeoutMs: z.number().nonnegative().nullable().optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.resolveForwarderAssets'),
    effectId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.createPluginDir'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.disposePluginDir'),
    effectId: RequestIdSchema,
    pluginDir: BoundedPathSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.publishProviderTranscript'),
    effectId: RequestIdSchema,
    request: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.handle.stop'),
    effectId: RequestIdSchema,
    handleId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.hooks.handle.dispose'),
    effectId: RequestIdSchema,
    handleId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.transcripts.fileFollow.follow'),
    effectId: RequestIdSchema,
    callbackId: RequestIdSchema,
    input: z.object({
      path: BoundedPathSchema,
      startAt: z.enum(['beginning', 'end']),
      strategy: z.literal('poll').optional(),
      policy: z.object({
        pollIntervalMs: z.number().int().positive().optional(),
        missingFileRetryIntervalMs: z.number().int().positive().optional(),
        maxDrainRowsPerTick: z.number().int().positive().optional(),
        maxDrainBytesPerTick: z.number().int().positive().optional(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('session.transcripts.fileFollow.drainNow'),
    effectId: RequestIdSchema,
    handleId: RequestIdSchema,
    options: AgentRuntimeJsonValueV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('session.transcripts.fileFollow.close'),
    effectId: RequestIdSchema,
    handleId: RequestIdSchema,
    options: AgentRuntimeJsonValueV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('session.accountUsage.resolveSourceContext'),
    effectId: RequestIdSchema,
    input: z.object({
      serviceId: z.enum([
        'anthropic',
        'bitbucket',
        'claude-subscription',
        'gemini',
        'github',
        'openai',
        'openai-codex',
      ]),
      env: z.record(z.string().max(256), z.string().max(262_144).optional()).optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('session.accountUsage.recordSnapshot'),
    effectId: RequestIdSchema,
    input: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.accountUsage.adoptProvisionalRecord'),
    effectId: RequestIdSchema,
    input: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('session.auth.refreshRuntimeAuth'),
    effectId: RequestIdSchema,
    request: z.object({
      serviceId: BoundedIdSchema,
    }).passthrough(),
  }).strict(),
  z.object({
    kind: z.literal('session.mcp.resolveServers'),
    effectId: RequestIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('session.externalSession.follow.event'),
    effectId: RequestIdSchema,
    followId: RequestIdSchema,
    event: AgentRuntimeDaemonExternalSessionFollowEventV1Schema,
  }).strict(),
]);

export type AgentRuntimeDaemonBridgeEffectV1 =
  z.infer<typeof AgentRuntimeDaemonBridgeEffectV1Schema>;

const AgentRuntimeDaemonBridgePollResultV1Schema = z.object({
  events: z.array(AgentSessionRuntimeEventV1Schema)
    .max(
      AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates
        .preWatchReplayBufferMaxEvents,
    ),
  effects: z.array(AgentRuntimeDaemonBridgeEffectV1Schema)
    .max(
      AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates
        .preWatchReplayBufferMaxEvents,
    ),
}).strict().superRefine((value, context) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (
    bytes
      > AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates
        .preWatchReplayBufferMaxJsonBytes
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Agent runtime daemon bridge poll result exceeds the aggregate byte bound',
    });
  }
});

export const AgentRuntimeDaemonBridgeSuccessResultV1Schema = z.union([
  AgentRuntimeDaemonBridgePollResultV1Schema,
  AgentRuntimeJsonValueV1Schema,
]);

export const AgentRuntimeDaemonBridgeResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    result: AgentRuntimeDaemonBridgeSuccessResultV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().trim().min(1).max(256),
      message: z.string().max(4_096),
    }).strict(),
  }).strict(),
]);

export type AgentRuntimeDaemonBridgeResponseV1 =
  z.infer<typeof AgentRuntimeDaemonBridgeResponseV1Schema>;
