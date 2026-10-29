import type { ActionSpecSurfaceBindings, PreNormalizedActionSpec } from '../definition.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionIdSchema } from '../../../sessions/idsV1.js';
import { RawIngressStructuredInputV1Schema } from '../../../runtime/input/structuredInputV1.js';
import { SessionTargetV1Schema } from '../../sessionTargetV1.js';
import { z } from 'zod/mini';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1 } from '../../../discussions/actions.js';
import { SubagentLaunchV1Schema } from '../../../messages/structured/subagentLaunchV1.js';
import { SubagentCommandV1Schema } from '../../../messages/structured/subagentCommandV1.js';
import { BackendTargetRefV2Schema } from '../../../backends/targets/backendTargetRefV2.js';
import { RuntimeDescriptorV1Schema } from '../../../sessions/metadata/runtimeDescriptorV1.js';
import { PluginSessionInputIdempotencyKeyV1Schema, PluginSessionUserTextAuthoredFieldSchemasV1, requireSessionInputContent, SessionMessageSendActionResultV1Schema } from '../../../sessions/messages/sessionInputAdmission.js';
import { PendingLocalIdSchema } from '../../../sessions/pending/pendingLocalId.js';
import { SessionMessageExplicitReplyV1Schema, SessionMessageReplyMutationResultV1Schema } from '../../../sessions/messages/sessionMessageReplyV1.js';
import { AutonomousExchangeObservedRevisionV1Schema, AutonomousExchangeStatusV1Schema } from '../../../sessions/messages/autonomousExchangeV1.js';
import { PendingRequestedActionV1Schema } from '../../../sessions/pending/pendingRequestedActionV1.js';
import { ProviderConnectionIdSchema } from '../../../providers/ids.js';
import { resolveActionBackendTargetSelection } from '../../resolveActionBackendTargetSelection.js';
import { SESSION_SEND_CLI_PROJECTION } from './sendCli.js';
import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';


export function validateAgentIdAndBackendTargetKeySelection(
  value: Readonly<{
    agentId?: string;
    backendTargetKey?: string;
    backendTarget?: z.infer<typeof BackendTargetRefV2Schema>;
    runtimeDescriptorV1?: z.infer<typeof RuntimeDescriptorV1Schema>;
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  const resolved = resolveActionBackendTargetSelection(value);
  if (!resolved.ok) {
    ctx.addIssue({
      code: "custom",
      message: resolved.message,
      path: [resolved.path],
    });
  }
}

export function validateStringAliasPair(
  value: Readonly<Record<string, unknown>>,
  ctx: z.core.$RefinementCtx,
  params: Readonly<{ primary: string; alias: string }>,
): void {
  const primaryValue = value[params.primary];
  const aliasValue = value[params.alias];
  if (typeof primaryValue !== 'string' || typeof aliasValue !== 'string') return;
  if (primaryValue.trim() === aliasValue.trim()) return;
  ctx.addIssue({
    code: "custom",
    message: `${params.primary} and ${params.alias} must match when both are provided`,
    path: [params.alias],
  });
}

export const SessionSendUserTextInputFieldsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(SessionTargetV1Schema),
  recipient: PluginSessionUserTextAuthoredFieldSchemasV1.recipient,
  // The executor re-admits a plugin-bound input through this canonical shape
  // before dispatch. Keep the content rule here too: attachment-only is valid,
  // while the executor still rejects authored attachments from non-plugin
  // callers before the writer.
  message: z.string(),
  /** Raw Composer context; the target's existing input owner admits it before commit. */
  structuredInput: z.optional(RawIngressStructuredInputV1Schema),
  requestedAction: z.optional(PendingRequestedActionV1Schema),
  /**
   * The caller-retained stable identity for this durable input. Resubmitting
   * the same localId rejoins the existing pending input instead of queueing a
   * second message, so an ambiguous send can be retried safely. Plugin callers
   * cannot supply it: their identity is host-derived from `idempotencyKey`.
   */
  localId: z.optional(PendingLocalIdSchema),
  idempotencyKey: z.optional(PluginSessionUserTextAuthoredFieldSchemasV1.idempotencyKey),
  source: PluginSessionUserTextAuthoredFieldSchemasV1.source,
  attachments: PluginSessionUserTextAuthoredFieldSchemasV1.attachments,
  forgeEvidence: PluginSessionUserTextAuthoredFieldSchemasV1.forgeEvidence,
  toolAnswerDelivery: PluginSessionUserTextAuthoredFieldSchemasV1.toolAnswerDelivery,
  permissionModeOverride: z.optional(z.string().check(z.trim(), z.minLength(1))),
  modelOverride: z.optional(z.union([z.string().check(z.trim(), z.minLength(1)), z.null()])),
  providerConnectionId: z.optional(z.nullable(ProviderConnectionIdSchema)),
  wait: z.optional(z.boolean()),
  reply: z.optional(z.enum(['none', 'wait', 'return'])),
  /** Exact destination for a person's Ask; never an Agent causal-turn assertion. */
  returnToSessionId: z.optional(asProtocolZod(SessionIdSchema)),
  timeoutSeconds: z.optional(z.number().check(z.int(), z.minimum(1))),
}));

export function validateSessionSendProviderSelection(
  value: z.infer<typeof SessionSendUserTextInputFieldsSchema>,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.requestedAction?.kind === 'recover_execution_run' && value.recipient?.kind !== 'execution_run') {
    ctx.addIssue({ code: 'custom', path: ['recipient'], message: 'Execution Run recovery requires an exact Run recipient' });
  }
  if (value.reply !== undefined && value.wait !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['reply'], message: 'reply and legacy wait cannot be combined' });
  }
  if (value.returnToSessionId !== undefined && value.reply !== 'return') {
    ctx.addIssue({ code: 'custom', path: ['returnToSessionId'], message: 'A human return destination requires return reply mode' });
  }
  if (value.providerConnectionId === undefined) return;
  // A Provider connection is only ever applied together with the model
  // selection it sources. Without a `modelOverride` the send path composes no
  // selection at all, so the connection — including the explicit native `null`
  // — would be accepted and then silently discarded.
  if (value.modelOverride === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ['modelOverride'],
      message: 'modelOverride must be provided when providerConnectionId is set',
    });
    return;
  }
  if (value.providerConnectionId !== null && typeof value.modelOverride !== 'string') {
    ctx.addIssue({
      code: "custom",
      path: ['modelOverride'],
      message: 'modelOverride must be a concrete model id when providerConnectionId is set',
    });
  }
}

export const SessionSendUserTextInputSchema = lazyZodSchema(() => SessionSendUserTextInputFieldsSchema.check(z.superRefine(requireSessionInputContent), z.superRefine(validateSessionSendProviderSelection)));

// Public callers author text and routing intent, never plugin source or attachment authority.
export const SessionSendUserTextPublicInputSchema = lazyZodSchema(() => z.omit(SessionSendUserTextInputFieldsSchema, { idempotencyKey: true, source: true, attachments: true, toolAnswerDelivery: true }).check(z.superRefine(requireSessionInputContent), z.superRefine(validateSessionSendProviderSelection)));

/** Plugin Session messages carry only host-attributed admission intent. */
export const SessionSendUserTextPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  // Blank only when an attachment carries the input, decided by the one
  // `requireSessionInputContent` owner this binding shares with
  // `PluginSessionInputRequestV1Schema`. A `.min(1)` here would let the Action
  // surface refuse an attachment-only input the seam beneath it admits.
  message: z.string(),
  ...PluginSessionUserTextAuthoredFieldSchemasV1,
  ...z.pick(SessionSendUserTextInputFieldsSchema, { reply: true, wait: true, timeoutSeconds: true }).shape,
}).check(z.superRefine(requireSessionInputContent), z.superRefine((value, ctx) => {
  if (value.reply !== undefined && value.wait !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['reply'], message: 'reply and legacy wait cannot be combined' });
  }
})));

export const SessionSendSubagentLaunchPluginInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  kind: z.literal('sessionSubagentLaunch'),
  launch: SubagentLaunchV1Schema,
  idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}));

export const SessionSendSubagentCommandInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  kind: z.literal('sessionSubagentCommand'),
  command: SubagentCommandV1Schema,
  idempotencyKey: z.optional(PluginSessionInputIdempotencyKeyV1Schema),
  localId: z.optional(PendingLocalIdSchema),
}));

export const SessionSendSubagentCommandPluginInputV1Schema = lazyZodSchema(() => z.extend(z.omit(SessionSendSubagentCommandInputSchema, { localId: true }), { idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema }));

export const SessionSendMessagePublicInputSchema = lazyZodSchema(() => z.union([
  SessionSendUserTextPublicInputSchema,
  SessionSendSubagentCommandInputSchema,
]));

export const SessionSendMessagePluginInputV1Schema = lazyZodSchema(() => z.union([
  SessionSendUserTextPluginInputV1Schema,
  SessionSendSubagentLaunchPluginInputV1Schema,
  SessionSendSubagentCommandPluginInputV1Schema,
]));

export const SessionSendMessageInputSchema = lazyZodSchema(() => z.union([
  SessionSendUserTextInputSchema,
  SessionSendSubagentLaunchPluginInputV1Schema,
  SessionSendSubagentCommandInputSchema,
]));
export type SessionMessageSendAuthoredInput = z.infer<typeof SessionSendMessageInputSchema>;

export const SessionMessageReplyInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  requestLocalId: PendingLocalIdSchema,
  reply: SessionMessageExplicitReplyV1Schema,
}));

export const sessionExchangeControlInputArms = <TExtra extends z.core.$ZodShape>(extra: TExtra) => {
  const common = { sessionId: SessionTargetV1Schema, originInputLocalId: PendingLocalIdSchema,
    ...extra };
  return z.union([
    z.strictObject({ ...common, decision: z.literal('continue') }),
    z.strictObject({ ...common, decision: z.literal('continue_more'), additionalTurns: z.optional(z.literal(10)) }),
    z.strictObject({ ...common, decision: z.literal('stop') }),
  ]);
};
export const SessionExchangeControlInputSchema = lazyZodSchema(() => sessionExchangeControlInputArms({
  observedRevision: z.optional(AutonomousExchangeObservedRevisionV1Schema),
}));
export const SessionExchangeControlPublicInputSchema = lazyZodSchema(() => sessionExchangeControlInputArms({}));

export const SESSION_MESSAGE_ACTION_SPECS = Object.freeze([
  {
    id: 'session.message.send', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Send a message to a session',
    sideEffectClass: 'external',
    description: 'Send information or ask an agent Session for one answer. reply none creates no answer obligation; wait observes the exact answer inline; return retains a later answer to the admitted source Session. A timeout stops observation without cancelling accepted work. Session selectors grant no access.',
    safety: 'safe',
    placements: ['voice_panel'],
    // Its full routing schema is discovered on demand, then used by action_execute.
    bindings: { voiceClientToolName: 'sendSessionMessage', mcpToolName: 'session_message_send' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","message":"Please inspect the latest changes.","reply":"wait"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Send information with reply none, ask and wait inline with reply wait, or get an answer later with reply return to the admitted source Session. Timeout ends observation, not accepted work. Returned answers need no acknowledgment.',
      title: 'Send a message',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'message', title: 'Message', widget: 'textarea', required: true },
        { path: 'recipient', title: 'Recipient', description: 'Optional participant routing identity; omit to send to the main Session.', widget: 'json' },
        { path: 'permissionModeOverride', title: 'Permission mode override (optional)', widget: 'text' },
        { path: 'modelOverride', title: 'Model override (optional)', widget: 'text' },
        { path: 'providerConnectionId', title: 'Provider connection id (optional)', widget: 'text' },
        { path: 'reply', title: 'Reply mode (optional)', description: 'none sends information; wait observes the exact answer; return hands off its answer to the original Session.', widget: 'select', options: [
          { value: 'none', label: 'No reply' }, { value: 'wait', label: 'Wait' }, { value: 'return', label: 'Return later' },
        ] },
        { path: 'wait', title: 'Wait for message completion (optional)', widget: 'boolean' },
        { path: 'timeoutSeconds', title: 'Timeout seconds (optional)', widget: 'text' },
      ],
    },
    outputSchema: SessionMessageSendActionResultV1Schema,
    inputSchema: SessionSendMessageInputSchema,
    cli: { ...SESSION_SEND_CLI_PROJECTION, wholeInputSchema: SessionSendMessagePublicInputSchema },
    surfaceBindings: {
      api: {
        inputSchema: SessionSendMessagePublicInputSchema,
        outputSchema: SessionMessageSendActionResultV1Schema,
      },
      plugin: {
        inputSchema: SessionSendMessagePluginInputV1Schema,
        outputSchema: SessionMessageSendActionResultV1Schema,
      },
    } satisfies ActionSpecSurfaceBindings,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.message.reply', approval: { result: 'optional', flow: 'deferred' },
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    executionPlacement: 'session',
    title: 'Reply to a Session request',
    description: 'Publish an answer or pass for one exact admitted request in the receiving Session.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_message_reply', voiceClientToolName: 'session_message_reply', rpcMethod: 'session.message.reply' },
    examples: { voice: { argsExample: '{"sessionId":"{{sessionId}}","requestLocalId":"original-input-id","reply":{"kind":"pass"}}' } },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { title: 'Reply to a Session request', fields: [
      { path: 'sessionId', title: 'Receiving Session', widget: 'text', required: true },
      { path: 'requestLocalId', title: 'Original input id', widget: 'text', required: true },
      { path: 'reply', title: 'Answer or pass', widget: 'json', required: true },
    ] },
    inputSchema: SessionMessageReplyInputSchema,
    outputSchema: SessionMessageReplyMutationResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'discussion.pass', approval: { result: 'optional', flow: 'deferred' },
    executionPlacement: 'session',
    title: 'Pass on the current Discussion question',
    description: 'Settle the current participant’s exact admitted Discussion question with a typed pass, without posting an authored substitute message.',
    sideEffectClass: 'external', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'discussion_pass', voiceClientToolName: 'discussion_pass' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { fields: [{ path: 'discussionId', title: 'Discussion id', widget: 'text', required: true }] },
    inputSchema: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.pass'],
    outputSchema: DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1['discussion.pass'],
    cli: { acceptsServerId: true, commands: [{ path: ['discussions', 'pass'], positionals: ['discussionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.exchange.control', approval: { result: 'optional', flow: 'deferred' },
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    title: 'Control autonomous exchange',
    description: 'Continue, continue ten more turns, or stop work rooted in one original input.',
    sideEffectClass: 'danger',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_exchange_control', voiceClientToolName: 'session_exchange_control' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: SessionExchangeControlInputSchema,
    outputSchema: AutonomousExchangeStatusV1Schema,
    surfaceBindings: { api: { inputSchema: SessionExchangeControlPublicInputSchema,
      outputSchema: AutonomousExchangeStatusV1Schema },
      plugin: { inputSchema: SessionExchangeControlPublicInputSchema,
        outputSchema: AutonomousExchangeStatusV1Schema } } satisfies ActionSpecSurfaceBindings,
    cli: { commands: [{ path: ['session', 'exchange', 'control'], positionals: ['sessionId', 'originInputLocalId', 'decision'], visibility: 'canonical' }],
      wholeInputSchema: SessionExchangeControlPublicInputSchema },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'originInputLocalId', title: 'Original input id', widget: 'text', required: true },
      { path: 'decision', title: 'Control', widget: 'select', required: true,
        options: [
          { value: 'continue', label: 'Continue' },
          { value: 'continue_more', label: 'Continue 10 more' },
          { value: 'stop', label: 'Stop' },
        ] },
      { path: 'additionalTurns', title: 'Additional turns', widget: 'number' },
    ] },
  } satisfies PreNormalizedActionSpec,
] as const);

