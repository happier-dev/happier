import { requirePluginBindingCaller } from '../pluginPermissions.js';
import type { ActionSurfaceBindingContext, PreNormalizedActionSpec } from '../definition.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionTargetV1Schema } from '../../sessionTargetV1.js';
import { SessionNeedsYouRaiseInputV1Schema, SessionNeedsYouRaiseOutputV1Schema } from '../../../sessions/permissions/questionV1.js';
import { z } from 'zod/mini';
import { SessionPermissionRespondActionDecisionV1Schema, SessionPermissionRespondRpcParamsV1Schema } from '../../../sessions/permissions/respondRpcParamsV1.js';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from '../../../connect/sessionConnectedServiceAuthSwitch.js';
import { SessionPermissionRemoteGrantRevokeInputV1Schema, SessionPermissionRemoteGrantRevokeOutputV1Schema, SessionPermissionRemoteGrantsListInputV1Schema, SessionPermissionRemoteGrantsListOutputV1Schema, SessionPermissionRemotePendingListInputV1Schema, SessionPermissionRemotePendingListOutputV1Schema, SessionPermissionRemoteRespondInputV1Schema, SessionPermissionRemoteRespondOutputV1Schema, SessionUserActionRemoteAnswerInputV1Schema, SessionUserActionRemoteAnswerOutputV1Schema } from '../../../sessions/permissions/v1.js';
import { VoiceTrackedSessionAddressV1Schema, VoiceTrackedTargetsActionResultV1Schema } from '../../../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { StructuredQuestionAnswersV1Schema } from '../../../tools/structuredQuestionAnswersV1.js';
import { SESSION_ATTENTION_STANDING_HTTP_PATH_V1, SessionAttentionSetInputV1Schema, SessionAttentionSetResultV1Schema } from '../../../sessions/organization/attentionAction.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { NonBlankOpaqueIdentifierSchema } from '../../../strings/opaqueIdentifier.js';


export const SessionPermissionRespondInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  decision: SessionPermissionRespondActionDecisionV1Schema,
  requestId: z.optional(z.string().check(z.minLength(1))),
  // Optional only at the released action compatibility boundary. Current UI
  // producers stamp it and current host requests require an exact match.
  turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  reason: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.reason,
  mode: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.mode,
  allowedTools: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.allowedTools,
  execPolicyAmendment: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.execPolicyAmendment,
  updatedPermissions: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.updatedPermissions,
  answers: SessionPermissionRespondRpcParamsV1Schema._zod.def.options[0].shape.answers,
}));

export const SessionUserActionAnswerItemSchema = lazyZodSchema(() => z.strictObject({
  question: z.string().check(z.minLength(1), z.refine((value) => value.trim().length > 0, {
    message: 'question must not be blank',
  })),
  values: z.optional(z.array(z.string()).check(z.minLength(1))),
  // Compatibility for clients through the released 0.2.2 preview. Remove `answer`
  // after that preview leaves the supported mixed-version window.
  answer: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine((value, ctx) => {
  if (value.answer !== undefined && value.values !== undefined) {
    ctx.addIssue({ code: "custom", message: 'answer and values cannot both be provided' });
  }
  if (value.answer === undefined && value.values === undefined) {
    ctx.addIssue({ code: "custom", message: 'answer or values is required' });
  }
})));

export function validateSessionUserActionAnswer(
  value: Readonly<{
    decision?: 'approve' | 'reject' | 'request_changes';
    disposition?: 'pass_up';
    updatedPermissions?: unknown;
    reason?: string;
    answers?: readonly Readonly<{
      question: string;
      values?: readonly string[];
      answer?: string;
    }>[];
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.disposition === 'pass_up') {
    if (value.decision !== undefined || value.answers !== undefined || value.updatedPermissions !== undefined
      || ['allowedTools', 'execPolicyAmendment', 'mode', 'approved'].some(key => Object.prototype.hasOwnProperty.call(value, key))) {
      ctx.addIssue({ code: 'custom', message: 'pass_up cannot include an answer or permission decision' });
    }
    return;
  }
  const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
  const structuredAnswers = Object.create(null) as Record<string, readonly string[]>;
  for (const [index, entry] of (value.answers ?? []).entries()) {
    if (Object.prototype.hasOwnProperty.call(structuredAnswers, entry.question)) {
      ctx.addIssue({
        code: "custom",
        message: 'duplicate question',
        path: ['answers', index, 'question'],
      });
      continue;
    }
    structuredAnswers[entry.question] = entry.values ?? [entry.answer!];
  }
  if (hasAnswers && !StructuredQuestionAnswersV1Schema.safeParse(structuredAnswers).success) {
    ctx.addIssue({
      code: "custom",
      message: 'invalid structured answers',
      path: ['answers'],
    });
  }
  if (!hasAnswers && value.decision === undefined) {
    ctx.addIssue({
      code: "custom",
      message: 'decision or answers is required',
      path: ['decision'],
    });
  }
  if (value.decision === 'request_changes'
    && !(typeof value.reason === 'string' && value.reason.trim().length > 0)) {
    ctx.addIssue({
      code: "custom",
      message: 'reason is required when decision=request_changes',
      path: ['reason'],
    });
  }
}

export const SessionUserActionAnswerInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  requestId: z.optional(z.string().check(z.minLength(1))),
  decision: z.optional(z.enum(['approve', 'reject', 'request_changes'])),
  disposition: z.optional(z.literal('pass_up')),
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
  answers: z.optional(z.array(SessionUserActionAnswerItemSchema).check(z.minLength(1))),
  updatedPermissions: z.optional(StrictJsonValueSchema),
}).check(z.superRefine(validateSessionUserActionAnswer)));

export const SessionUserActionAnswerPluginInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(SessionTargetV1Schema),
  requestId: z.string().check(z.minLength(1)),
  decision: z.optional(z.enum(['approve', 'reject', 'request_changes'])),
  disposition: z.optional(z.literal('pass_up')),
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
  answers: z.optional(z.array(SessionUserActionAnswerItemSchema).check(z.minLength(1))),
}).check(z.superRefine(validateSessionUserActionAnswer)));

export const SessionInteractionResponseSuccessSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
}));

export const SessionModeSetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  modeId: z.string(),
}));

export const SessionControlSwitchInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  to: z.enum(['remote', 'local']),
}));
export const SessionControlSwitchOutputSchema = lazyZodSchema(() => z.strictObject({ switched: z.literal(true) }));

export const SessionConfigOptionSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  configId: NonBlankOpaqueIdentifierSchema,
  valueId: z.string(),
}));

export const SessionConnectedServicesAuthSetInputSchema = lazyZodSchema(() => z.extend(SessionConnectedServiceAuthSwitchRpcParamsSchema, {
  machineId: z.string().check(z.trim(), z.minLength(1)),
  serverId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
}));

export const SessionPrimaryTargetInputSchema = lazyZodSchema(() => z.union([
  VoiceTrackedSessionAddressV1Schema,
  z.strictObject({ sessionId: z.null() }),
]));

// Uncapped like the canonical Account Voice replace API it forwards to: a
// complete exact-Home replacement must reach the Follow owner and settle.
export const SessionTrackedTargetsInputSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    sessionAddresses: z.array(VoiceTrackedSessionAddressV1Schema),
  }),
  // Released 0.2 clients sent Home-local ids. Keep this as an input-only
  // compatibility arm; the executing client must qualify them before mutation.
  z.strictObject({
    sessionIds: z.array(z.string().check(z.trim(), z.minLength(1))),
  }),
]));

export function bindPluginSessionInteractionInput(
  value: unknown,
  context: ActionSurfaceBindingContext,
): unknown {
  requirePluginBindingCaller(context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_session_interaction_input_invalid');
  }
  if ('sessionId' in value && value.sessionId !== undefined) return value;
  const sessionId = typeof context.defaultSessionId === 'string'
    ? context.defaultSessionId.trim()
    : '';
  if (!sessionId) throw new Error('plugin_current_session_required');
  return { ...value, sessionId };
}

export function projectPluginSessionInteractionResponse(value: unknown): unknown {
  if (value === undefined || value === null) return { ok: true };
  const parsed = SessionInteractionResponseSuccessSchema.safeParse(value);
  if (!parsed.success) throw new Error('plugin_session_interaction_result_invalid');
  return parsed.data;
}

export const SESSION_INTERACTION_ACTION_SPECS = Object.freeze([
  {
    id: 'session.permission.respond', executionPlacement: 'session', approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp'] }, approval: {result: 'optional',flow: 'deferred'},
    prompting: { voiceHotPath: true },
    title: 'Respond to permission request',
    sideEffectClass: 'write',
    description: 'Approve or deny an active permission request in a session.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'session_permission_respond', rpcMethod: 'session.permission.respond' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Allow or deny something a session\'s agent asked to do.',
      title: 'Respond to permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        { path: 'turnId', title: 'Turn id', widget: 'text' },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionPermissionRespondInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.approval_reviewer.set', executionPlacement: 'session', approval: {result: 'none'},
    title: 'Set session approval reviewer',
    description: 'Enable or disable request-only background approval review for this session, or use null to follow the Account default.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'present_user',
    placements: [],
    surfaces: { ui: true, cli: true, agent: false, mcp: false, voice: false, rpc: false },
    inputHints: { description: 'Let a reviewer agent look at a session\'s requests before they reach you.', title: 'Set session approval reviewer', fields: [
      { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'enabled', title: 'Enabled, or null to follow the Account default', widget: 'json', required: true },
    ] },
    inputSchema: lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.trim(), z.minLength(1)), enabled: z.nullable(z.boolean()) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ updated: z.literal(true) })),
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.attention.set', approval: {result: 'none'},
    title: 'Settle or snooze a session',
    description: 'Write the caller\u2019s own Inbox attention standing for a session: settle it (standing false), keep it standing, or snooze it until a time (remindAt). Settle pairs with session.read_state.set. Agent calls use the normal Action approval policy.',
    safety: 'safe',
    sideEffectClass: 'write',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, cli: true, voice: true, agent: true, mcp: true, rpc: false },
    bindings: { mcpToolName: 'session_attention_set', voiceClientToolName: 'session_attention_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","standing":false}' },
    },
    inputHints: {
      title: 'Settle or snooze a session',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'standing', title: 'Keep in Needs you', widget: 'boolean' },
        { path: 'remindAt', title: 'Snooze until (epoch ms)', widget: 'integer' },
      ],
    },
    inputSchema: SessionAttentionSetInputV1Schema,
    outputSchema: SessionAttentionSetResultV1Schema,
    serverTransport: { method: 'PUT', path: SESSION_ATTENTION_STANDING_HTTP_PATH_V1 },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.permission.remote.pending.list', executionPlacement: 'session', approval: {result: 'none'},
    title: 'List remotely mediated permission requests',
    sideEffectClass: 'read',
    description: 'List the caller mediator’s current permission requests for one exact source authority.',
    safety: 'safe',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    bindings: { rpcMethod: 'session.permission.remote.pending.list' },
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      description: 'See requests from a session that are waiting for someone else\'s answer.',
      title: 'List remotely mediated permission requests',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemotePendingListOutputV1Schema,
    inputSchema: SessionPermissionRemotePendingListInputV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.permission.remote.respond', executionPlacement: 'session', approval: {result: 'none'},
    title: 'Respond to a remotely mediated permission request',
    sideEffectClass: 'write',
    description: 'Submit an attributed external-human decision for one current permission request.',
    safety: 'safe',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    bindings: { rpcMethod: 'session.permission.remote.respond' },
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      description: 'Answer a session\'s request on someone else\'s behalf.',
      title: 'Respond to a remotely mediated permission request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'idempotencyKey', title: 'Idempotency key', widget: 'text', required: true },
        { path: 'actor.namespace', title: 'External principal namespace', widget: 'text', required: true },
        { path: 'actor.principalId', title: 'External principal id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'allow', label: 'Allow' },
            { value: 'deny', label: 'Deny' },
          ],
        },
        {
          path: 'scope',
          title: 'Scope',
          widget: 'select',
          required: true,
          options: [
            { value: 'request', label: 'This request' },
            { value: 'session', label: 'This session' },
          ],
        },
      ],
    },
    outputSchema: SessionPermissionRemoteRespondOutputV1Schema,
    inputSchema: SessionPermissionRemoteRespondInputV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.user_action.remote.answer', executionPlacement: 'session', approval: {result: 'none'},
    title: 'Answer a remotely mediated user-action request',
    sideEffectClass: 'write',
    description: 'Submit bounded indexed answers for one current source-bound AskUserQuestion request.',
    safety: 'safe',
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    bindings: { rpcMethod: 'session.user_action.remote.answer' },
    placements: [],
    surfaces: {
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: true,
    },
    inputHints: {
      description: 'Answer a session\'s question on someone else\'s behalf.',
      title: 'Answer a remotely mediated user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'sourceRef', title: 'Source reference', widget: 'text', required: true },
        { path: 'sourceRevisionOrEpoch', title: 'Source revision', widget: 'text', required: true },
        { path: 'answers', title: 'Indexed answers', widget: 'json', required: true },
      ],
    },
    outputSchema: SessionUserActionRemoteAnswerOutputV1Schema,
    inputSchema: SessionUserActionRemoteAnswerInputV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.permission.remote.grants.list', executionPlacement: 'session', approval: {result: 'none'},
    title: 'List remotely mediated permission grants',
    sideEffectClass: 'read',
    description: 'List source-scoped remote permission grants visible to the authenticated caller.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.list', mcpToolName: 'session_permission_remote_grants_list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'See what has been allowed for a session on someone else\'s behalf.',
      title: 'List remotely mediated permission grants',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'limit', title: 'Maximum grants', widget: 'text' },
        { path: 'cursor', title: 'Continuation cursor', widget: 'text' },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantsListOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantsListInputV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.permission.remote.grants.revoke', executionPlacement: 'session', approval: {result: 'none'},
    title: 'Revoke a remotely mediated permission grant',
    sideEffectClass: 'write',
    description: 'Revoke one source-scoped remote permission grant.',
    safety: 'safe',
    placements: [],
    bindings: { rpcMethod: 'session.permission.remote.grants.revoke', mcpToolName: 'session_permission_remote_grants_revoke' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Take back something allowed for a session on someone else\'s behalf.',
      title: 'Revoke a remotely mediated permission grant',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'turnId', title: 'Turn id', widget: 'text', required: true },
        { path: 'requestId', title: 'Request id', widget: 'text', required: true },
        { path: 'grantId', title: 'Grant id', widget: 'text', required: true },
      ],
    },
    outputSchema: SessionPermissionRemoteGrantRevokeOutputV1Schema,
    inputSchema: SessionPermissionRemoteGrantRevokeInputV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.needs_you.raise', approval: { result: 'optional', flow: 'deferred' },
    title: 'Ask the user',
    description: 'Ask one structured question request in the current session, or withdraw a request you raised.',
    sideEffectClass: 'write',
    executionPlacement: 'session',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'raiseNeedsYou', mcpToolName: 'session_needs_you_raise', rpcMethod: 'session.needs_you.raise' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session', widget: 'text' },
      { path: 'mode', title: 'Wait or continue', widget: 'select', options: [
        { value: 'wait', label: 'Wait' }, { value: 'continue', label: 'Continue' },
      ] },
      { path: 'type', title: 'Question type', widget: 'select', options: [
        { value: 'decision', label: 'Decision' }, { value: 'blocked', label: 'Blocked' },
      ] },
      { path: 'title', title: 'Title', widget: 'text' },
      { path: 'questions', title: 'Questions', widget: 'json' },
      { path: 'assumption', title: 'Continue-mode assumption', widget: 'text' },
      { path: 'lasting', title: 'Lasting decision', widget: 'boolean' },
      { path: 'requestId', title: 'Request to withdraw', widget: 'text' },
      { path: 'withdraw', title: 'Withdrawal reason', widget: 'text' },
    ] },
    inputSchema: SessionNeedsYouRaiseInputV1Schema,
    outputSchema: SessionNeedsYouRaiseOutputV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.user_action.answer', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Respond to user-action request',
    sideEffectClass: 'write',
    description: 'Approve, reject, request changes, or provide structured answers for an active user-action request. Target the Session that owns the request; a forwarded or passed-up question stays on its original asking Session, not the current handler Session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'answerUserActionRequest', mcpToolName: 'session_user_action_answer', rpcMethod: 'session.user_action.answer' },
    examples: {
      voice: {
        argsExample:
          '{"sessionId":"{{sessionId}}","answers":[{"question":"Continue?","values":["Yes"]}]}',
      },
    },
    surfaceBindings: {
      plugin: {
        inputSchema: SessionUserActionAnswerPluginInputSchema,
        bindInput: bindPluginSessionInteractionInput,
        projectOutput: projectPluginSessionInteractionResponse,
      },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    inputHints: {
      description: 'Answer a question or review a request from the request-owning Session\'s agent. For a forwarded or passed-up question, use the original asking Session id supplied with the form.',
      title: 'Respond to user-action request',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'requestId', title: 'Request id', widget: 'text' },
        {
          path: 'decision',
          title: 'Decision',
          description: 'Use approve or reject for general user actions, or request_changes when you need the coding assistant to revise something first.',
          widget: 'select',
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'request_changes', label: 'Request changes' },
          ],
        },
        {
          path: 'reason',
          title: 'Reason',
          description: 'Required when requesting changes. Optional extra context for a rejection.',
          widget: 'textarea',
        },
        {
          path: 'answers',
          title: 'Answers',
          description: 'Structured answers for question-style user-action requests such as AskUserQuestion.',
          widget: 'json',
        },
      ],
    },
    outputSchema: SessionInteractionResponseSuccessSchema,
    inputSchema: SessionUserActionAnswerInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.control.switch', approval: { result: 'optional', flow: 'deferred' },
    title: 'Switch Session control',
    description: 'Switch between local terminal and remote control through the active Session terminal owner.',
    safety: 'safe',
    sideEffectClass: 'write',
    executionPlacement: 'session',
    placements: [],
    bindings: { mcpToolName: 'session_control_switch', rpcMethod: 'switch' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text' },
      { path: 'to', title: 'Control', widget: 'select', required: true, options: [
        { value: 'remote', label: 'Remote' }, { value: 'local', label: 'Local terminal' },
      ] },
    ] },
    inputSchema: SessionControlSwitchInputSchema,
    outputSchema: SessionControlSwitchOutputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.mode.set', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set session mode',
    sideEffectClass: 'write',
    description: 'Request a new ACP session mode for the current session when the active provider supports session modes.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setSessionMode', mcpToolName: 'session_mode_set' },
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","modeId":"plan"}' },
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
      description: 'Switch a session\'s agent to another mode, such as planning.',
      title: 'Set session mode',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', description: 'Optional when the active target session is already correct.', widget: 'text' },
        {
          path: 'modeId',
          title: 'Mode id',
          description: 'Use default to clear the override and return to the provider default mode.',
          widget: 'select',
          required: true,
          optionsSourceId: 'session.modes.available',
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionModeSetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.config_option.set', approval: {result: 'optional',flow: 'deferred'},
    executionPlacement: 'client',
    title: 'Set session configuration option',
    sideEffectClass: 'write',
    description: 'Set one provider-owned configuration option for the current session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_config_option_set' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
    },
    inputHints: {
      title: 'Set session configuration option',
      fields: [
        { path: 'sessionId', title: 'Session id', widget: 'text' },
        { path: 'configId', title: 'Configuration id', widget: 'text', required: true },
        { path: 'valueId', title: 'Value id', widget: 'text', required: true },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionConfigOptionSetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.connected_services_auth.set', approval: {result: 'optional',flow: 'deferred'},
    executionPlacement: 'client',
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Set session connected-account routing',
    sideEffectClass: 'write',
    description: 'Apply a confirmed connected-account routing selection to the current session.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_connected_services_auth_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    inputHints: { title: 'Set session connected-account routing', fields: [] },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionConnectedServicesAuthSetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.target.primary.set', executionPlacement: 'client', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set primary action session',
    sideEffectClass: 'write',
    description: 'Set which session the voice assistant should target by default.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'setPrimaryActionSession', mcpToolName: 'session_target_primary_set' },
    examples: {
      voice: { argsExample: '{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: false,
      rpc: false,
      },
    inputHints: {
      description: 'Choose the session Voice talks to by default.',
      title: 'Set primary action session',
      fields: [
        { path: 'serverId', title: 'Home id', widget: 'text' },
        { path: 'sessionId', title: 'Session id (or null)', prompt: 'Which session?', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionPrimaryTargetInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.target.tracked.set', executionPlacement: 'client', approval: {result: 'optional',flow: 'deferred'},
    title: 'Set Include in Voice sessions',
    sideEffectClass: 'write',
    description: 'Set which sessions are included in Voice through Account Follow.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'setTrackedSessions', mcpToolName: 'session_target_tracked_set' },
    examples: {
      voice: { argsExample: '{"sessionAddresses":[{"serverId":"{{serverId}}","sessionId":"{{sessionId}}"}]}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: false,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      description: 'Choose which sessions Voice keeps you up to date on.',
      title: 'Set Include in Voice sessions',
      fields: [{ path: 'sessionIds', title: 'Session ids', widget: 'text_list', required: true, listSeparator: 'comma' }],
    },
    outputSchema: VoiceTrackedTargetsActionResultV1Schema,
    inputSchema: SessionTrackedTargetsInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

