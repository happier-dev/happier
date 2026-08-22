import type { NormalizedRuntimeModeParitySnapshot } from './_normalize';
import type { RuntimeModeParityScenario } from './_harness';

const SESSION_ID = '57f7fd51-5e91-42ca-b457-e077e8ac8944';

type ExpectedCaptureParams = Readonly<{
  id: string;
  backendId: RuntimeModeParityScenario['backendId'];
  providerSessionId: string;
  from: RuntimeModeParityScenario['from'];
  to: RuntimeModeParityScenario['to'];
  reason: RuntimeModeParityScenario['reason'];
  launch: NormalizedRuntimeModeParitySnapshot;
  switchTarget: 'local' | 'remote';
  pendingQueue: NormalizedRuntimeModeParitySnapshot;
  queueOutcome: 'none' | 'preserved' | 'materialized' | 'handoff_requested';
}>;

function expectedCapture(params: ExpectedCaptureParams): NormalizedRuntimeModeParitySnapshot {
  return {
    id: params.id,
    backendId: params.backendId,
    captureKind: 'pin-only',
    providerSessionId: params.providerSessionId,
    transition: {
      from: params.from,
      to: params.to,
      reason: params.reason,
    },
    launch: params.launch,
    switchTarget: params.switchTarget,
    pendingQueue: params.pendingQueue,
    queueOutcome: params.queueOutcome,
    agentStateRuntimeSlice: {
      runtimeMode: params.to,
      controlledByUser: params.to === 'terminal',
      localControl: {
        attached: params.to === 'terminal',
        topology: 'exclusive',
        remoteWritable: params.to === 'remote',
        canAttach: params.to === 'remote',
        canDetach: params.to === 'terminal',
      },
    },
  };
}

const terminalCompletedState = {
  state: 'idle',
  confidence: 'definite',
  lastTerminal: {
    type: 'completed',
    turnId: 'turn-terminal-completed',
    source: 'lifecycle_event',
  },
} as const;

function noPendingStatus(): NormalizedRuntimeModeParitySnapshot {
  return {
    action: { type: 'none' },
    status: {
      v: 1,
      status: 'none',
      pendingCount: 0,
      updatedAtMs: 0,
    },
  };
}

function gracefulHandoffStatus(reason: 'switch_now' | 'pending_queue_after_terminal_boundary', pendingCount: number): NormalizedRuntimeModeParitySnapshot {
  return {
    action: {
      type: 'request_graceful_remote_handoff',
      reason,
    },
    status: {
      v: 1,
      status: 'switching_to_remote',
      pendingCount,
      updatedAtMs: 0,
      lastTerminalState: terminalCompletedState.lastTerminal,
    },
  };
}

const codexTerminalToRemoteUserRequest: RuntimeModeParityScenario = {
  id: 'codex.terminalToRemote.user_request',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'terminal',
  to: 'remote',
  reason: 'user_request',
  providerSessionId: 'codex-provider-session-1',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_222_000,
  launch: { startingMode: 'local', support: { ok: true } },
  switchRequest: { to: 'remote', reason: 'user_request' },
  pendingQueue: {
    currentMode: 'terminal',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: terminalCompletedState,
    pendingCount: 1,
    resumeReady: true,
    intent: 'switch_now',
  },
  expected: expectedCapture({
    id: 'codex.terminalToRemote.user_request',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-1',
    from: 'terminal',
    to: 'remote',
    reason: 'user_request',
    launch: { mode: 'local' },
    switchTarget: 'remote',
    pendingQueue: gracefulHandoffStatus('switch_now', 1),
    queueOutcome: 'handoff_requested',
  }),
};

const codexTerminalToRemoteIncomingUiMessage: RuntimeModeParityScenario = {
  id: 'codex.terminalToRemote.incoming_ui_message',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'terminal',
  to: 'remote',
  reason: 'incoming_ui_message',
  providerSessionId: 'codex-provider-session-2',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_223_000,
  launch: { startingMode: 'local', support: { ok: true } },
  switchRequest: { to: 'remote', reason: 'incoming_ui_message' },
  pendingQueue: {
    currentMode: 'terminal',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: terminalCompletedState,
    pendingCount: 2,
    resumeReady: true,
    intent: 'queue',
  },
  expected: expectedCapture({
    id: 'codex.terminalToRemote.incoming_ui_message',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-2',
    from: 'terminal',
    to: 'remote',
    reason: 'incoming_ui_message',
    launch: { mode: 'local' },
    switchTarget: 'remote',
    pendingQueue: gracefulHandoffStatus('pending_queue_after_terminal_boundary', 2),
    queueOutcome: 'handoff_requested',
  }),
};

const codexTerminalToRemoteRemoteTakeover: RuntimeModeParityScenario = {
  id: 'codex.terminalToRemote.remote_takeover',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'terminal',
  to: 'remote',
  reason: 'remote_takeover',
  providerSessionId: 'codex-provider-session-3',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_224_000,
  launch: { startingMode: 'local', support: { ok: true } },
  switchRequest: { to: 'remote', reason: 'remote_takeover' },
  pendingQueue: {
    currentMode: 'terminal',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'blocked_on_permission', turnId: 'turn-blocked', source: 'hook' },
    pendingCount: 1,
    resumeReady: true,
    intent: 'force_send_now',
  },
  expected: expectedCapture({
    id: 'codex.terminalToRemote.remote_takeover',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-3',
    from: 'terminal',
    to: 'remote',
    reason: 'remote_takeover',
    launch: { mode: 'local' },
    switchTarget: 'remote',
    pendingQueue: {
      action: {
        type: 'cancel_terminal_turn_then_handoff',
        abortReason: 'user_interrupt',
        detail: 'force_send_now',
      },
      status: {
        v: 1,
        status: 'switching_to_remote',
        pendingCount: 1,
        updatedAtMs: 0,
        interruptRequired: true,
        detail: 'force_send_now',
      },
    },
    queueOutcome: 'handoff_requested',
  }),
};

const codexRemoteToTerminalUserRequest: RuntimeModeParityScenario = {
  id: 'codex.remoteToTerminal.user_request',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'remote',
  to: 'terminal',
  reason: 'user_request',
  providerSessionId: 'codex-provider-session-4',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_225_000,
  launch: { startingMode: 'remote', support: { ok: true } },
  switchRequest: { to: 'local', reason: 'user_request' },
  pendingQueue: {
    currentMode: 'remote',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'idle', confidence: 'definite' },
    pendingCount: 0,
    resumeReady: true,
    intent: 'switch_now',
  },
  expected: expectedCapture({
    id: 'codex.remoteToTerminal.user_request',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-4',
    from: 'remote',
    to: 'terminal',
    reason: 'user_request',
    launch: { mode: 'remote' },
    switchTarget: 'local',
    pendingQueue: noPendingStatus(),
    queueOutcome: 'none',
  }),
};

const codexRemoteToTerminalIncomingUiMessage: RuntimeModeParityScenario = {
  id: 'codex.remoteToTerminal.incoming_ui_message',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'remote',
  to: 'terminal',
  reason: 'incoming_ui_message',
  providerSessionId: 'codex-provider-session-5',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_226_000,
  launch: { startingMode: 'remote', support: { ok: true } },
  switchRequest: { to: 'local', reason: 'incoming_ui_message' },
  pendingQueue: {
    currentMode: 'remote',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'idle', confidence: 'definite' },
    pendingCount: 0,
    resumeReady: true,
    intent: 'queue',
  },
  expected: expectedCapture({
    id: 'codex.remoteToTerminal.incoming_ui_message',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-5',
    from: 'remote',
    to: 'terminal',
    reason: 'incoming_ui_message',
    launch: { mode: 'remote' },
    switchTarget: 'local',
    pendingQueue: noPendingStatus(),
    queueOutcome: 'none',
  }),
};

const codexRemoteToTerminalHostRecovery: RuntimeModeParityScenario = {
  id: 'codex.remoteToTerminal.host_recovery',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'remote',
  to: 'terminal',
  reason: 'host_recovery',
  providerSessionId: 'codex-provider-session-6',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_227_000,
  launch: { startingMode: 'remote', support: { ok: true } },
  switchRequest: { to: 'local', reason: 'host_recovery' },
  pendingQueue: {
    currentMode: 'remote',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'idle', confidence: 'definite' },
    pendingCount: 0,
    resumeReady: true,
    intent: 'switch_now',
  },
  expected: expectedCapture({
    id: 'codex.remoteToTerminal.host_recovery',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-6',
    from: 'remote',
    to: 'terminal',
    reason: 'host_recovery',
    launch: { mode: 'remote' },
    switchTarget: 'local',
    pendingQueue: noPendingStatus(),
    queueOutcome: 'none',
  }),
};

const codexRemoteQueuePreservedWhileTurnInflight: RuntimeModeParityScenario = {
  id: 'codex.remoteQueue.preservedWhileTurnInflight',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'remote',
  to: 'remote',
  reason: 'incoming_ui_message',
  providerSessionId: 'codex-provider-session-7',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_228_000,
  launch: { startingMode: 'remote', support: { ok: true } },
  switchRequest: { to: 'remote', reason: 'incoming_ui_message' },
  pendingQueue: {
    currentMode: 'remote',
    remoteTurnInFlight: true,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'idle', confidence: 'definite' },
    pendingCount: 3,
    resumeReady: true,
    intent: 'queue',
  },
  expected: expectedCapture({
    id: 'codex.remoteQueue.preservedWhileTurnInflight',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-7',
    from: 'remote',
    to: 'remote',
    reason: 'incoming_ui_message',
    launch: { mode: 'remote' },
    switchTarget: 'remote',
    pendingQueue: {
      action: { type: 'defer_until_terminal_turn_finishes' },
      status: {
        v: 1,
        status: 'deferred_until_terminal_turn_finishes',
        pendingCount: 3,
        updatedAtMs: 0,
      },
    },
    queueOutcome: 'preserved',
  }),
};

const codexLaunchDeniedFallsBackToRemote: RuntimeModeParityScenario = {
  id: 'codex.launchDenied.fallsBackToRemote',
  backendId: 'codex',
  captureKind: 'pin-only',
  from: 'terminal',
  to: 'remote',
  reason: 'terminal_unavailable',
  providerSessionId: 'codex-provider-session-8',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_229_000,
  launch: { startingMode: 'local', support: { ok: false, reason: 'terminal_support_unavailable' } },
  switchRequest: { to: 'remote', reason: 'terminal_unavailable' },
  pendingQueue: {
    currentMode: 'terminal',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'idle', confidence: 'definite' },
    pendingCount: 0,
    resumeReady: false,
    resumeDetail: 'terminal support unavailable',
    intent: 'switch_now',
  },
  expected: expectedCapture({
    id: 'codex.launchDenied.fallsBackToRemote',
    backendId: 'codex',
    providerSessionId: 'codex-provider-session-8',
    from: 'terminal',
    to: 'remote',
    reason: 'terminal_unavailable',
    launch: { mode: 'remote', fallback: { reason: 'terminal_support_unavailable' } },
    switchTarget: 'remote',
    pendingQueue: noPendingStatus(),
    queueOutcome: 'none',
  }),
};

const claudeTerminalToRemoteUserRequest: RuntimeModeParityScenario = {
  id: 'claude.terminalToRemote.user_request',
  backendId: 'claude',
  captureKind: 'pin-only',
  from: 'terminal',
  to: 'remote',
  reason: 'user_request',
  providerSessionId: 'claude-provider-session-1',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_230_000,
  launch: { startingMode: 'local', support: { ok: true } },
  switchRequest: { to: 'remote', reason: 'user_request' },
  pendingQueue: {
    currentMode: 'terminal',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: terminalCompletedState,
    pendingCount: 1,
    resumeReady: true,
    intent: 'switch_now',
  },
  expected: expectedCapture({
    id: 'claude.terminalToRemote.user_request',
    backendId: 'claude',
    providerSessionId: 'claude-provider-session-1',
    from: 'terminal',
    to: 'remote',
    reason: 'user_request',
    launch: { mode: 'local' },
    switchTarget: 'remote',
    pendingQueue: gracefulHandoffStatus('switch_now', 1),
    queueOutcome: 'handoff_requested',
  }),
};

const claudeRemoteToTerminalUserRequest: RuntimeModeParityScenario = {
  id: 'claude.remoteToTerminal.user_request',
  backendId: 'claude',
  captureKind: 'pin-only',
  from: 'remote',
  to: 'terminal',
  reason: 'user_request',
  providerSessionId: 'claude-provider-session-2',
  sessionId: SESSION_ID,
  nowMs: 1_781_111_231_000,
  launch: { startingMode: 'remote', support: { ok: true } },
  switchRequest: { to: 'local', reason: 'user_request' },
  pendingQueue: {
    currentMode: 'remote',
    remoteTurnInFlight: false,
    terminalTopology: 'exclusive',
    terminalTurnState: { state: 'idle', confidence: 'definite' },
    pendingCount: 0,
    resumeReady: true,
    intent: 'switch_now',
  },
  expected: expectedCapture({
    id: 'claude.remoteToTerminal.user_request',
    backendId: 'claude',
    providerSessionId: 'claude-provider-session-2',
    from: 'remote',
    to: 'terminal',
    reason: 'user_request',
    launch: { mode: 'remote' },
    switchTarget: 'local',
    pendingQueue: noPendingStatus(),
    queueOutcome: 'none',
  }),
};

export const runtimeModeParityScenarios = [
  codexTerminalToRemoteUserRequest,
  codexTerminalToRemoteIncomingUiMessage,
  codexTerminalToRemoteRemoteTakeover,
  codexRemoteToTerminalUserRequest,
  codexRemoteToTerminalIncomingUiMessage,
  codexRemoteToTerminalHostRecovery,
  codexRemoteQueuePreservedWhileTurnInflight,
  codexLaunchDeniedFallsBackToRemote,
  claudeTerminalToRemoteUserRequest,
  claudeRemoteToTerminalUserRequest,
] as const satisfies readonly RuntimeModeParityScenario[];
