import { z } from 'zod';

import { PluginAgentAcpTransportSchema } from '@happier-dev/protocol';
import {
  AgentRuntimeJsonValueV1Schema,
  AgentSessionCompactRequestV1Schema,
  AgentSessionConfigurationUpdateV1Schema,
  AgentSessionConversationRollbackReconciliationResultV1Schema,
  AgentSessionConversationRollbackRequestV1Schema,
  AgentSessionConversationRollbackResultV1Schema,
  AgentSessionProviderCheckpointV1Schema,
  AgentSessionRuntimeEventV1Schema,
  AgentSessionSendRequestV1Schema,
} from '@happier-dev/protocol/runtime';
import {
  ACP_HISTORY_EXTENSION_METHOD_LIMIT,
  isNamespacedAcpExtensionMethod,
} from '@/agent/acp/history/acpHistoryExtensionMethods';

const BoundedIdSchema = z.string().trim().min(1).max(256);
const BoundedTextSchema = z.string().max(262_144);
const PositiveMsSchema = z.number().int().min(1).max(2_147_483_647);
const JsonObjectSchema = z.record(z.string().max(256), AgentRuntimeJsonValueV1Schema);
const ModelRequestMetadataSchema = JsonObjectSchema.refine(
  (value) => JSON.stringify(value).length <= 16_384,
  'ACP model request metadata exceeds the public session bound',
);
const ExtensionMethodSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u);
const HistoryExtensionMethodSchema = ExtensionMethodSchema.refine(
  isNamespacedAcpExtensionMethod,
  'ACP history extension methods must be namespaced',
);

const DiagnosticSchema = z.object({
  code: BoundedIdSchema,
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(4_096).optional(),
}).strict();

const AcpModelOptionSchema = z.object({
  id: BoundedIdSchema,
  name: z.string().min(1).max(4_096),
  description: BoundedTextSchema.optional(),
  type: BoundedIdSchema,
  currentValue: z.string().max(262_144),
  options: z.array(z.object({
    value: z.string().max(262_144),
    name: z.string().min(1).max(4_096),
    description: BoundedTextSchema.optional(),
  }).strict()).max(1_024).optional(),
}).strict();

const AcpModelSchema = z.object({
  id: BoundedIdSchema,
  name: z.string().min(1).max(4_096),
  description: BoundedTextSchema.optional(),
  modelOptions: z.array(AcpModelOptionSchema).max(1_024).optional(),
}).strict();

const AcpTimeoutsSchema = z.object({
  initMs: PositiveMsSchema.optional(),
  initDelayMs: PositiveMsSchema.optional(),
  idleMs: PositiveMsSchema.optional(),
  toolCallMs: PositiveMsSchema.nullable().optional(),
  investigationToolCallMs: PositiveMsSchema.nullable().optional(),
  toolKindTimeouts: z.record(BoundedIdSchema, PositiveMsSchema.nullable()).optional(),
  promptLivenessMs: PositiveMsSchema.nullable().optional(),
  postPromptNoUpdatesMs: PositiveMsSchema.nullable().optional(),
  postToolCallIdleMs: PositiveMsSchema.optional(),
  idleWithoutAssistantMessageMs: PositiveMsSchema.optional(),
  preToolCallIdleMs: PositiveMsSchema.optional(),
}).strict();

const BoundedStringListSchema = z.array(z.string().min(1).max(4_096)).max(1_024);
const AcpToolNameInferenceSchema = z.object({
  patterns: z.array(z.object({
    name: BoundedIdSchema,
    patterns: BoundedStringListSchema.min(1),
    inputFields: BoundedStringListSchema.optional(),
    emptyInputDefault: z.boolean().optional(),
  }).strict()).max(1_024).optional(),
  preferLongestPattern: z.boolean().optional(),
  unknownToolNames: BoundedStringListSchema.optional(),
  hintInputFields: BoundedStringListSchema.optional(),
  shellBridgeHint: z.boolean().optional(),
  investigationToolIdPatterns: BoundedStringListSchema.optional(),
  investigationToolKinds: BoundedStringListSchema.optional(),
}).strict();

const StderrMatchRuleSchema = z.object({
  includes: BoundedStringListSchema.min(1),
  caseSensitive: z.boolean().optional(),
}).strict();
const AcpStderrRulesSchema = z.object({
  suppress: z.array(StderrMatchRuleSchema).max(1_024).optional(),
  statusErrors: z.array(StderrMatchRuleSchema.extend({
    detail: BoundedTextSchema,
  }).strict()).max(1_024).optional(),
}).strict();

const ExtensionCallbackSchema = z.object({
  kind: z.enum(['request', 'notification']),
  method: ExtensionMethodSchema,
  callbackId: BoundedIdSchema,
}).strict();

const ResolvedExecutableCommandSchema = z.string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Executable command cannot contain null bytes');
const ResolvedExecutableArgumentSchema = z.string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Executable argument cannot contain null bytes');
const ResolvedExecutableEnvironmentSchema = z.record(
  z.string().min(1).max(256),
  z.string().max(262_144),
);

export const AgentRuntimeDaemonAcpResolvedExecutableV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('systemTool'),
    toolId: BoundedIdSchema,
    command: ResolvedExecutableCommandSchema,
    args: z.array(ResolvedExecutableArgumentSchema).max(1_024).optional(),
    env: ResolvedExecutableEnvironmentSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('managedDependency'),
    dependencyId: BoundedIdSchema,
    command: ResolvedExecutableCommandSchema,
    args: z.array(ResolvedExecutableArgumentSchema).max(1_024).optional(),
    env: ResolvedExecutableEnvironmentSchema.optional(),
  }).strict(),
]);

export type AgentRuntimeDaemonAcpResolvedExecutableV1 =
  z.infer<typeof AgentRuntimeDaemonAcpResolvedExecutableV1Schema>;

export const AgentRuntimeDaemonAcpOptionsV1Schema = z.object({
  transport: PluginAgentAcpTransportSchema,
  resolvedExecutable: AgentRuntimeDaemonAcpResolvedExecutableV1Schema.optional(),
  definition: z.object({
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('method'), methodId: BoundedIdSchema }).strict(),
      z.object({ kind: z.literal('callback'), callbackId: BoundedIdSchema }).strict(),
    ]).optional(),
    parameterizedModelPicker: z.boolean().optional(),
    modelConfigOptionId: BoundedIdSchema.optional(),
    models: z.object({
      projectModelCallbackId: BoundedIdSchema,
      projectUpdateCallbackId: BoundedIdSchema.optional(),
      projectSetModelResponseCallbackId: BoundedIdSchema.optional(),
    }).strict().optional(),
    acceptsVerifiedImageInput: z.literal(true).optional(),
    timeouts: AcpTimeoutsSchema.optional(),
    toolNameInference: AcpToolNameInferenceSchema.optional(),
    stderrRules: AcpStderrRulesSchema.optional(),
    toolNameResolverCallbackId: BoundedIdSchema.optional(),
    sanitizeToolUpdateContentCallbackId: BoundedIdSchema.optional(),
    generatedMedia: z.object({
      projectTerminalOutputCallbackId: BoundedIdSchema,
    }).strict().optional(),
    history: z.object({
      projectUserMessageProviderCheckpointCallbackId: BoundedIdSchema,
      fork: z.object({
        methods: z.tuple(
          [HistoryExtensionMethodSchema],
          HistoryExtensionMethodSchema,
        ).refine(
          (methods) => methods.length <= ACP_HISTORY_EXTENSION_METHOD_LIMIT,
          'ACP history fork extension method tuple limit exceeded',
        ),
        buildParamsCallbackId: BoundedIdSchema,
        readProviderSessionIdCallbackId: BoundedIdSchema,
      }).strict().optional(),
      createConversationRollbackCallbackId: BoundedIdSchema.optional(),
    }).strict().optional(),
    mcp: z.object({ policy: z.enum(['pass_through', 'drop']) }).strict(),
  }).strict().optional(),
  extensions: z.array(ExtensionCallbackSchema).max(256).superRefine((entries, context) => {
    const identities = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const identity = `${entry.kind}:${entry.method}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Duplicate ACP extension callback identity',
        });
      }
      identities.add(identity);
    }
  }).optional(),
}).strict();

export type AgentRuntimeDaemonAcpOptionsV1 =
  z.infer<typeof AgentRuntimeDaemonAcpOptionsV1Schema>;

export const AGENT_RUNTIME_DAEMON_ACP_REVERSE_SESSION_LOSS_DISPOSE_REASON =
  'runtime_recovery' as const;

const ChildCallShape = {
  effectId: BoundedIdSchema,
  reverseSessionId: BoundedIdSchema,
} as const;
const DaemonCallShape = {
  requestId: BoundedIdSchema,
  reverseSessionId: BoundedIdSchema,
} as const;

export function createAgentRuntimeDaemonAcpOpenOperationV1Schema<
  RequestSchema extends z.ZodType,
>(requestSchema: RequestSchema) {
  return z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.open'),
    request: requestSchema,
    options: AgentRuntimeDaemonAcpOptionsV1Schema,
  }).strict();
}

export const AgentRuntimeDaemonAcpCompletionEvidenceV1Schema = z.object({
  providerSessionId: BoundedIdSchema,
  promptId: BoundedIdSchema,
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('completed') }).strict(),
    z.object({ kind: z.literal('cancelled') }).strict(),
    z.object({
      kind: z.literal('failed'),
      message: z.string().max(1_024).optional(),
    }).strict(),
  ]),
}).strict();

export const AgentRuntimeDaemonAcpChildOperationV1Schema = z.discriminatedUnion('kind', [
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.send'),
    request: AgentSessionSendRequestV1Schema,
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.cancel'),
    turnId: BoundedIdSchema,
    reason: z.enum(['user', 'hostShutdown', 'sessionDispose', 'runtimeRecovery']),
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.updateConfiguration'),
    request: AgentSessionConfigurationUpdateV1Schema,
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.compact'),
    request: AgentSessionCompactRequestV1Schema,
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.rollback'),
    request: AgentSessionConversationRollbackRequestV1Schema,
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.reconcileRollback'),
    request: AgentSessionConversationRollbackRequestV1Schema,
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.session.dispose'),
    reason: z.enum([
      'session_closed',
      'plugin_deactivated',
      'host_shutdown',
      'runtime_recovery',
    ]),
  }).strict(),
  z.object({
    ...ChildCallShape,
    kind: z.literal('acp.historySession.requestExtension'),
    historySessionId: BoundedIdSchema,
    methods: z.tuple(
      [HistoryExtensionMethodSchema],
      HistoryExtensionMethodSchema,
    ).refine(
      (methods) => methods.length <= ACP_HISTORY_EXTENSION_METHOD_LIMIT,
      'ACP history extension method tuple limit exceeded',
    ),
    params: AgentRuntimeJsonValueV1Schema,
    timeoutMs: PositiveMsSchema.optional(),
  }).strict(),
]);

export type AgentRuntimeDaemonAcpChildOperationV1 =
  z.infer<typeof AgentRuntimeDaemonAcpChildOperationV1Schema>;

const ExtensionContextSchema = z.object({
  method: ExtensionMethodSchema,
  requestId: BoundedIdSchema.optional(),
  providerSessionId: BoundedIdSchema.optional(),
  currentTurn: z.object({
    turnId: BoundedIdSchema,
    completionEvidenceId: BoundedIdSchema,
  }).strict().optional(),
}).strict();

const AgentConfigurationScalarSchema = z.union([
  z.string().max(262_144),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const AgentRuntimeDaemonAcpDaemonOperationV1Schema = z.discriminatedUnion('kind', [
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.auth.selectMethod'),
    callbackId: BoundedIdSchema,
    context: z.object({
      advertisedMethodIds: z.array(BoundedIdSchema).max(256),
      initializeMetadata: JsonObjectSchema.nullable(),
    }).strict(),
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.model.project'),
    callbackId: BoundedIdSchema,
    rawModel: AgentRuntimeJsonValueV1Schema,
    normalizedModel: AcpModelSchema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.model.projectUpdate'),
    callbackId: BoundedIdSchema,
    input: z.object({
      configId: BoundedIdSchema,
      value: AgentConfigurationScalarSchema,
      currentModel: AcpModelSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.model.projectSetModelResponse'),
    callbackId: BoundedIdSchema,
    input: z.object({
      response: AgentRuntimeJsonValueV1Schema,
      requestedModelId: BoundedIdSchema,
      requestMeta: ModelRequestMetadataSchema.nullable(),
      targetModel: AcpModelSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.tool.resolveName'),
    callbackId: BoundedIdSchema,
    request: z.object({
      toolName: BoundedTextSchema,
      toolCallId: BoundedIdSchema,
      input: JsonObjectSchema,
      context: z.object({
        toolCallCountSincePrompt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.tool.sanitizeUpdate'),
    callbackId: BoundedIdSchema,
    update: JsonObjectSchema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.generatedMedia.projectTerminalOutput'),
    callbackId: BoundedIdSchema,
    input: z.object({
      rawOutput: AgentRuntimeJsonValueV1Schema,
      toolCallId: BoundedIdSchema,
      toolName: BoundedTextSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.history.projectUserMessageProviderCheckpoint'),
    callbackId: BoundedIdSchema,
    input: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.history.fork.buildParams'),
    callbackId: BoundedIdSchema,
    input: z.object({
      sourceProviderSessionId: BoundedIdSchema,
      sourceCwd: z.string().min(1).max(32_768),
      newCwd: z.string().min(1).max(32_768),
      providerCheckpoint: AgentRuntimeJsonValueV1Schema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.history.fork.readProviderSessionId'),
    callbackId: BoundedIdSchema,
    response: AgentRuntimeJsonValueV1Schema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.history.createConversationRollback'),
    callbackId: BoundedIdSchema,
    historySessionId: BoundedIdSchema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.history.rollback'),
    controlId: BoundedIdSchema,
    request: AgentSessionConversationRollbackRequestV1Schema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.history.reconcile'),
    controlId: BoundedIdSchema,
    request: AgentSessionConversationRollbackRequestV1Schema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.extension.request'),
    callbackId: BoundedIdSchema,
    params: AgentRuntimeJsonValueV1Schema,
    context: ExtensionContextSchema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.extension.notification'),
    callbackId: BoundedIdSchema,
    params: AgentRuntimeJsonValueV1Schema,
    context: ExtensionContextSchema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.session.event'),
    event: AgentSessionRuntimeEventV1Schema,
  }).strict(),
  z.object({
    ...DaemonCallShape,
    kind: z.literal('acp.callback.cancel'),
    targetRequestId: BoundedIdSchema,
  }).strict(),
]);

export type AgentRuntimeDaemonAcpDaemonOperationV1 =
  z.infer<typeof AgentRuntimeDaemonAcpDaemonOperationV1Schema>;

const SendResultSchema = z.union([
  z.object({ status: z.literal('admitted') }).strict(),
  z.object({
    status: z.enum(['rejected', 'unavailable', 'unsupported']),
    diagnostic: DiagnosticSchema,
    retryable: z.boolean(),
  }).strict(),
]);
const CancelResultSchema = z.union([
  z.object({ status: z.literal('requested'), turnId: BoundedIdSchema }).strict(),
  z.object({
    status: z.enum(['notRunning', 'unavailable', 'unsupported']),
    diagnostic: DiagnosticSchema.optional(),
  }).strict(),
]);
const ConfigurationResultSchema = z.union([
  z.object({
    status: z.enum(['applied', 'deferred']),
    changed: z.array(BoundedIdSchema).max(1_024),
  }).strict(),
  z.object({
    status: z.enum(['rejected', 'unavailable', 'unsupported']),
    diagnostic: DiagnosticSchema,
  }).strict(),
]);
const CompactResultSchema = z.union([
  z.object({ status: z.literal('admitted') }).strict(),
  z.object({
    status: z.enum(['rejected', 'unavailable', 'unsupported']),
    diagnostic: DiagnosticSchema,
    retryable: z.boolean(),
  }).strict(),
]);

export const AgentRuntimeDaemonAcpOpenResultV1Schema = z.object({
  reverseSessionId: BoundedIdSchema,
  methods: z.array(z.enum([
    'cancel',
    'updateConfiguration',
    'compact',
    'rollback',
    'reconcileRollback',
  ])).max(5).refine(
    (methods) => new Set(methods).size === methods.length,
    'ACP reverse-session methods must be duplicate-free',
  ),
}).strict();

export function parseAgentRuntimeDaemonAcpChildOperationResultV1(
  operation: AgentRuntimeDaemonAcpChildOperationV1,
  value: unknown,
): unknown {
  switch (operation.kind) {
    case 'acp.session.send':
      return SendResultSchema.parse(value);
    case 'acp.session.cancel':
      return CancelResultSchema.parse(value);
    case 'acp.session.updateConfiguration':
      return ConfigurationResultSchema.parse(value);
    case 'acp.session.compact':
      return CompactResultSchema.parse(value);
    case 'acp.session.rollback':
      return AgentSessionConversationRollbackResultV1Schema.parse(value);
    case 'acp.session.reconcileRollback':
      return AgentSessionConversationRollbackReconciliationResultV1Schema.parse(value);
    case 'acp.historySession.requestExtension':
      return AgentRuntimeJsonValueV1Schema.parse(value);
    case 'acp.session.dispose':
      return z.null().parse(value);
  }
}

const AuthSelectionSchema = z.object({
  methodId: BoundedIdSchema,
  metadata: JsonObjectSchema.optional(),
}).strict().nullable();
const ModelUpdateSchema = z.object({
  modelId: BoundedIdSchema,
  requestMeta: ModelRequestMetadataSchema.optional(),
}).strict().nullable();
const GeneratedMediaSchema = z.array(z.object({
  rootPath: z.string().min(1).max(4_096),
  path: z.string().min(1).max(4_096),
}).strict()).max(8).nullable();
const ConversationRollbackControlSchema = z.object({
  controlId: BoundedIdSchema,
}).strict();
const ExtensionCompletionEvidenceSchema =
  AgentRuntimeDaemonAcpCompletionEvidenceV1Schema.nullable();
const ExtensionRequestResultSchema = z.object({
  value: AgentRuntimeJsonValueV1Schema,
  completionEvidence: ExtensionCompletionEvidenceSchema,
}).strict();
const ExtensionNotificationResultSchema = z.object({
  completionEvidence: ExtensionCompletionEvidenceSchema,
}).strict();

export function parseAgentRuntimeDaemonAcpDaemonOperationResultV1(
  operation: AgentRuntimeDaemonAcpDaemonOperationV1,
  value: unknown,
): unknown {
  switch (operation.kind) {
    case 'acp.callback.auth.selectMethod':
      return AuthSelectionSchema.parse(value);
    case 'acp.callback.model.project':
      return AcpModelSchema.parse(value);
    case 'acp.callback.model.projectUpdate':
      return ModelUpdateSchema.parse(value);
    case 'acp.callback.model.projectSetModelResponse':
      return AcpModelSchema.nullable().parse(value);
    case 'acp.callback.tool.resolveName':
      return z.string().max(262_144).nullable().parse(value);
    case 'acp.callback.tool.sanitizeUpdate':
      return JsonObjectSchema.parse(value);
    case 'acp.callback.generatedMedia.projectTerminalOutput':
      return GeneratedMediaSchema.parse(value);
    case 'acp.callback.history.projectUserMessageProviderCheckpoint':
      return AgentSessionProviderCheckpointV1Schema.nullable().parse(value);
    case 'acp.callback.history.fork.buildParams':
      return AgentRuntimeJsonValueV1Schema.parse(value);
    case 'acp.callback.extension.request':
      return ExtensionRequestResultSchema.parse(value);
    case 'acp.callback.history.fork.readProviderSessionId':
      return BoundedIdSchema.nullable().parse(value);
    case 'acp.callback.history.createConversationRollback':
      return ConversationRollbackControlSchema.parse(value);
    case 'acp.callback.history.rollback':
      return AgentSessionConversationRollbackResultV1Schema.parse(value);
    case 'acp.callback.history.reconcile':
      return AgentSessionConversationRollbackReconciliationResultV1Schema.parse(value);
    case 'acp.callback.extension.notification':
      return ExtensionNotificationResultSchema.parse(value);
    case 'acp.session.event':
    case 'acp.callback.cancel':
      return z.null().parse(value);
  }
}
