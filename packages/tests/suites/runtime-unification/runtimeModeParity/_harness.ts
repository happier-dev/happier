import { applyTerminalRemoteLaunchGating } from '../../../../../apps/cli/src/agent/runtime/mode/switching/launchGating';
import { resolvePendingQueueHandoff } from '../../../../../apps/cli/src/agent/runtime/mode/switching/pendingQueueHandoffOrchestrator';
import { resolveTerminalRemoteSwitchRequestTarget } from '../../../../../apps/cli/src/agent/runtime/mode/switching/switchTarget';
import { normalizeRuntimeModeParitySnapshot, type NormalizedRuntimeModeParitySnapshot } from './_normalize';

export type RuntimeMode = 'terminal' | 'remote';
export type RuntimeModeSwitchReason =
  | 'user_request'
  | 'incoming_ui_message'
  | 'terminal_unavailable'
  | 'remote_takeover'
  | 'host_recovery';

type BackendId = 'codex' | 'claude';
type TerminalRemoteStartingMode = 'local' | 'remote';
type PendingQueueIntent = 'queue' | 'switch_now' | 'force_send_now';
type PendingQueueMode = 'terminal' | 'remote';
type TerminalTopology = 'exclusive' | 'shared' | null;
type TerminalTurnStateSource = 'hook' | 'transcript' | 'lifecycle_event' | 'process';
type TerminalTurnState =
  | Readonly<{ state: 'idle'; confidence: 'definite' | 'best_effort'; lastTerminal?: Readonly<{ type: 'completed'; turnId?: string | null; source: 'hook' | 'transcript' | 'lifecycle_event' }> }>
  | Readonly<{ state: 'running'; turnId?: string | null; source: TerminalTurnStateSource }>
  | Readonly<{ state: 'blocked_on_permission'; turnId?: string | null; source: TerminalTurnStateSource }>
  | Readonly<{ state: 'unknown'; reason?: string }>;

export type RuntimeModeParityScenario = Readonly<{
  id: string;
  backendId: BackendId;
  captureKind: 'pin-only';
  from: RuntimeMode;
  to: RuntimeMode;
  reason: RuntimeModeSwitchReason;
  providerSessionId: string;
  sessionId: string;
  nowMs: number;
  launch: Readonly<{
    startingMode: TerminalRemoteStartingMode;
    support: Readonly<{ ok: true } | { ok: false; reason: string }>;
  }>;
  switchRequest: unknown;
  pendingQueue: Readonly<{
    currentMode: PendingQueueMode;
    remoteTurnInFlight: boolean;
    terminalTopology: TerminalTopology;
    terminalTurnState: TerminalTurnState;
    pendingCount: number;
    resumeReady: boolean;
    resumeDetail?: string;
    intent: PendingQueueIntent;
  }>;
  expected: NormalizedRuntimeModeParitySnapshot;
}>;

export type RuntimeModeParityCapture = Readonly<{
  id: string;
  backendId: BackendId;
  captureKind: 'pin-only';
  providerSessionId: string;
  transition: Readonly<{
    from: RuntimeMode;
    to: RuntimeMode;
    reason: RuntimeModeSwitchReason;
  }>;
  launch: ReturnType<typeof applyTerminalRemoteLaunchGating<string>>;
  switchTarget: ReturnType<typeof resolveTerminalRemoteSwitchRequestTarget>;
  pendingQueue: ReturnType<typeof resolvePendingQueueHandoff>;
  queueOutcome: 'none' | 'preserved' | 'materialized' | 'handoff_requested';
  agentStateRuntimeSlice: Readonly<{
    runtimeMode: RuntimeMode;
    controlledByUser: boolean;
    localControl: Readonly<{
      attached: boolean;
      topology: 'exclusive';
      remoteWritable: boolean;
      canAttach: boolean;
      canDetach: boolean;
    }>;
  }>;
}>;

function resolveQueueOutcome(actionType: string): RuntimeModeParityCapture['queueOutcome'] {
  switch (actionType) {
    case 'none':
      return 'none';
    case 'materialize_remote_pending':
    case 'inject_pending_into_active_terminal':
      return 'materialized';
    case 'request_graceful_remote_handoff':
    case 'cancel_terminal_turn_then_handoff':
      return 'handoff_requested';
    default:
      return 'preserved';
  }
}

function createAgentStateRuntimeSlice(nextMode: RuntimeMode): RuntimeModeParityCapture['agentStateRuntimeSlice'] {
  return {
    runtimeMode: nextMode,
    controlledByUser: nextMode === 'terminal',
    localControl: {
      attached: nextMode === 'terminal',
      topology: 'exclusive',
      remoteWritable: nextMode === 'remote',
      canAttach: nextMode === 'remote',
      canDetach: nextMode === 'terminal',
    },
  };
}

export function captureOrchestratorPath(scenario: RuntimeModeParityScenario): RuntimeModeParityCapture {
  const launch = applyTerminalRemoteLaunchGating({
    startingMode: scenario.launch.startingMode,
    support: scenario.launch.support,
  });
  const switchTarget = resolveTerminalRemoteSwitchRequestTarget(scenario.switchRequest);
  const pendingQueue = resolvePendingQueueHandoff({
    currentMode: scenario.pendingQueue.currentMode,
    remoteTurnInFlight: scenario.pendingQueue.remoteTurnInFlight,
    terminalTopology: scenario.pendingQueue.terminalTopology,
    terminalTurnState: scenario.pendingQueue.terminalTurnState,
    pendingCount: scenario.pendingQueue.pendingCount,
    resumeReadiness: {
      ready: scenario.pendingQueue.resumeReady,
      ...(scenario.pendingQueue.resumeDetail ? { detail: scenario.pendingQueue.resumeDetail } : {}),
    },
    intent: scenario.pendingQueue.intent,
    nowMs: scenario.nowMs,
  });

  return {
    id: scenario.id,
    backendId: scenario.backendId,
    captureKind: scenario.captureKind,
    providerSessionId: scenario.providerSessionId,
    transition: {
      from: scenario.from,
      to: scenario.to,
      reason: scenario.reason,
    },
    launch,
    switchTarget,
    pendingQueue,
    queueOutcome: resolveQueueOutcome(pendingQueue.action.type),
    agentStateRuntimeSlice: createAgentStateRuntimeSlice(scenario.to),
  };
}

export function captureLegacyPath(): never {
  throw new Error('A.13.7 recon found no still-executing legacy runtime-mode switch path.');
}

export function captureNormalizedOrchestratorPath(scenario: RuntimeModeParityScenario): NormalizedRuntimeModeParitySnapshot {
  return normalizeRuntimeModeParitySnapshot(captureOrchestratorPath(scenario));
}
