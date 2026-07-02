import type {
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunSessionProvisionOptions,
  ExecutionRunSessionProvisionResult,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { AcpRuntimeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import { logger } from '@/ui/logger';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { projectConnectedServiceRuntimeAuthRecoveryReport } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import {
  asNonEmptyString,
  asRecord,
  type PendingRpcRequest,
} from './rpcSupport';
import {
  emitPiRpcMessage,
  handlePiRpcStderrLine,
  handlePiRpcStdoutLine,
  createPiRpcRuntimeTurnState,
  type PiRpcEventHandlerContext,
} from './eventHandlers';
import {
  capturePiRpcAuthJsonSnapshot,
  ensurePiRpcProcess,
  maybeRestartPiRpcProcessForUpdatedAuthJson,
  restartPiRpcProcessAndContinue,
  spawnPiRpcProcess,
  stopPiRpcProcessForRestart,
  type PiRpcProcessLifecycleContext,
} from './processLifecycle';
import type { PiRpcCommandWithoutId, PiRpcResponse, PiRpcStateData } from './types';
import { PiPendingTurnState } from './piPendingTurnState';
import { PiRuntimeStateTracker } from './piRuntimeStateTracker';
import {
  cancelPiRpcTurn,
  compactPiRpcContext,
  sendPiRpcPrompt,
  sendPiRpcSteerPrompt,
  setPiRpcSessionConfigOption,
  setPiRpcSessionModel,
  type PiRpcResponseFlowContext,
} from './responseFlow';
import { sendPiRpcCommand } from './sendPiRpcCommand';
import { assertPiRpcSession, loadPiRpcSession, startPiRpcSession } from './sessionState';
import { createPiRpcStateOperations } from './backendStateOperations';
import { createPiRpcBackendContextBuilders } from './createPiRpcBackendContextBuilders';
import { createPiRpcBackendMutableState } from './createPiRpcBackendMutableState';
import { createPiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/createPiConnectedServiceRuntimeAuthAdapter';

export type PiRpcSpawnOptions = {
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  happierSessionId?: string | null;
};

const DEFAULT_PI_RPC_TURN_STALL_TIMEOUT_MS = 180_000;
const DEFAULT_PI_RPC_COMPACTION_RESUME_GRACE_MS = 30_000;
const DEFAULT_PI_RPC_AGENT_END_SETTLE_MS = 250;
const DEFAULT_PI_RPC_AGENT_END_BUSY_GRACE_MS = 30_000;
const DEFAULT_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PI_RPC_MAX_SILENT_PROBES = 4;
const DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS = 30_000;
const DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS = 250;
const DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX = 3;
const DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT =
  'Continue the interrupted work from the recovered provider context. Do not restart or repeat completed work.';
const PI_RPC_TURN_STALL_TIMEOUT_ENV = 'HAPPIER_PI_RPC_TURN_STALL_TIMEOUT_MS';
const PI_RPC_COMPACTION_RESUME_GRACE_ENV = 'HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS';
const PI_RPC_AGENT_END_SETTLE_ENV = 'HAPPIER_PI_RPC_AGENT_END_SETTLE_MS';
const PI_RPC_AGENT_END_BUSY_GRACE_ENV = 'HAPPIER_PI_RPC_AGENT_END_BUSY_GRACE_MS';
const PI_RPC_LIVENESS_PROBE_TIMEOUT_ENV = 'HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS';
const PI_RPC_MAX_SILENT_PROBES_ENV = 'HAPPIER_PI_RPC_MAX_SILENT_PROBES';
const PI_RPC_PROMPT_COLLISION_IDLE_WAIT_ENV = 'HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS';
const PI_RPC_PROMPT_COLLISION_IDLE_POLL_ENV = 'HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS';
const PI_RPC_COMPACTION_AUTO_CONTINUE_MAX_ENV = 'HAPPIER_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX';
const PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT_ENV = 'HAPPIER_PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT';

function readPositiveIntegerEnv(env: Record<string, string>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function readNonNegativeIntegerEnv(env: Record<string, string>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}

// Intentional provider-local dual-role leaf: Pi RPC is the native runtime surface
// for both direct backend usage and execution-run hosting, so no second adapter
// owns session/process state for this provider.
export class PiRpcBackend implements AcpRuntimeBackend, ExecutionRunHostRuntime {
  readonly options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    happierSessionId: string | null;
  }>;

  private readonly messageHandlers = new Set<AgentMessageHandler>();
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly openPromptRequestIds = new Set<string>();
  private readonly turnState = new PiPendingTurnState({
    resetOpenPromptRequestIds: () => {
      this.openPromptRequestIds.clear();
    },
    onTurnStalled: (error) => {
      this.emitMessage({
        type: 'status',
        status: 'error',
        detail: error.message,
      });
    },
    probeLiveness: async (timeoutMs) => {
      const state = await this.stateOperations.getState(timeoutMs);
      return {
        isStreaming: state.isStreaming,
        isCompacting: state.isCompacting,
      };
    },
    continueAfterCompactionPause: async () => {
      try {
        await this.sendCommand(
          {
            type: 'prompt',
            message: this.getCompactionAutoContinuePrompt(),
            streamingBehavior: 'followUp',
          },
          this.getLivenessProbeTimeoutMs(),
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        return message.includes('already processing') || message.includes('streamingbehavior');
      }
    },
    classifyTerminalCompactionFailure: ({ detail, payload }) =>
      this.classifyPiRuntimeAuthFailure({
        event: payload,
        message: detail,
      }),
    onRuntimeAuthFailure: (classification) => {
      void this.reportPiRuntimeAuthFailureToDaemon(classification);
    },
    getLivenessProbeTimeoutMs: () => this.getLivenessProbeTimeoutMs(),
    getMaxSilentProbes: () => this.getMaxSilentProbes(),
    getCompactionAutoContinueMax: () => this.getCompactionAutoContinueMax(),
  });
  private readonly createPendingTurn = (timeoutMs: number): Promise<void> => {
    return this.turnState.createPendingTurn(timeoutMs);
  };
  private readonly runtimeState = new PiRuntimeStateTracker();
  private readonly runtimeTurnState = createPiRpcRuntimeTurnState();
  private readonly mutableState = createPiRpcBackendMutableState();
  private readonly connectedServiceRuntimeAuthAdapter = createPiConnectedServiceRuntimeAuthAdapter();
  private readonly stateOperations = createPiRpcStateOperations({
    sendCommand: async (command, timeoutMs) => await this.sendCommand(command, timeoutMs),
    runtimeState: this.runtimeState,
    emitMessage: (message) => {
      this.emitMessage(message);
    },
    isDisposed: () => this.disposed,
    hasProcess: () => Boolean(this.mutableState.getProcess()),
  });
  private disposed = false;
  private anonymousCompactionSequence = 0;
  private activeCompactionLifecycleId: string | null = null;
  private readonly contextBuilders: ReturnType<
    typeof createPiRpcBackendContextBuilders
  >;

  constructor(options: PiRpcSpawnOptions) {
    this.options = {
      cwd: options.cwd,
      command: options.command,
      args: [...options.args],
      env: { ...(options.env ?? {}) },
      happierSessionId: asNonEmptyString(options.happierSessionId) ?? null,
    };
    this.contextBuilders = createPiRpcBackendContextBuilders({
      options: this.options,
      state: this.mutableState,
      isDisposed: () => this.disposed,
      hasPendingTurn: () => this.turnState.hasPendingTurn(),
      hasPendingTurnCompletionScheduled: () => this.turnState.hasPendingTurnCompletionScheduled(),
      hasPendingCompactionResumeScheduled: () => this.turnState.hasPendingCompactionResumeScheduled(),
      emitMessage: (message) => {
        this.emitMessage(message);
      },
      ensureProcess: async () => {
        await this.ensureProcess();
      },
      stopRpcProcessForRestart: async () => {
        await this.stopRpcProcessForRestart();
      },
      spawnRpcProcess: (params) => {
        this.spawnRpcProcess(params);
      },
      captureAuthJsonSnapshot: async () => {
        await this.captureAuthJsonSnapshot();
      },
      getState: async () => await this.stateOperations.getState(),
      publishRuntimeState: async (state) => {
        await this.publishRuntimeState(state);
      },
      assertSession: (sessionId) => {
        this.assertSession(sessionId);
      },
      beginPromptBarrier: () => this.turnState.beginPromptBarrier(),
      createPendingTurn: (timeoutMs) => this.createPendingTurn(timeoutMs),
      getPendingTurnStallTimeoutMs: () => this.getPendingTurnStallTimeoutMs(),
      waitForPromptCollisionToBecomeIdle: async () => {
        await this.waitForPromptCollisionToBecomeIdle();
      },
      hasProcess: () => Boolean(this.mutableState.getProcess()),
      rejectPendingTurn: (error) => {
        this.turnState.rejectPendingTurn(error);
      },
      resolvePendingTurn: () => {
        this.turnState.resolvePendingTurn();
      },
      resolvePendingTurnAsCompactionPaused: () => {
        this.turnState.resolvePendingTurnAsCompactionPaused();
      },
      notePendingTurnActivity: (event) => {
        this.notePendingTurnActivity(event);
      },
      normalizeEvent: (event) => this.normalizeCompactionLifecycleEvent(event),
      keepPendingTurnAliveAfterRetryingAgentEnd: () => this.turnState.keepPendingTurnAliveAfterRetryingAgentEnd(),
      keepPendingTurnAliveAfterRecoverableAssistantError: () => this.turnState.keepPendingTurnAliveAfterRecoverableAssistantError(),
      schedulePendingTurnCompletion: () => this.schedulePendingTurnCompletion(),
      maybeRestartForUpdatedAuthJson: () => this.maybeRestartForUpdatedAuthJson(),
      restartAndContinue: async () => {
        await this.restartAndContinue();
      },
      sendCommand: async (command, timeoutMs) =>
        await this.sendCommand(command, timeoutMs),
      resolveModelSelection: async (modelIdRaw) =>
        await this.resolveModelSelection(modelIdRaw),
      rememberCurrentModelProvider: (provider) => {
        this.runtimeState.rememberCurrentModelProvider(provider);
      },
      pendingRequests: this.pendingRequests,
      messageHandlers: this.messageHandlers,
      openPromptRequestIds: this.openPromptRequestIds,
      runtimeTurnState: this.runtimeTurnState,
      publishUsageStatsBestEffort: async () => {
        await this.publishUsageStatsBestEffort();
      },
      getCurrentModelProvider: () => this.runtimeState.getCurrentModelProvider(),
      classifyRuntimeAuthFailure: (error) => this.classifyPiRuntimeAuthFailure(error),
      reportRuntimeAuthFailureForPendingTurn: (classification) =>
        this.turnState.reportDiagnosticRuntimeAuthFailure(classification),
      onRuntimeAuthFailure: async ({ classification }) => {
        await this.reportPiRuntimeAuthFailureToDaemon(classification);
      },
      handleStdoutLine: (line) => {
        this.handleStdoutLine(line);
      },
      handleStderrLine: (line) => {
        this.handleStderrLine(line);
      },
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  async readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean> {
    return opts?.captureReplay === true ? false : typeof this.loadSession === 'function';
  }

  async provisionSession(
    opts?: ExecutionRunSessionProvisionOptions,
  ): Promise<ExecutionRunSessionProvisionResult> {
    if (opts?.resumeSessionId) {
      const loaded = await this.loadSession(opts.resumeSessionId);
      return { sessionId: loaded.sessionId };
    }

    const started = await this.startSession();
    return { sessionId: started.sessionId };
  }

  subscribeMessages(handler: ExecutionRunHostRuntimeMessageHandler): () => void {
    this.onMessage(handler);
    return () => {
      this.offMessage(handler);
    };
  }

  async startSession(): Promise<StartSessionResult> {
    return await startPiRpcSession(this.createSessionStateContext(async () => {
        const created = await this.sendCommand({ type: 'new_session' }, 60_000);
        if ((asRecord(created.data)?.cancelled ?? false) === true) {
          throw new Error('Pi cancelled new_session');
        }
      }),
    );
  }

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    return await loadPiRpcSession(this.createSessionStateContext(async () => {}), sessionId);
  }

  /**
   * Exposed for best-effort model probing (see `capabilities/probes/agentModelsProbe.ts`).
   * This mirrors the ACP `getSessionModelState` shape.
   */
  getSessionModelState(): { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string }> } | null {
    return this.runtimeState.getSessionModelState();
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    await sendPiRpcPrompt(this.createResponseFlowContext(), sessionId, prompt);
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    await sendPiRpcSteerPrompt(this.createResponseFlowContext(), sessionId, prompt);
  }

  async compactContext(sessionId: SessionId, command: string): Promise<void> {
    await compactPiRpcContext(this.createResponseFlowContext(), sessionId, command);
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    await setPiRpcSessionModel(this.createResponseFlowContext(), sessionId, modelId);
  }

  async setSessionConfigOption(sessionId: SessionId, configId: string, value: string | number | boolean | null): Promise<void> {
    await setPiRpcSessionConfigOption(this.createResponseFlowContext(), sessionId, configId, value);
  }

  async cancel(sessionId: SessionId): Promise<void> {
    await cancelPiRpcTurn(this.createResponseFlowContext(), sessionId);
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    await this.turnState.waitForResponseComplete(timeoutMs);
  }

  async waitForTurnCompletion(timeoutMs?: number | null): Promise<void> {
    await this.waitForResponseComplete(timeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.createProcessLifecycleContext().rejectAllPending(
      new Error('Pi backend disposed'),
    );
    this.turnState.rejectPendingTurn(new Error('Pi backend disposed'));
    this.turnState.rejectBarrier(new Error('Pi backend disposed'));
    await this.stopRpcProcessForRestart();
  }

  private async ensureProcess(): Promise<void> {
    await ensurePiRpcProcess(this.createProcessLifecycleContext());
  }

  private spawnRpcProcess(params: Readonly<{ args: string[] }>): void {
    spawnPiRpcProcess(this.createProcessLifecycleContext(), params);
  }

  private async captureAuthJsonSnapshot(): Promise<void> {
    await capturePiRpcAuthJsonSnapshot(this.createProcessLifecycleContext());
  }

  private maybeRestartForUpdatedAuthJson(): Promise<void> | void {
    return maybeRestartPiRpcProcessForUpdatedAuthJson(this.createProcessLifecycleContext());
  }

  private async restartAndContinue(): Promise<void> {
    await restartPiRpcProcessAndContinue(this.createProcessLifecycleContext());
  }

  private async stopRpcProcessForRestart(): Promise<void> {
    await stopPiRpcProcessForRestart(this.createProcessLifecycleContext());
  }

  private handleStdoutLine(line: string): void {
    handlePiRpcStdoutLine(this.createEventHandlerContext(), (message) => this.emitMessage(message), line);
  }

  private async publishUsageStatsBestEffort(): Promise<void> {
    await this.stateOperations.publishUsageStatsBestEffort();
  }

  private handleStderrLine(line: string): void {
    handlePiRpcStderrLine(this.createEventHandlerContext(), (message) => this.emitMessage(message), line);
  }

  private emitMessage(message: AgentMessage): void {
    emitPiRpcMessage(this.messageHandlers, message);
  }

  private classifyPiRuntimeAuthFailure(error: unknown): ConnectedServiceRuntimeFailureClassification | null {
    const message = asRecord(asRecord(error)?.message);
    return this.connectedServiceRuntimeAuthAdapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: this.mutableState.getSessionId() },
      error: {
        ...(asRecord(error) ?? { message: error }),
        provider:
          asNonEmptyString(asRecord(error)?.provider)
          ?? asNonEmptyString(message?.provider)
          ?? this.runtimeState.getCurrentModelProvider(),
      },
      selection: readConnectedServiceChildSelectionsFromEnv(this.options.env),
    });
  }

  private async reportPiRuntimeAuthFailureToDaemon(
    classification: ConnectedServiceRuntimeFailureClassification,
  ): Promise<void> {
    if (!this.options.happierSessionId) return;
    try {
      const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: this.options.happierSessionId,
        switchesThisTurn: 0,
        classification,
      });
      projectConnectedServiceRuntimeAuthRecoveryReport({
        report: recoveryReport,
        sendGenericStatusMessage: (message) => {
          this.emitMessage({ type: 'terminal-output', data: message });
        },
        commitTypedProjection: (projection) => {
          if (!projection.transcriptEvent) return false;
          this.emitMessage({
            type: 'event',
            name: 'connected-service-runtime-auth-recovery',
            payload: projection.transcriptEvent,
          });
          return true;
        },
      });
    } catch (error) {
      logger.debug('[pi] Failed to report connected-service runtime auth failure to daemon (non-fatal)', error);
    }
  }

  private async sendCommand(
    command: PiRpcCommandWithoutId,
    timeoutMs = 30_000,
  ): Promise<PiRpcResponse> {
    return await sendPiRpcCommand({
      ensureProcess: async () => {
        await this.ensureProcess();
      },
      getProcess: this.mutableState.getProcess,
      pendingRequests: this.pendingRequests,
      openPromptRequestIds: this.openPromptRequestIds,
      command,
      timeoutMs,
    });
  }

  private async publishRuntimeState(state: PiRpcStateData): Promise<void> {
    await this.stateOperations.publishRuntimeState(state);
  }

  private async resolveModelSelection(modelIdRaw: string): Promise<{ provider: string; modelId: string }> {
    return await this.stateOperations.resolveModelSelection(modelIdRaw);
  }

  private assertSession(sessionId: SessionId): void {
    assertPiRpcSession(this.mutableState.getSessionId(), sessionId);
  }

  private getPendingTurnStallTimeoutMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_TURN_STALL_TIMEOUT_ENV,
      DEFAULT_PI_RPC_TURN_STALL_TIMEOUT_MS,
    );
  }

  private getCompactionResumeGraceMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_COMPACTION_RESUME_GRACE_ENV,
      DEFAULT_PI_RPC_COMPACTION_RESUME_GRACE_MS,
    );
  }

  private getAgentEndSettleMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_AGENT_END_SETTLE_ENV,
      DEFAULT_PI_RPC_AGENT_END_SETTLE_MS,
    );
  }

  private getAgentEndBusyGraceMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_AGENT_END_BUSY_GRACE_ENV,
      DEFAULT_PI_RPC_AGENT_END_BUSY_GRACE_MS,
    );
  }

  private getLivenessProbeTimeoutMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_LIVENESS_PROBE_TIMEOUT_ENV,
      DEFAULT_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS,
    );
  }

  private getMaxSilentProbes(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_MAX_SILENT_PROBES_ENV,
      DEFAULT_PI_RPC_MAX_SILENT_PROBES,
    );
  }

  private getPromptCollisionIdleWaitMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_PROMPT_COLLISION_IDLE_WAIT_ENV,
      DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS,
    );
  }

  private getPromptCollisionIdlePollMs(): number {
    return readPositiveIntegerEnv(
      this.options.env,
      PI_RPC_PROMPT_COLLISION_IDLE_POLL_ENV,
      DEFAULT_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS,
    );
  }

  private getCompactionAutoContinueMax(): number {
    return readNonNegativeIntegerEnv(
      this.options.env,
      PI_RPC_COMPACTION_AUTO_CONTINUE_MAX_ENV,
      DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX,
    );
  }

  private getCompactionAutoContinuePrompt(): string {
    const configured = this.options.env[PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT_ENV];
    if (typeof configured === 'string') {
      const trimmed = configured.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return DEFAULT_PI_RPC_COMPACTION_AUTO_CONTINUE_PROMPT;
  }

  private async waitForPromptCollisionToBecomeIdle(): Promise<void> {
    const quiesceBudgetMs = this.getPromptCollisionIdleWaitMs();
    const pollMs = this.getPromptCollisionIdlePollMs();
    const probeTimeoutMs = Math.min(this.getLivenessProbeTimeoutMs(), quiesceBudgetMs);
    // Wait for the in-flight work to finish, then let the caller send a clean prompt. While a turn is
    // still pending we wait indefinitely: that turn's own event-aware liveness probe (with its
    // silent-probe ceiling) is the single authority on whether Pi is genuinely stuck, so a long-but-live
    // turn is never failed and a hung one is settled there — we never fail/drop the user's prompt just
    // because Pi is busy, and we never send Pi `abort` here. Once no turn is pending, the prior turn has
    // settled; we then only confirm Pi has quiesced, and we bound that confirmation so a hung/unreachable
    // Pi (or one still reporting `isStreaming` after its turn was force-stalled) surfaces a clear error
    // instead of blocking the caller forever.
    let unreachableSince: number | null = null;
    let quiesceSince: number | null = null;
    for (;;) {
      let state: PiRpcStateData | null = null;
      try {
        state = await this.stateOperations.getState(probeTimeoutMs);
        unreachableSince = null;
      } catch {
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= quiesceBudgetMs) {
          throw new Error('Pi became unreachable while waiting for the previous prompt to finish');
        }
      }
      if (this.turnState.hasPendingTurn()) {
        quiesceSince = null;
      } else {
        if (state && state.isStreaming !== true && state.isCompacting !== true) return;
        quiesceSince ??= Date.now();
        if (Date.now() - quiesceSince >= quiesceBudgetMs) {
          throw new Error('Pi did not return to idle after the previous prompt settled');
        }
      }
      await delay(pollMs);
    }
  }

  private readCompactionLifecycleId(event: Record<string, unknown>): string | null {
    return (
      asNonEmptyString(event.compactionId) ??
      asNonEmptyString(event.compaction_id) ??
      asNonEmptyString(event.id) ??
      asNonEmptyString(event.turnId) ??
      asNonEmptyString(event.turn_id)
    );
  }

  private normalizeCompactionLifecycleEvent(event: Record<string, unknown>): Record<string, unknown> {
    if (event.type !== 'compaction_start' && event.type !== 'compaction_end') return event;

    const explicitLifecycleId = this.readCompactionLifecycleId(event);
    if (event.type === 'compaction_start') {
      const lifecycleId = explicitLifecycleId ?? `pi:context-compaction:${++this.anonymousCompactionSequence}`;
      this.activeCompactionLifecycleId = lifecycleId;
      return explicitLifecycleId ? event : { ...event, compactionId: lifecycleId };
    }

    const lifecycleId = explicitLifecycleId
      ?? this.activeCompactionLifecycleId
      ?? `pi:context-compaction:${++this.anonymousCompactionSequence}`;
    this.activeCompactionLifecycleId = null;
    return explicitLifecycleId ? event : { ...event, compactionId: lifecycleId };
  }

  private notePendingTurnActivity(event: Record<string, unknown>): void {
    this.turnState.noteActivity(event, {
      compactionResumeGraceMs: this.getCompactionResumeGraceMs(),
      agentEndSettleMs: this.getAgentEndSettleMs(),
      agentEndBusyGraceMs: Math.min(this.getAgentEndBusyGraceMs(), this.getPendingTurnStallTimeoutMs()),
      afterCompactionPaused: (payload) => {
        this.emitMessage({ type: 'status', status: 'idle' });
        this.emitMessage({
          type: 'event',
          name: 'context_compaction',
          payload: {
            ...payload,
            type: 'context-compaction',
            continuation: 'paused',
            pauseReason: 'provider-idle-after-compaction',
          },
        });
        void this.publishUsageStatsBestEffort();
      },
      afterAgentEndCompleted: () => {
        this.emitMessage({ type: 'status', status: 'idle' });
        void this.publishUsageStatsBestEffort();
      },
    });
  }

  private schedulePendingTurnCompletion(): boolean {
    return this.turnState.schedulePendingTurnCompletion(
      this.getAgentEndSettleMs(),
      () => {
        this.emitMessage({ type: 'status', status: 'idle' });
        void this.publishUsageStatsBestEffort();
      },
      Math.min(this.getAgentEndBusyGraceMs(), this.getPendingTurnStallTimeoutMs()),
    );
  }

  private createSessionStateContext(createSession: () => Promise<void>) {
    return this.contextBuilders.createSessionStateContext(createSession);
  }

  private createResponseFlowContext(): PiRpcResponseFlowContext {
    return this.contextBuilders.createResponseFlowContext();
  }

  private createEventHandlerContext(): PiRpcEventHandlerContext {
    return this.contextBuilders.createEventHandlerContext();
  }

  private createProcessLifecycleContext(): PiRpcProcessLifecycleContext {
    return this.contextBuilders.createProcessLifecycleContext();
  }

}
