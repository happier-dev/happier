import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionTargetV1Schema } from '../../sessionTargetV1.js';
import { RestartSessionRunnerResultV1Schema } from '../../../sessions/control/sessionRunnerRestartV1.js';
import { SessionPendingWithdrawInputV1Schema, SessionPendingWithdrawResultV1Schema } from '../../../sessions/control/pendingWithdrawV1.js';
import { SessionPendingMarkHandledInputV1Schema, SessionPendingDeliveryRecoveryInputV1Schema, SessionPendingDeliveryRecoveryResultV1Schema, SessionPendingSendAsNewResultV1Schema } from '../../../sessions/control/pendingDeliveryRecoveryV1.js';
import { z } from 'zod/mini';
import { SessionPendingActionSetInputV1Schema, SessionPendingActionSetResultV1Schema, PendingResetStartSetInputV1Schema, PendingResetStartCancelInputV1Schema, PendingResetStartSetResultV1Schema, PendingResetStartCancelResultV1Schema } from '../../../sessions/pending/pendingRequestedActionV1.js';
import { SessionUsageLimitCheckNowRequestV1Schema, SessionUsageLimitConsumeResetCreditRequestV1Schema, SessionUsageLimitWaitResumeCancelRequestV1Schema, SessionUsageLimitWaitResumeEnableRequestV1Schema } from '../../../sessions/work/state/sessionWorkStateRpc.js';
import { SessionTerminalComposerClearRequestV1Schema, SessionTerminalComposerClearResultV1Schema } from '../../../sessions/control/terminalComposerClearV1.js';
import { SessionPendingInputInterruptAndRunRequestV1Schema, SessionPendingInputInterruptAndRunResultV1Schema } from '../../../sessions/control/pendingInputInterruptAndRunV1.js';
import { SESSION_RPC_METHODS } from '../../../rpc/methods.js';
import { SESSION_STOP_CLI_PROJECTION } from '../sessionCommandCli.js';
import { SESSION_READ_STATE_SET_CLI_PROJECTION } from './readStateCli.js';
import { SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1, SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1 } from '../../../sessions/readState/actions.js';
import { SESSION_READ_STATE_HTTP_PATHS_V1 } from '../../../sessions/readState/api.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from '../definition.js';


export const SessionStopInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  stopIntent: z.optional(z.enum(['explicit_stop', 'lifecycle_control'])),
}));

export const SessionTurnCancelInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
}));

export const SESSION_LIFETIME_CONTROL_ACTION_SPECS = Object.freeze([
  {
    id: 'session.turn.cancel', executionPlacement: 'session', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Stop current turn',
    description: 'Request cancellation of the current turn while keeping the session process available.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_turn_cancel', mcpToolName: 'session_turn_cancel', rpcMethod: 'abort' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputHints: {
      title: 'Stop current turn',
      fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true }],
    },
    inputSchema: SessionTurnCancelInputSchema,
    outputSchema: StrictJsonValueSchema,
    cli: { commands: [{ path: ['session', 'turn', 'cancel'], positionals: ['sessionId'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.runtime.refresh', executionPlacement: 'session', approval: { result: 'none' },
    title: 'Refresh Session runtime',
    description: 'Refresh a stale Session runner on its hosting machine through the same planned restart used by the Session banner. Active child work defers replacement.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'session_runtime_refresh' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({
      sessionId: z.string().check(z.trim(), z.minLength(1)),
      machineId: z.string().check(z.trim(), z.minLength(1)),
      serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    })),
    outputSchema: RestartSessionRunnerResultV1Schema,
    inputHints: { fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'machineId', title: 'Hosting machine id', widget: 'text', required: true },
      { path: 'serverId', title: 'Home id', widget: 'text' },
    ] },
    examples: { mcp: { argsExample: '{"sessionId":"{{sessionId}}","machineId":"{{machineId}}"}' } },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.stop', executionPlacement: 'session', approval: {result: 'none'},
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    title: 'Stop session',
    description: 'Stop the specified session. Explicit Stop holds automatic wake until Resume; lifecycle control only frees the runner.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { voiceClientToolName: 'session_stop', mcpToolName: 'session_stop', rpcMethod: 'stop-session' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
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
      description: 'Stop a running session; default explicit Stop holds it until Resume.',
      title: 'Stop a session',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'stopIntent', title: 'Stop intent', widget: 'select', options: [
          { value: 'explicit_stop', label: 'Hold until Resume' },
          { value: 'lifecycle_control', label: 'Free the runner; wake on next message' },
        ] },
        { path: 'serverId', title: 'Home id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionStopInputSchema,
    cli: SESSION_STOP_CLI_PROJECTION,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.terminalComposer.clear', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Clear terminal composer',
    description: 'Clear the pending terminal composer draft for a session runtime.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      mcpToolName: 'session_terminal_composer_clear',
      rpcMethod: SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
    },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Clear the text waiting in a session\'s terminal composer.',
      title: 'Clear terminal composer',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionTerminalComposerClearResultV1Schema,
    inputSchema: SessionTerminalComposerClearRequestV1Schema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionTerminalComposerClearRequestV1Schema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return { sessionId,
        ...(parsed.data.expectedStateAtMs !== undefined ? { expectedStateAtMs: parsed.data.expectedStateAtMs } : {}),
      };
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pendingInput.interruptAndRun', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Interrupt and run now',
    description: 'Interrupt the live provider turn so its exact native queued prompt can run now.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: ['pending_messages'],
    bindings: {
      rpcMethod: SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      description: 'Interrupt what the agent is doing so your queued message runs now.',
      title: 'Interrupt and run now',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
        { path: 'expectedStateAtMs', title: 'Expected state timestamp', widget: 'text' },
      ],
    },
    outputSchema: SessionPendingInputInterruptAndRunResultV1Schema,
    inputSchema: SessionPendingInputInterruptAndRunRequestV1Schema,
    projectSessionConfirmation: (input, { sessionId }) => {
      const parsed = SessionPendingInputInterruptAndRunRequestV1Schema.safeParse(input);
      if (!parsed.success || parsed.data.sessionId !== sessionId) return null;
      return { sessionId, localId: parsed.data.localId,
        ...(parsed.data.expectedStateAtMs !== undefined ? { expectedStateAtMs: parsed.data.expectedStateAtMs } : {}),
      };
    },
  } satisfies PreNormalizedActionSpec,
] as const);


export const SESSION_RECOVERY_ACTION_SPECS = Object.freeze([
  {
    id: 'session.read_state.set', approval: {result: 'none'},
    title: 'Mark a session read',
    description: 'Set the caller\u2019s own private read position in a session. Does not resolve approvals, mentions or human attention.',
    safety: 'safe',
    executionPlacement: 'account',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_read_state_set', voiceClientToolName: 'session_read_state_set' },
    sideEffectClass: 'write',
    inputHints: {
      title: 'Mark a session read',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'state', title: 'Read state', widget: 'text', required: true },
      ],
    },
    outputSchema: SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1['session.read_state.set'],
    inputSchema: SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1['session.read_state.set'],
    cli: SESSION_READ_STATE_SET_CLI_PROJECTION,
    serverTransport: { method: 'POST', path: SESSION_READ_STATE_HTTP_PATHS_V1.set },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.usageLimit.waitResume.enable', executionPlacement: 'session', approval: {result: 'none',flow: 'deferred'},
    title: 'Enable usage-limit wait resume',
    description: 'Arm a durable intent to continue a session when a provider usage limit is lifted.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_enable' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}","remember":true}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Continue a session automatically once your usage limit lifts.',
      title: 'Enable usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'remember', title: 'Remember', widget: 'boolean' },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeEnableRequestV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.usageLimit.waitResume.cancel', executionPlacement: 'session', approval: {result: 'none',flow: 'deferred'},
    title: 'Cancel usage-limit wait resume',
    description: 'Cancel the active usage-limit wait/resume intent for a session.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_wait_resume_cancel' },
    examples: {
      mcp: {
        argsExample: '{"sessionId":"{{sessionId}}","issueFingerprint":"usage-limit:provider:turn:1:no-reset","armedAtMs":1000,"runtimeAuthRecoveryAttemptId":"runtime-auth-attempt-1"}',
      },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Stop waiting to continue a session after a usage limit.',
      title: 'Cancel usage-limit wait resume',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        { path: 'issueFingerprint', title: 'Issue fingerprint', widget: 'text' },
        { path: 'armedAtMs', title: 'Armed at (ms)', widget: 'number' },
        { path: 'runtimeAuthRecoveryAttemptId', title: 'Runtime auth recovery attempt id', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitWaitResumeCancelRequestV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.usageLimit.checkNow', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Check usage-limit recovery now',
    description: 'Ask the session runtime to perform a safe provider-owned usage-limit recovery check.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_check_now' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Check now whether a session\'s usage limit has lifted.',
      title: 'Check usage-limit recovery now',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'operation',
          title: 'Operation',
          widget: 'select',
          options: [
            { value: 'check_now', label: 'Check now' },
            { value: 'switch_account_now', label: 'Switch account now' },
          ],
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitCheckNowRequestV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.usageLimit.consumeResetCredit', executionPlacement: 'session', approval: {result: 'required'},
    title: 'Apply usage-limit reset credit',
    description: 'Ask the session runtime to spend a connected-service reset credit for usage-limit recovery.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'session_usage_limit_consume_reset_credit' },
    examples: {
      mcp: { argsExample: '{"sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      description: 'Use a reset credit from your connected account to lift a session\'s usage limit now.',
      title: 'Apply reset credit',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
        {
          path: 'provider',
          title: 'Provider',
          description: 'Optional provider id for provider-scoped recovery controls.',
          widget: 'text',
        },
        {
          path: 'resumePromptMode',
          title: 'Resume prompt mode',
          widget: 'select',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'off', label: 'Off' },
            { value: 'custom', label: 'Custom' },
          ],
        },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SessionUsageLimitConsumeResetCreditRequestV1Schema,
  } satisfies PreNormalizedActionSpec,
] as const);


export const SESSION_PENDING_ACTION_SPECS = Object.freeze([
  {
    id: 'session.pending.action.set', approval: { result: 'required' }, title: 'Update queued message action',
    description: 'Change the requested action or explicitly resume the exact queued input through its existing pending owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { uiConfirmation: 'direct', rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_action_set', voiceClientToolName: 'session_pending_action_set', rpcMethod: 'session.pending.action.set' },
    serverTransport: { method: 'PATCH', path: '/v2/sessions/:sessionId/pending/:localId/action' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'action', 'set'], visibility: 'canonical' }] },
    inputHints: { description: 'Update this pending input; explicitly request resume when it becomes available.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true },
      { path: 'requestedAction', title: 'Requested action', widget: 'json', required: true },
      { path: 'resumeWhenAvailable', title: 'Resume when available', widget: 'boolean' }] },
    inputSchema: SessionPendingActionSetInputV1Schema, outputSchema: SessionPendingActionSetResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pending.markHandled', approval: { result: 'required' }, title: 'Mark pending delivery handled',
    description: 'Resolve historical uncertain input you have confirmed was handled, without sending it again.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_mark_handled', rpcMethod: 'session.pending.markHandled' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/delivery/handled' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'mark-handled'], visibility: 'canonical' }] },
    inputHints: { description: 'Confirm this exact pending input has already been handled.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingMarkHandledInputV1Schema, outputSchema: SessionPendingDeliveryRecoveryResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pending.dismiss', approval: { result: 'required' }, title: 'Dismiss uncertain pending delivery',
    description: 'Set aside a pending message that may not have been delivered, without sending it again.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_dismiss', rpcMethod: 'session.pending.dismiss' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/delivery/dismiss' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'dismiss'], visibility: 'canonical' }] },
    inputHints: { description: 'Set aside a message that may not have been delivered, keeping a record of it.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingDeliveryRecoveryInputV1Schema, outputSchema: SessionPendingDeliveryRecoveryResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pending.sendAsNew', approval: { result: 'required' }, title: 'Send pending delivery as new',
    irreversible: true,
    description: 'Replace the exact uncertain input with a new server-owned Pending identity; the agent may have seen the original.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    approvalPolicy: { rpcConfirmation: true }, placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_send_as_new', rpcMethod: 'session.pending.sendAsNew' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/delivery/send-as-new' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'send-as-new'], visibility: 'canonical' }] },
    inputHints: { description: 'Send uncertain input again under a new Pending identity.', fields: [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingDeliveryRecoveryInputV1Schema, outputSchema: SessionPendingSendAsNewResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pending.withdraw', approval: {result: 'required'}, title: 'Withdraw queued message',
    description: 'Remove an exact pending message before delivery; delivered or uncertain input cannot be moved back.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    placements: ['pending_messages'],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: 'session_pending_withdraw', rpcMethod: 'session.pending.withdraw' },
    serverTransport: { method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/withdraw' },
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'withdraw'], visibility: 'canonical' }] },
    inputHints: { description: 'Take back a queued message before the agent receives it.', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: SessionPendingWithdrawInputV1Schema, outputSchema: SessionPendingWithdrawResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pending.resetStart.set', originalExecution: { accountRoot: 'allowed', nativePurpose: 'pending_reset_start' }, approval: {result: 'required'}, title: 'Start queued work after quota reset',
    description: 'Hold an existing Pending message against an exact accepted quota witness. Only its admitted machine may release it after the same qualified reset.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    placements: ['pending_messages'],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_pending_reset_start_set' },
    cli: { acceptsServerId: true, commands: [] },
    inputHints: { description: 'Hold a queued message until your usage limit resets, then send it.', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true },
      { path: 'reset', title: 'Qualified accepted reset witness', widget: 'json', required: true }] },
    inputSchema: PendingResetStartSetInputV1Schema, outputSchema: PendingResetStartSetResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.pending.resetStart.cancel', originalExecution: { accountRoot: 'allowed', nativePurpose: 'pending_reset_start' }, approval: {result: 'required'}, title: 'Cancel reset-bound queued work',
    irreversible: true,
    description: 'Withdraw the exact Pending message through its existing custody owner; already delivered or uncertain input cannot be reported as cancelled.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account',
    placements: ['pending_messages'],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: 'session_pending_reset_start_cancel' },
    cli: { acceptsServerId: true, commands: [] },
    inputHints: { description: 'Stop holding a queued message for a usage-limit reset.', fields: [{ path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
      { path: 'localId', title: 'Pending message id', widget: 'text', required: true }] },
    inputSchema: PendingResetStartCancelInputV1Schema, outputSchema: PendingResetStartCancelResultV1Schema,
  } satisfies PreNormalizedActionSpec,
] as const);

