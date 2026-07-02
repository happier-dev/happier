import { resolvePiCompactionTurnOutcome } from '@happier-dev/plugins-pi/agent/runtime/compaction';
import { buildPiCompletedContextCompactionPayload } from '@happier-dev/plugins-pi/agent/runtime/rpc/events';
import { asNonEmptyString, asRecord, createDeferred, type Deferred } from './rpcSupport';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

type PiPendingTurn = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
  timeoutMs: number;
  agentEndSettleTimeout: NodeJS.Timeout | null;
  compactionResumeTimeout: NodeJS.Timeout | null;
  compactionInProgress: boolean;
  compactionPauseHandler: ((payload: Record<string, unknown>) => void) | null;
  agentEndObserved: boolean;
  activityEpoch: number;
  consecutiveSilentProbes: number;
  livenessProbeInFlight: boolean;
  livenessProbeRerunRequested: boolean;
  recoverableAssistantErrorObserved: boolean;
  lastCompactionEnd: {
    payload: Record<string, unknown>;
    willRetry: boolean;
    errorMessage: string | null;
    phase: string | null;
    errorCode: string | null;
  } | null;
  lastAssistantStopReason: string | null;
  turnCompletionHandler: (() => void) | null;
  compactionAutoContinueAttempts: number;
  stderrRuntimeAuthReportedKeys: Set<string>;
};

type PiPendingTurnActivityOptions = Readonly<{
  compactionResumeGraceMs: number;
  agentEndSettleMs?: number;
  agentEndBusyGraceMs?: number;
  afterCompactionPaused: (payload: Record<string, unknown>) => void;
  afterAgentEndCompleted?: () => void;
}>;

type PiPendingTurnLiveness = Readonly<{
  isStreaming?: boolean;
  isCompacting?: boolean;
}>;

export class PiPendingTurnState {
  private pendingTurn: PiPendingTurn | null = null;
  private pendingTurnBarrier: Deferred<void> | null = null;

  constructor(private readonly params: Readonly<{
    resetOpenPromptRequestIds: () => void;
    onTurnStalled?: (error: Error) => void;
    probeLiveness: (timeoutMs: number) => Promise<PiPendingTurnLiveness | null>;
    continueAfterCompactionPause: () => Promise<boolean>;
    classifyTerminalCompactionFailure?: (input: Readonly<{
      detail: string;
      payload: Record<string, unknown> | null;
    }>) => ConnectedServiceRuntimeFailureClassification | null;
    onRuntimeAuthFailure?: (classification: ConnectedServiceRuntimeFailureClassification) => void | Promise<void>;
    getLivenessProbeTimeoutMs: () => number;
    getMaxSilentProbes: () => number;
    getCompactionAutoContinueMax: () => number;
  }>) {}

  beginPromptBarrier(): Readonly<{
    promise: Promise<void>;
    settle: (error?: Error) => void;
  }> {
    const barrier = createDeferred<void>();
    this.pendingTurnBarrier = barrier;
    return {
      promise: barrier.promise,
      settle: (error?: Error) => {
        if (this.pendingTurnBarrier !== barrier) return;
        this.pendingTurnBarrier = null;
        if (error) {
          barrier.reject(error);
          return;
        }
        barrier.resolve(undefined);
      },
    };
  }

  rejectBarrier(error: Error): void {
    if (!this.pendingTurnBarrier) return;
    const barrier = this.pendingTurnBarrier;
    this.pendingTurnBarrier = null;
    barrier.reject(error);
  }

  hasPendingTurn(): boolean {
    return this.pendingTurn !== null;
  }

  createPendingTurn(timeoutMs: number): Promise<void> {
    if (this.pendingTurn) {
      return Promise.reject(new Error('Pi pending turn already exists'));
    }
    const deferred = createDeferred<void>();
    const pending: PiPendingTurn = {
      promise: deferred.promise,
      resolve: () => {
        deferred.resolve(undefined);
      },
      reject: deferred.reject,
      timeout: null,
      timeoutMs: Math.max(1, Math.trunc(timeoutMs)),
      agentEndSettleTimeout: null,
      compactionResumeTimeout: null,
      compactionInProgress: false,
      compactionPauseHandler: null,
      agentEndObserved: false,
      activityEpoch: 0,
      consecutiveSilentProbes: 0,
      livenessProbeInFlight: false,
      livenessProbeRerunRequested: false,
      recoverableAssistantErrorObserved: false,
      lastCompactionEnd: null,
      lastAssistantStopReason: null,
      turnCompletionHandler: null,
      compactionAutoContinueAttempts: 0,
      stderrRuntimeAuthReportedKeys: new Set(),
    };

    this.pendingTurn = pending;
    this.armPendingTurnInactivityTimer(pending);
    return pending.promise;
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    if (!this.pendingTurn && this.pendingTurnBarrier) {
      await this.pendingTurnBarrier.promise;
    }
    if (!this.pendingTurn) return;
    const turn = this.pendingTurn;

    const stallTimeoutMs =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.trunc(timeoutMs)
        : null;

    if (stallTimeoutMs === null) {
      await turn.promise;
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        turn.promise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Timed out waiting for Pi response completion'));
          }, stallTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  resolvePendingTurn(): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.params.resetOpenPromptRequestIds();
    pending.resolve();
  }

  rejectPendingTurn(error: Error): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.params.resetOpenPromptRequestIds();
    pending.reject(error);
  }

  hasPendingTurnCompletionScheduled(): boolean {
    return this.pendingTurn?.agentEndSettleTimeout !== null;
  }

  hasPendingCompactionResumeScheduled(): boolean {
    return this.pendingTurn?.compactionResumeTimeout !== null;
  }

  resolvePendingTurnAsCompactionPaused(): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.resolvePendingTurnAsCompactionPausedFor(pending);
  }

  noteActivity(event: Record<string, unknown>, options: PiPendingTurnActivityOptions): void {
    const pending = this.pendingTurn;
    if (!pending) return;

    pending.activityEpoch += 1;
    pending.consecutiveSilentProbes = 0;
    pending.turnCompletionHandler = options.afterAgentEndCompleted ?? pending.turnCompletionHandler;

    const type = asNonEmptyString(event.type);
    if (type === 'message_end') {
      const message = asRecord(event.message);
      if (message?.role === 'assistant') {
        const stopReason = asNonEmptyString(message.stopReason ?? message.stop_reason);
        pending.lastAssistantStopReason = stopReason;
        const errorMessage = asNonEmptyString(message.errorMessage ?? message.error_message ?? event.errorMessage ?? event.error_message);
        pending.recoverableAssistantErrorObserved = stopReason === 'error' || Boolean(errorMessage);
      }
    }
    if (type === 'compaction_start') {
      pending.compactionInProgress = true;
      pending.agentEndObserved = false;
      pending.lastCompactionEnd = null;
      pending.compactionPauseHandler = null;
      this.cancelPendingTurnAgentEndSettle(pending);
      this.cancelPendingTurnCompactionResume(pending);
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (type === 'agent_start') {
      pending.compactionInProgress = false;
      pending.agentEndObserved = false;
      pending.recoverableAssistantErrorObserved = false;
      pending.lastCompactionEnd = null;
      pending.lastAssistantStopReason = null;
      pending.compactionPauseHandler = null;
      this.cancelPendingTurnAgentEndSettle(pending);
      this.cancelPendingTurnCompactionResume(pending);
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (type === 'compaction_end') {
      const compactionPayload = buildPiCompletedContextCompactionPayload(event, {
        allowAutoTrigger: true,
      });
      if (!compactionPayload) return;
      pending.compactionInProgress = false;
      pending.agentEndObserved = false;
      pending.lastCompactionEnd = {
        payload: compactionPayload,
        willRetry: event.willRetry === true,
        errorMessage: asNonEmptyString(event.errorMessage ?? event.error_message) ?? null,
        phase: asNonEmptyString(compactionPayload.phase) ?? null,
        errorCode: asNonEmptyString(compactionPayload.errorCode) ?? null,
      };
      pending.compactionPauseHandler = options.afterCompactionPaused;
      this.cancelPendingTurnAgentEndSettle(pending);
      this.armPendingTurnInactivityTimer(pending);
      const outcome = resolvePiCompactionTurnOutcome(pending);
      if (outcome === 'completed_post_final') {
        this.resolvePendingTurnAfterPostFinalCompaction(pending);
        return;
      }
      if (outcome === 'terminal_failure') {
        this.rejectPendingTurnAsCompactionFailed(pending, pending.lastCompactionEnd.errorMessage ?? 'context-compaction failed');
        return;
      }
      this.scheduleCompactionResumeGrace(pending, options);
      return;
    }

    if (type !== 'agent_end') {
      this.cancelPendingTurnAgentEndSettle(pending);
    }

    if (pending.agentEndObserved) {
      this.schedulePendingTurnCompletion(
        options.agentEndSettleMs ?? pending.timeoutMs,
        options.afterAgentEndCompleted ?? (() => undefined),
        options.agentEndBusyGraceMs ?? pending.timeoutMs,
      );
      return;
    }

    this.armPendingTurnInactivityTimer(pending);
  }

  schedulePendingTurnCompletion(settleMs: number, afterCompleted: () => void, busyGraceMs?: number): boolean {
    const pending = this.pendingTurn;
    if (!pending) return false;
    pending.agentEndObserved = true;
    this.cancelPendingTurnAgentEndSettle(pending);
    this.clearPendingTurnInactivityTimer(pending);

    const timeout = setTimeout(() => {
      void this.settlePendingTurnAfterAgentEnd(pending, Math.max(1, Math.trunc(busyGraceMs ?? pending.timeoutMs)), afterCompleted);
    }, Math.max(1, Math.trunc(settleMs)));
    timeout.unref?.();
    pending.agentEndSettleTimeout = timeout;
    return true;
  }

  keepPendingTurnAliveAfterRetryingAgentEnd(): boolean {
    const pending = this.pendingTurn;
    if (!pending) return false;
    pending.agentEndObserved = false;
    this.cancelPendingTurnAgentEndSettle(pending);
    this.armPendingTurnInactivityTimer(pending);
    return true;
  }

  keepPendingTurnAliveAfterRecoverableAssistantError(): boolean {
    const pending = this.pendingTurn;
    if (!pending?.recoverableAssistantErrorObserved) return false;
    pending.agentEndObserved = false;
    this.cancelPendingTurnAgentEndSettle(pending);
    this.armPendingTurnInactivityTimer(pending);
    return true;
  }

  reportDiagnosticRuntimeAuthFailure(classification: ConnectedServiceRuntimeFailureClassification): boolean {
    const pending = this.pendingTurn;
    if (!pending) return false;
    const reportKey = [
      classification.kind,
      classification.serviceId,
      classification.profileId ?? '',
      classification.groupId ?? '',
      classification.quotaScope ?? '',
    ].join(':');
    if (pending.stderrRuntimeAuthReportedKeys.has(reportKey)) return true;
    pending.stderrRuntimeAuthReportedKeys.add(reportKey);
    void Promise.resolve(this.params.onRuntimeAuthFailure?.(classification));
    return true;
  }

  private rejectPendingTurnAsStalled(pending: PiPendingTurn): void {
    if (this.pendingTurn !== pending) return;
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.params.resetOpenPromptRequestIds();
    const error = new Error('Timed out waiting for Pi turn completion');
    this.params.onTurnStalled?.(error);
    pending.reject(error);
  }

  private rejectPendingTurnAsCompactionFailed(pending: PiPendingTurn, detail: string): void {
    if (this.pendingTurn !== pending) return;
    const classification = this.params.classifyTerminalCompactionFailure?.({
      detail,
      payload: pending.lastCompactionEnd?.payload ?? null,
    }) ?? null;
    this.pendingTurn = null;
    this.clearPendingTurnTimers(pending);
    this.params.resetOpenPromptRequestIds();
    const error = new Error(detail);
    if (classification) {
      Object.assign(error, { runtimeAuthClassification: classification });
      void Promise.resolve(this.params.onRuntimeAuthFailure?.(classification));
    }
    this.params.onTurnStalled?.(error);
    pending.reject(error);
  }

  private clearPendingTurnTimers(pending: PiPendingTurn): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    if (pending.agentEndSettleTimeout) {
      clearTimeout(pending.agentEndSettleTimeout);
      pending.agentEndSettleTimeout = null;
    }
    if (pending.compactionResumeTimeout) {
      clearTimeout(pending.compactionResumeTimeout);
      pending.compactionResumeTimeout = null;
    }
  }

  private clearPendingTurnInactivityTimer(pending: PiPendingTurn): void {
    if (!pending.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }

  private armPendingTurnInactivityTimer(pending: PiPendingTurn): void {
    if (this.pendingTurn !== pending) return;
    this.clearPendingTurnInactivityTimer(pending);

    const timeout = setTimeout(() => {
      void this.probeLivenessAndDecide(pending);
    }, pending.timeoutMs);
    timeout.unref?.();
    pending.timeout = timeout;
  }

  private async probeLivenessAndDecide(pending: PiPendingTurn): Promise<void> {
    if (this.pendingTurn !== pending) return;
    if (pending.livenessProbeInFlight) {
      pending.livenessProbeRerunRequested = true;
      return;
    }
    pending.livenessProbeInFlight = true;
    pending.livenessProbeRerunRequested = false;
    const epoch = pending.activityEpoch;

    let liveness: PiPendingTurnLiveness | null = null;
    try {
      liveness = await this.params.probeLiveness(this.params.getLivenessProbeTimeoutMs());
    } catch {
      liveness = null;
    } finally {
      pending.livenessProbeInFlight = false;
    }

    if (this.pendingTurn !== pending) return;
    if (pending.activityEpoch !== epoch) {
      if (pending.livenessProbeRerunRequested || pending.timeout === null) {
        pending.livenessProbeRerunRequested = false;
        this.armPendingTurnInactivityTimer(pending);
      }
      return;
    }

    if (!liveness) {
      pending.consecutiveSilentProbes += 1;
      if (pending.consecutiveSilentProbes >= this.params.getMaxSilentProbes()) {
        this.rejectPendingTurnAsStalled(pending);
        return;
      }
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (liveness.isStreaming === true || liveness.isCompacting === true || pending.compactionInProgress) {
      pending.consecutiveSilentProbes = 0;
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    if (pending.lastCompactionEnd?.willRetry === true) {
      // Overflow recovery can sit between "compaction finished" and "retry resumed" for much
      // longer than the short resume grace, especially around PI restarts/resumes. If PI reports
      // active streaming/compaction we handled that above; if it now reports idle, settle this as a
      // paused compaction rather than a failed turn. The user can continue explicitly, and a later
      // provider resume is not preceded by a stale `turn_failed` transcript marker.
      this.resolvePendingTurnAsCompactionPausedFor(pending);
      return;
    }

    if (pending.lastCompactionEnd) {
      void this.continuePendingTurnAfterCompactionPause(pending);
      return;
    }

    this.rejectPendingTurnAsStalled(pending);
  }

  private async settlePendingTurnAfterAgentEnd(
    pending: PiPendingTurn,
    busyGraceMs: number,
    afterCompleted: () => void,
  ): Promise<void> {
    if (this.pendingTurn !== pending) return;
    pending.agentEndSettleTimeout = null;
    if (pending.compactionInProgress) {
      this.armPendingTurnInactivityTimer(pending);
      return;
    }

    let liveness: PiPendingTurnLiveness | null = null;
    try {
      liveness = await this.params.probeLiveness(this.params.getLivenessProbeTimeoutMs());
    } catch {
      liveness = null;
    }

    if (this.pendingTurn !== pending) return;
    if (liveness && (liveness.isStreaming === true || liveness.isCompacting === true)) {
      this.schedulePendingTurnCompletionBusyGrace(pending, Math.min(busyGraceMs, pending.timeoutMs), afterCompleted);
      return;
    }

    this.resolvePendingTurn();
    afterCompleted();
  }

  private schedulePendingTurnCompletionBusyGrace(
    pending: PiPendingTurn,
    busyGraceMs: number,
    afterCompleted: () => void,
  ): void {
    if (this.pendingTurn !== pending) return;
    this.cancelPendingTurnAgentEndSettle(pending);
    this.clearPendingTurnInactivityTimer(pending);
    const timeout = setTimeout(() => {
      if (this.pendingTurn !== pending || pending.compactionInProgress) return;
      void this.settlePendingTurnAfterAgentEnd(pending, busyGraceMs, afterCompleted);
    }, Math.max(1, Math.trunc(busyGraceMs)));
    timeout.unref?.();
    pending.agentEndSettleTimeout = timeout;
  }

  private cancelPendingTurnAgentEndSettle(pending: PiPendingTurn): void {
    if (!pending.agentEndSettleTimeout) return;
    clearTimeout(pending.agentEndSettleTimeout);
    pending.agentEndSettleTimeout = null;
  }

  private cancelPendingTurnCompactionResume(pending: PiPendingTurn): void {
    if (!pending.compactionResumeTimeout) return;
    clearTimeout(pending.compactionResumeTimeout);
    pending.compactionResumeTimeout = null;
  }

  private scheduleCompactionResumeGrace(pending: PiPendingTurn, options: PiPendingTurnActivityOptions): void {
    if (this.pendingTurn !== pending) return;
    pending.compactionPauseHandler = options.afterCompactionPaused;
    this.cancelPendingTurnCompactionResume(pending);

    const timeout = setTimeout(() => {
      if (this.pendingTurn !== pending) return;
      void this.continuePendingTurnAfterCompactionPause(pending);
    }, Math.max(1, Math.trunc(options.compactionResumeGraceMs)));
    timeout.unref?.();
    pending.compactionResumeTimeout = timeout;
  }

  private async continuePendingTurnAfterCompactionPause(pending: PiPendingTurn): Promise<void> {
    if (this.pendingTurn !== pending) return;
    if (pending.lastCompactionEnd?.willRetry === true) {
      // Do not turn a delayed PI overflow retry into a false failed turn. The inactivity/liveness
      // probe is the authority: while PI reports streaming/compacting it can run indefinitely; once
      // PI reports idle, `probeLivenessAndDecide` resolves the turn as a paused compaction.
      this.cancelPendingTurnCompactionResume(pending);
      this.armPendingTurnInactivityTimer(pending);
      return;
    }
    // Completed-final wins over terminal-failure via the shared helper, so a post-final
    // maintenance-compaction failure never escalates the already-completed turn.
    const outcome = resolvePiCompactionTurnOutcome(pending);
    if (outcome === 'completed_post_final') {
      this.resolvePendingTurnAfterPostFinalCompaction(pending);
      return;
    }
    if (outcome === 'terminal_failure') {
      this.rejectPendingTurnAsCompactionFailed(pending, pending.lastCompactionEnd?.errorMessage ?? 'context-compaction failed');
      return;
    }

    if (pending.compactionAutoContinueAttempts >= this.params.getCompactionAutoContinueMax()) {
      this.resolvePendingTurnAsCompactionPausedFor(pending);
      return;
    }

    pending.compactionAutoContinueAttempts += 1;
    this.cancelPendingTurnCompactionResume(pending);
    this.armPendingTurnInactivityTimer(pending);

    let continued = false;
    try {
      continued = await this.params.continueAfterCompactionPause();
    } catch {
      continued = false;
    }

    if (this.pendingTurn !== pending) return;
    if (!continued) {
      this.rejectPendingTurnAsStalled(pending);
      return;
    }
    this.armPendingTurnInactivityTimer(pending);
  }

  private resolvePendingTurnAfterPostFinalCompaction(pending: PiPendingTurn): void {
    if (this.pendingTurn !== pending) return;
    const handler = pending.turnCompletionHandler;
    this.resolvePendingTurn();
    handler?.();
  }

  private resolvePendingTurnAsCompactionPausedFor(pending: PiPendingTurn): void {
    if (this.pendingTurn !== pending) return;
    // Same shared decision as continuePendingTurnAfterCompactionPause so the ordering of
    // completed-final vs terminal-failure cannot drift between the two termination paths.
    const outcome = resolvePiCompactionTurnOutcome(pending);
    if (outcome === 'completed_post_final') {
      this.resolvePendingTurnAfterPostFinalCompaction(pending);
      return;
    }
    if (outcome === 'terminal_failure') {
      this.rejectPendingTurnAsCompactionFailed(pending, pending.lastCompactionEnd?.errorMessage ?? 'context-compaction failed');
      return;
    }
    const payload = pending.lastCompactionEnd?.payload;
    if (!payload) return;
    const handler = pending.compactionPauseHandler;
    this.resolvePendingTurn();
    handler?.(payload);
  }
}
