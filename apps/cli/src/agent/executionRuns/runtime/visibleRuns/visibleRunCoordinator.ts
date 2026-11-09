import {
  EXECUTION_RUN_VISIBLE_ERROR_CODES,
  applyExecutionRunLinkDeliveryV1,
  applyExecutionRunLinkRelayV1,
  applyExecutionRunLinkV1ToMetadata,
  buildSessionOriginV1,
  isSessionUsageLimitRecoveryInProgressV1,
  readExecutionRunLinkV1,
  readExecutionRunLinkV1FromMessageMeta,
  readSessionRoleAssignmentV1,
  resolveSessionRolePromptNameV1,
  type ExecutionRunLinkStateV1,
  type ExecutionRunLinkV1,
  type FreshAssignableSessionRoleV1,
  type PendingRequestedActionV1,
  type SessionExecutionRunChildTurnReportV1Request,
  type SessionExecutionRunChildTurnReportV1Response,
} from '@happier-dev/protocol';

import type { ExecutionRunController, ExecutionRunSessionController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import { buildExecutionRunProfileStartParams } from '@/agent/executionRuns/runtime/buildExecutionRunProfileStartParams';
import type { ExecutionRunLaunchRoleV1, ExecutionRunManagerStartParams, ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { runBoundedCompletionWithRepair } from '@/agent/executionRuns/runtime/runBoundedCompletionWithRepair';
import { logger } from '@/ui/logger';

import {
  detectVisibleRunControlsChange,
  readVisibleRunTurnOutputs,
  type VisibleRunControls,
  type VisibleRunTranscriptMessage,
} from './visibleRunRules';
import type { VisibleRunSessionPort } from './visibleRunSessionPort';

type FinishRunNext = Readonly<{
  status: ExecutionRunState['status'];
  summary?: string;
  finishedAtMs: number;
  error?: { code: string; message?: string };
}>;

export type VisibleRunCoordinatorDeps = Readonly<{
  hostSessionId: string;
  port: VisibleRunSessionPort;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  getNowMs: () => number;
  finishRun: (
    runId: string,
    next: FinishRunNext,
    toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
    structuredMeta?: ExecutionRunProfileBoundedCompleteResult['structuredMeta'],
  ) => Promise<void>;
  /** The same bounded task deadline hidden runs use; null leaves the run unbounded. */
  resolveTaskDeadlineMs: (params: ExecutionRunManagerStartParams) => number | null;
  /** The existing child-provisioning backstop: the window for the child's `linked` handshake. */
  handshakeTimeoutMs: number;
  onPublicStateUpdated: (runId: string) => void;
  /** Rewrites the run's daemon marker now (its recovery record). */
  writeMarker: (runId: string) => void;
  /**
   * Offsets after the latest accepted wake-up (the `linked` handshake, a turn report, or
   * rehydration) at which the parent re-reads the child transcript once each, then stops. They
   * recover a lost wake-up without the optional run deadline.
   */
  recoveryReReadDelaysMs: readonly number[];
}>;

type EvaluateOptions = Readonly<{ atDeadline: boolean; recoveryReRead?: boolean }>;

/** The plan's recovery cadence: 1, 5, and 15 minutes after the latest accepted wake-up. */
export const VISIBLE_RUN_RECOVERY_REREAD_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000];

/** Execution-run delivery mapping onto queued-message actions (no control overrides, ever). */
const DELIVERY_TO_REQUESTED_ACTION: Readonly<Record<string, PendingRequestedActionV1>> = {
  prompt: { v: 1, kind: 'enqueue' },
  steer_if_supported: { v: 1, kind: 'steer_if_active' },
  interrupt: { v: 1, kind: 'steer_now' },
};

export function buildVisibleRunCompletionLocalId(runId: string): string {
  return `execution-run-completion:${runId}`;
}

/** The run's task message: the one carrying its link meta, or a created child's first user message. */
function taskMessageMatcher(runId: string, binding: 'created' | 'reused') {
  return (message: VisibleRunTranscriptMessage) => {
    const link = readExecutionRunLinkV1FromMessageMeta(message.meta);
    return link ? link.runId === runId : binding === 'created';
  };
}

function isCompletionInputForRun(message: VisibleRunTranscriptMessage, runId: string): boolean {
  if (message.role !== 'user') return false;
  const structured = message.meta?.happierStructuredInputV1 as { executionRunCompletion?: { runId?: unknown } } | undefined;
  return structured?.executionRunCompletion?.runId === runId;
}

/**
 * The `session` controller owner (plan 2A/2B/2M): a visible run's work happens in a linked child
 * Session. Exactly one task completion; terminal states are final; follow-up work is a new run.
 */
export class VisibleRunCoordinator {
  private readonly deps: VisibleRunCoordinatorDeps;
  /** R21: relays awaiting delivery verification, registered before the enqueue so no bind is missed. */
  private readonly pendingDeliveryByLocalId = new Map<string, { runId: string; bound: boolean; verifying: boolean; rerun: boolean }>();

  constructor(deps: VisibleRunCoordinatorDeps) {
    this.deps = deps;
  }

  isBusy(childSessionId: string): boolean {
    for (const [runId, ctrl] of this.deps.controllers) {
      if (ctrl.kind !== 'session' || ctrl.linkedSessionId !== childSessionId) continue;
      if (this.deps.runs.get(runId)?.status === 'running') return true;
    }
    return false;
  }

  private sessionController(runId: string): ExecutionRunSessionController | null {
    const ctrl = this.deps.controllers.get(runId);
    return ctrl && ctrl.kind === 'session' ? ctrl : null;
  }

  private patchRun(runId: string, patch: (run: ExecutionRunState) => ExecutionRunState): void {
    const run = this.deps.runs.get(runId);
    if (run) this.deps.runs.set(runId, patch(run));
  }

  private mirrorLinkState(runId: string, patch: Partial<ExecutionRunLinkStateV1>): void {
    this.patchRun(runId, (run) => ({ ...run, linkState: { ...(run.linkState ?? {}), ...patch } }));
    this.deps.onPublicStateUpdated(runId);
  }

  /** Creates or binds the child and delivers the task. Called from the shared run start owner. */
  async startController(args: Readonly<{
    runId: string;
    params: ExecutionRunManagerStartParams;
    controls: VisibleRunControls;
    sessionRoleV1?: FreshAssignableSessionRoleV1;
  }>): Promise<ExecutionRunSessionController> {
    const run = this.deps.runs.get(args.runId);
    if (!run) throw new Error('Visible run state is missing');
    const profile = resolveExecutionRunIntentProfile(args.params.intent);
    // A visible child carries its role as a Session; the task prompt is exactly the profile prompt.
    const { role: _sessionRole, ...start } = buildExecutionRunProfileStartParams(run);
    const prompt = profile.buildPrompt(start);
    const link: ExecutionRunLinkV1 = { v: 1, parentSessionId: this.deps.hostSessionId, runId: args.runId, turnEpoch: 0 };
    const targetSessionId = args.params.targetSessionId ?? null;

    let linkedSessionId: string;
    if (targetSessionId) {
      await this.deps.port.updateChildMetadata(targetSessionId, (metadata) => applyExecutionRunLinkV1ToMetadata(metadata, link));
      await this.deps.port.sendChildMessage(targetSessionId, {
        text: prompt,
        requestedAction: { v: 1, kind: 'enqueue' },
        executionRunLinkV1: link,
      });
      linkedSessionId = targetSessionId;
    } else {
      const created = await this.deps.port.createChild({
        backendTarget: args.params.backendTarget,
        permissionMode: args.controls.sessionPermissionMode,
        ...(args.params.modelId ? { modelId: args.params.modelId } : {}),
        ...(args.params.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: args.params.sessionConfigOptionOverrides } : {}),
        ...(args.params.connectedServicesSelection !== undefined ? { connectedServices: args.params.connectedServicesSelection } : {}),
        ...(args.sessionRoleV1 ? { sessionRoleV1: args.sessionRoleV1 } : {}),
        sessionOriginV1: buildSessionOriginV1({
          creatorSessionId: this.deps.hostSessionId,
          via: { kind: 'execution_run', runId: args.runId },
        }),
        executionRunLinkV1: link,
        firstInputText: prompt,
        spawnNonce: `execution-run:${args.runId}`,
      });
      linkedSessionId = created.sessionId;
    }

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const deadlineMs = this.deps.resolveTaskDeadlineMs(args.params);
    const ctrl: ExecutionRunSessionController = {
      kind: 'session',
      linkedSessionId,
      binding: targetSessionId ? 'reused' : 'created',
      controls: args.controls,
      linked: false,
      lastReportedTurnEpoch: 0,
      deadlineAtMs: typeof deadlineMs === 'number' ? this.deps.getNowMs() + deadlineMs : null,
      observedChildReportEpoch: 0,
      lastTurnFailed: false,
      recoveryTimer: null,
      evaluatedTurnCount: 0,
      completion: null,
      pendingRepair: null,
      evaluationTail: Promise.resolve(),
      cancelled: false,
      handshakeTimer: null,
      deadlineTimer: null,
      lastMarkerWriteAtMs: 0,
      terminalPromise,
      resolveTerminal,
    };
    this.deps.controllers.set(args.runId, ctrl);
    this.patchRun(args.runId, (current) => ({
      ...current,
      launch: { ...(current.launch ?? {}), linkedSessionId, binding: ctrl.binding },
    }));

    this.armHandshake(args.runId, ctrl);
    this.armDeadline(args.runId, ctrl);
    return ctrl;
  }

  /** The child must confirm the link inside the existing provisioning window (start or rehydration). */
  private armHandshake(runId: string, ctrl: ExecutionRunSessionController): void {
    ctrl.handshakeTimer = setTimeout(() => {
      if (ctrl.linked) return;
      void this.fail(runId, EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBLE_CHILD_UNRESPONSIVE, 'The linked child Session never confirmed the run link');
    }, this.deps.handshakeTimeoutMs);
    ctrl.handshakeTimer.unref?.();
  }

  /**
   * A few transcript re-reads at fixed offsets after the latest accepted wake-up, then none: a lost
   * report is recovered without the optional deadline, and nothing polls.
   */
  private armRecoveryReReads(runId: string, ctrl: ExecutionRunSessionController): void {
    if (ctrl.recoveryTimer) clearTimeout(ctrl.recoveryTimer);
    ctrl.recoveryTimer = null;
    const anchorMs = this.deps.getNowMs();
    const offsets = this.deps.recoveryReReadDelaysMs;
    const schedule = (index: number) => {
      const offsetMs = offsets[index];
      if (offsetMs === undefined) {
        ctrl.recoveryTimer = null;
        return;
      }
      ctrl.recoveryTimer = setTimeout(() => {
        schedule(index + 1);
        void this.evaluate(runId, { atDeadline: false, recoveryReRead: true });
      }, Math.max(0, anchorMs + offsetMs - this.deps.getNowMs()));
      ctrl.recoveryTimer.unref?.();
    };
    schedule(0);
  }

  /** One re-read of the child's transcript at the task deadline (start or rehydration). */
  private armDeadline(runId: string, ctrl: ExecutionRunSessionController): void {
    if (ctrl.deadlineAtMs === null) return;
    ctrl.deadlineTimer = setTimeout(() => {
      void this.evaluate(runId, { atDeadline: true });
    }, Math.max(0, ctrl.deadlineAtMs - this.deps.getNowMs()));
    ctrl.deadlineTimer.unref?.();
  }

  /**
   * A restarted parent runner reinstalls a running visible run from its marker and re-reads the
   * child's transcript forward from the task message; completion stays exactly-once.
   */
  rehydrate(args: Readonly<{
    runId: string;
    marker: Readonly<{
      linkedSessionId: string;
      binding: 'created' | 'reused';
      controls: VisibleRunControls;
      lastReportedTurnEpoch: number;
      deadlineAtMs: number | null;
      linked: boolean;
    }>;
  }>): void {
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const ctrl: ExecutionRunSessionController = {
      kind: 'session',
      linkedSessionId: args.marker.linkedSessionId,
      binding: args.marker.binding,
      controls: args.marker.controls,
      linked: args.marker.linked,
      lastReportedTurnEpoch: args.marker.lastReportedTurnEpoch,
      deadlineAtMs: args.marker.deadlineAtMs,
      observedChildReportEpoch: 0,
      lastTurnFailed: false,
      recoveryTimer: null,
      evaluatedTurnCount: 0,
      completion: null,
      pendingRepair: null,
      evaluationTail: Promise.resolve(),
      cancelled: false,
      handshakeTimer: null,
      deadlineTimer: null,
      lastMarkerWriteAtMs: 0,
      terminalPromise,
      resolveTerminal,
    };
    this.deps.controllers.set(args.runId, ctrl);
    // The marker now names this runner's process, so daemon GC treats the run as live again.
    this.deps.writeMarker(args.runId);
    // A child that never confirmed the link before the restart gets the handshake window again.
    if (!ctrl.linked) this.armHandshake(args.runId, ctrl);
    this.armDeadline(args.runId, ctrl);
    this.armRecoveryReReads(args.runId, ctrl);
    void this.evaluate(args.runId, { atDeadline: false });
  }

  /**
   * D18: a rehydrated run reads its task text and role back from the child Session, since the
   * marker keeps identifiers only. The role is the child's own assignment when it still matches.
   */
  async readRehydrationSource(args: Readonly<{
    runId: string;
    linkedSessionId: string;
    binding: 'created' | 'reused';
    role?: Readonly<{ id: ExecutionRunLaunchRoleV1['id']; assignmentId: string; roleSource: 'explicit' | 'settings' }>;
  }>): Promise<Readonly<{ taskText: string; role: ExecutionRunLaunchRoleV1 | null }>> {
    const isTaskMessage = taskMessageMatcher(args.runId, args.binding);
    const [messages, child] = await Promise.all([
      this.deps.port.readTranscript(args.linkedSessionId, isTaskMessage),
      this.deps.port.readChild(args.linkedSessionId),
    ]);
    const taskText = messages.find((message) => message.role === 'user' && isTaskMessage(message))?.text ?? '';
    if (!args.role) return { taskText, role: null };
    const assignment = readSessionRoleAssignmentV1(child?.metadata ?? null);
    const matches = assignment !== null && assignment.assignmentId === args.role.assignmentId;
    return {
      taskText,
      role: {
        id: args.role.id,
        name: resolveSessionRolePromptNameV1(matches ? assignment : { role: args.role.id }),
        assignmentId: args.role.assignmentId,
        instructions: matches ? assignment.instructions ?? '' : '',
        roleSource: args.role.roleSource,
      },
    };
  }

  /** `session.executionRun.childTurn.report.v1`: a wake-up only; the transcript is authoritative. */
  handleChildTurnReport(report: SessionExecutionRunChildTurnReportV1Request): SessionExecutionRunChildTurnReportV1Response {
    const run = this.deps.runs.get(report.runId);
    const ctrl = this.sessionController(report.runId);
    if (!run || !ctrl) return { ok: true, accepted: false, reason: 'unknown_run' };
    if (ctrl.linkedSessionId !== report.linkedSessionId) return { ok: true, accepted: false, reason: 'foreign_child' };
    if (run.status !== 'running' || ctrl.cancelled) return { ok: true, accepted: false, reason: 'run_terminal' };
    const wasLinked = ctrl.linked;
    this.markLinked(ctrl);
    if (report.kind === 'linked') {
      if (!wasLinked) this.deps.writeMarker(report.runId);
      this.armRecoveryReReads(report.runId, ctrl);
      return { ok: true, accepted: true };
    }
    if (report.turnEpoch <= ctrl.lastReportedTurnEpoch) return { ok: true, accepted: false, reason: 'stale_epoch' };
    ctrl.lastReportedTurnEpoch = report.turnEpoch;
    ctrl.lastTurnFailed = report.turnStatus === 'failed';
    this.deps.writeMarker(report.runId);
    this.armRecoveryReReads(report.runId, ctrl);
    void this.evaluate(report.runId, { atDeadline: false });
    return { ok: true, accepted: true };
  }

  private markLinked(ctrl: ExecutionRunSessionController): void {
    ctrl.linked = true;
    if (ctrl.handshakeTimer) {
      clearTimeout(ctrl.handshakeTimer);
      ctrl.handshakeTimer = null;
    }
  }

  private evaluate(runId: string, opts: EvaluateOptions): Promise<void> {
    const ctrl = this.sessionController(runId);
    if (!ctrl) return Promise.resolve();
    const next = ctrl.evaluationTail.then(() => this.evaluateNow(runId, ctrl, opts)).catch((error) => {
      logger.warn('[EXECUTION RUN] Visible run evaluation failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    ctrl.evaluationTail = next;
    return next;
  }

  private async evaluateNow(runId: string, ctrl: ExecutionRunSessionController, opts: EvaluateOptions): Promise<void> {
    const run = this.deps.runs.get(runId);
    if (!run || run.status !== 'running' || ctrl.cancelled) return;
    const isTaskMessage = taskMessageMatcher(runId, ctrl.binding);
    const messages = await this.deps.port.readTranscript(ctrl.linkedSessionId, isTaskMessage);
    const read = readVisibleRunTurnOutputs({ messages, isTaskMessage });
    const child = await this.deps.port.readChild(ctrl.linkedSessionId);
    const childLink = readExecutionRunLinkV1(child?.metadata);
    if (childLink?.runId === runId && childLink.report) {
      this.mirrorLinkState(runId, { report: childLink.report });
      ctrl.observedChildReportEpoch = Math.max(ctrl.observedChildReportEpoch, childLink.report.turnEpoch);
    }
    if (detectVisibleRunControlsChange({ controls: ctrl.controls, metadata: child?.metadata ?? null, userMessageMetas: read.userMessageMetas })) {
      await this.fail(runId, EXECUTION_RUN_VISIBLE_ERROR_CODES.CONTROLS_CHANGED, "The linked child's permission mode or model changed during the run");
      return;
    }
    if (!read.taskFound) {
      if (opts.atDeadline) await this.timeout(runId);
      return;
    }

    const profile = resolveExecutionRunIntentProfile(run.intent);
    const { role: _sessionRole, ...start } = buildExecutionRunProfileStartParams(run);
    const lastIndex = read.turns.length - 1;
    for (let index = ctrl.evaluatedTurnCount; index <= lastIndex; index += 1) {
      const turn = read.turns[index]!;
      ctrl.evaluatedTurnCount = index + 1;
      if (ctrl.pendingRepair) {
        const resolveRepair = ctrl.pendingRepair;
        ctrl.pendingRepair = null;
        resolveRepair(turn.finalText);
        return;
      }
      if (ctrl.completion) return;
      const finishedAtMs = this.deps.getNowMs();
      const direct = profile.onBoundedComplete({ start, rawText: turn.finalText, finishedAtMs });
      // An output the user already followed with another message is superseded, not repaired.
      if (direct.status !== 'succeeded' && index < lastIndex) continue;
      if (direct.status !== 'succeeded' && opts.atDeadline) break;
      // A failed child turn's partial output is not a result to repair.
      if (direct.status !== 'succeeded' && ctrl.lastTurnFailed) break;
      ctrl.completion = runBoundedCompletionWithRepair({
        profile,
        start,
        rawText: turn.finalText,
        finishedAtMs,
        runRepairTurn: async (repairPrompt) => await new Promise<string>((resolve) => {
          ctrl.pendingRepair = resolve;
          void this.deps.port.sendChildMessage(ctrl.linkedSessionId, { text: repairPrompt, requestedAction: { v: 1, kind: 'enqueue' } })
            .catch((error) => {
              logger.warn('[EXECUTION RUN] Visible run repair prompt was not delivered', {
                runId,
                error: error instanceof Error ? error.message : String(error),
              });
              void this.fail(runId, EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBLE_REPAIR_UNDELIVERED, 'The output-repair prompt could not be delivered to the linked child');
            });
        }),
      }).then(async ({ completion }) => {
        await this.complete(runId, completion);
      });
      return;
    }
    if (opts.atDeadline && !ctrl.completion) {
      await this.timeout(runId);
      return;
    }
    // A failed child turn with no result fails the run at a scheduled re-read, giving the child's own
    // usage-limit recovery time to arm; while that recovery is in progress the run waits for it.
    const awaitingResult = !ctrl.completion || ctrl.pendingRepair !== null;
    if (opts.recoveryReRead && ctrl.lastTurnFailed && awaitingResult && !isSessionUsageLimitRecoveryInProgressV1(child?.metadata ?? null)) {
      await this.fail(runId, EXECUTION_RUN_VISIBLE_ERROR_CODES.VISIBLE_CHILD_TURN_FAILED, 'A child turn failed without a valid result');
    }
  }

  private clearTimers(ctrl: ExecutionRunSessionController): void {
    if (ctrl.handshakeTimer) clearTimeout(ctrl.handshakeTimer);
    if (ctrl.deadlineTimer) clearTimeout(ctrl.deadlineTimer);
    if (ctrl.recoveryTimer) clearTimeout(ctrl.recoveryTimer);
    ctrl.handshakeTimer = null;
    ctrl.deadlineTimer = null;
    ctrl.recoveryTimer = null;
  }

  private settle(runId: string): ExecutionRunSessionController | null {
    const ctrl = this.sessionController(runId);
    const run = this.deps.runs.get(runId);
    if (!ctrl || !run || run.status !== 'running') return null;
    this.clearTimers(ctrl);
    ctrl.resolveTerminal();
    return ctrl;
  }

  private async complete(runId: string, completion: ExecutionRunProfileBoundedCompleteResult): Promise<void> {
    if (!this.settle(runId)) return;
    await this.deps.finishRun(
      runId,
      { status: completion.status, summary: completion.summary, finishedAtMs: this.deps.getNowMs() },
      { output: completion.toolResultOutput, meta: completion.toolResultMeta },
      completion.structuredMeta,
    );
  }

  private async fail(runId: string, code: string, message: string): Promise<void> {
    if (!this.settle(runId)) return;
    const finishedAtMs = this.deps.getNowMs();
    await this.deps.finishRun(
      runId,
      { status: 'failed', summary: message, finishedAtMs, error: { code, message } },
      { output: { status: 'failed', summary: message, runId, finishedAtMs, error: { code, message } }, isError: true },
    );
  }

  private async timeout(runId: string): Promise<void> {
    if (!this.settle(runId)) return;
    const finishedAtMs = this.deps.getNowMs();
    const message = 'The linked child did not produce a valid result before the run deadline';
    await this.deps.finishRun(
      runId,
      { status: 'timeout', summary: message, finishedAtMs, error: { code: 'execution_run_timeout', message } },
      { output: { status: 'timeout', summary: message, runId, finishedAtMs }, isError: true },
    );
  }

  /** `execution.run.send` on a running visible run: a message to the child, never a control override. */
  async send(runId: string, params: Readonly<{ message: string; delivery?: unknown }>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    const ctrl = this.sessionController(runId);
    const run = this.deps.runs.get(runId);
    if (!ctrl || !run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
    if (run.status !== 'running') {
      return { ok: false, errorCode: 'execution_run_not_allowed', error: 'The run is finished; start a new run bound to the same child' };
    }
    const delivery = typeof params.delivery === 'string' ? params.delivery : 'steer_if_supported';
    await this.deps.port.sendChildMessage(ctrl.linkedSessionId, {
      text: params.message,
      requestedAction: DELIVERY_TO_REQUESTED_ACTION[delivery] ?? DELIVERY_TO_REQUESTED_ACTION.steer_if_supported!,
    });
    return { ok: true };
  }

  /** `execution.run.stop`: the run is cancelled; the child Session stays open. */
  async stop(runId: string, reason?: string): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    const ctrl = this.sessionController(runId);
    if (!ctrl) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
    ctrl.cancelled = true;
    if (!this.settle(runId)) return { ok: true };
    const finishedAtMs = this.deps.getNowMs();
    const code = reason === EXECUTION_RUN_VISIBLE_ERROR_CODES.CHILD_ARCHIVED ? reason : 'execution_run_cancelled';
    await this.deps.finishRun(
      runId,
      { status: 'cancelled', summary: 'Cancelled', finishedAtMs, error: { code, message: 'Cancelled' } },
      { output: { status: 'cancelled', runId, finishedAtMs, error: { code } }, isError: true },
    );
    return { ok: true };
  }

  /** R21: registered before the completion relay is enqueued, so a bind that wins the race is kept. */
  expectRelayDelivery(runId: string, localId: string): void {
    this.pendingDeliveryByLocalId.set(localId, { runId, bound: false, verifying: false, rerun: false });
  }

  /** R21: the parent's relay outcome; a queued relay is queue acceptance, not delivery. */
  async recordRelayOutcome(runId: string, params: Readonly<{ localId: string; status: 'queued' | 'failed' }>): Promise<void> {
    const ctrl = this.sessionController(runId);
    if (!ctrl) return;
    // A run completed from a re-read carries the epoch of the child's own latest report record.
    const turnEpoch = Math.max(ctrl.lastReportedTurnEpoch, ctrl.observedChildReportEpoch);
    const relay = { turnEpoch, status: params.status, localId: params.localId, at: this.deps.getNowMs() };
    this.mirrorLinkState(runId, { relay });
    const pending = this.pendingDeliveryByLocalId.get(params.localId);
    if (params.status === 'failed') this.pendingDeliveryByLocalId.delete(params.localId);
    await this.deps.port.updateChildMetadata(ctrl.linkedSessionId, (metadata) => applyExecutionRunLinkRelayV1(metadata, { runId, relay }))
      .catch((error) => logger.warn('[EXECUTION RUN] Relay record write failed', { runId, error: error instanceof Error ? error.message : String(error) }));
    if (params.status === 'queued' && pending?.bound) await this.verifyDelivery(params.localId, runId);
  }

  /**
   * R21: when this runner binds its own pending input to a turn, or observes the committed
   * transcript row for it, one read of its persisted transcript decides delivery. Only a row
   * carrying this run's completion input is a receipt.
   */
  async notifyParentInputBound(localIds: readonly string[]): Promise<void> {
    for (const localId of localIds) {
      const pending = this.pendingDeliveryByLocalId.get(localId);
      if (!pending) continue;
      if (!this.deps.runs.get(pending.runId)?.linkState?.relay) {
        // Bound before the relay outcome was recorded: verify once the relay record exists.
        pending.bound = true;
        continue;
      }
      await this.verifyDelivery(localId, pending.runId);
    }
  }

  /**
   * One read of this runner's persisted transcript decides delivery for one relayed completion.
   * The wait stays registered until a receipt row is found: a turn can bind its input before the
   * server commits the row, and the committed-row notification then verifies it.
   */
  private async verifyDelivery(localId: string, runId: string): Promise<void> {
    const pending = this.pendingDeliveryByLocalId.get(localId);
    if (pending?.verifying) {
      // The in-flight read may have started before this signal's row was committed.
      pending.rerun = true;
      return;
    }
    const ctrl = this.sessionController(runId);
    const relay = this.deps.runs.get(runId)?.linkState?.relay;
    if (!ctrl || !relay) {
      this.pendingDeliveryByLocalId.delete(localId);
      return;
    }
    if (pending) pending.verifying = true;
    const readReceiptRow = async () => {
      const messages = await this.deps.port.readTranscript(this.deps.hostSessionId, (message) => isCompletionInputForRun(message, runId));
      return messages.find((message) => isCompletionInputForRun(message, runId));
    };
    let row: VisibleRunTranscriptMessage | undefined;
    try {
      row = await readReceiptRow();
      // A signal that arrived during the read gets one more read when this one missed.
      while (!row && pending?.rerun) {
        pending.rerun = false;
        row = await readReceiptRow();
      }
    } finally {
      if (pending) {
        pending.verifying = false;
        pending.rerun = false;
      }
    }
    if (!row || typeof row.seq !== 'number') return;
    this.pendingDeliveryByLocalId.delete(localId);
    const delivery = { turnEpoch: relay.turnEpoch, status: 'verified' as const, localId, transcriptSeq: row.seq, verifiedAt: this.deps.getNowMs() };
    this.mirrorLinkState(runId, { delivery });
    await this.deps.port.updateChildMetadata(ctrl.linkedSessionId, (metadata) => applyExecutionRunLinkDeliveryV1(metadata, { runId, delivery }))
      .catch((error) => logger.warn('[EXECUTION RUN] Delivery record write failed', { runId, error: error instanceof Error ? error.message : String(error) }));
  }
}
