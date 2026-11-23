import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type { AcpProviderTurnSink, AcpProviderTurnSourceFactory } from '@/agent/acp/backend/turn/providerTurns';
import { asRecord, extractToolInput } from '@/agent/acp/updates/content';
import { isAcpToolCallTerminalStatus } from '@/agent/acp/updates/toolCalls/types';
import type { SessionUpdate } from '@/agent/acp/updates/types';
import { logger } from '@/ui/logger';

/** Quiet period after assistant output and a usage report with no blocking tool calls. */
const GENERATION_SETTLE_MS = 2_000;
/** Ends a continuation that has neither an awaited tool call nor Agy output for this long. */
const CONTINUATION_STALL_MS = 5 * 60_000;
const COMPLETED_CONTINUATION: AcpTurnOutcome = { kind: 'completed', stopReason: 'end_turn' };
/** Updates showing that Agy is still generating or running tools; session metadata updates are not progress. */
const GENERATION_PROGRESS_UPDATES = new Set([
  'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan',
]);

type ToolCallState = Readonly<{
  status: SessionUpdate['status'];
  isDaemon: boolean;
}>;
type ToolCalls = Map<string, ToolCallState>;

type Continuation = {
  readonly turnId: string;
  readonly sink: AcpProviderTurnSink;
  /** Every call the continuation started, so calls still running when it ends can resume Agy again. */
  readonly toolCalls: ToolCalls;
  /** A usage report can only start settlement after new assistant output. */
  sawAssistantOutput: boolean;
  /** The finish queued behind earlier deliveries; output that arrives before it runs cancels it. */
  pendingFinish: object | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
};

export type AgyBackgroundContinuationTiming = Readonly<{
  generationSettleMs?: number;
  stallMs?: number;
}>;

function toolCallIdOf(update: SessionUpdate): string | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null;
  return typeof update.toolCallId === 'string' && update.toolCallId.trim() ? update.toolCallId : null;
}

function recordToolCall(toolCalls: ToolCalls, toolCallId: string, update: SessionUpdate): void {
  const previous = toolCalls.get(toolCallId);
  if (isAcpToolCallTerminalStatus(previous?.status)) return;

  // ACP approval updates can carry just the status. A pending approval blocks even for a known daemon.
  const isDaemon = previous?.isDaemon === true
    || (update.kind === 'execute' && asRecord(extractToolInput(update))?.IsDaemon === true);
  toolCalls.set(toolCallId, { status: update.status ?? previous?.status, isDaemon });
}

function hasBlockingToolCall(toolCalls: ToolCalls): boolean {
  for (const { status, isDaemon } of toolCalls.values()) {
    if (isAcpToolCallTerminalStatus(status)) continue;
    if (status !== 'in_progress' || !isDaemon) return true;
  }
  return false;
}

function startTimer(delayMs: number, onElapsed: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onElapsed, delayMs);
  timer.unref?.();
  return timer;
}

/**
 * `agy acp` ends a prompt turn while a backgrounded command keeps its tool call open, then resumes the
 * conversation on its own once that command settles. ACP has no frame for the resumed work: Agy streams it on
 * the session. ACP supplies no stop reason for this work. Use a quiet period after assistant output
 * and context usage once all blocking tools have settled.
 */
export function createAgyBackgroundContinuationSource(
  timing: AgyBackgroundContinuationTiming = {},
): AcpProviderTurnSourceFactory {
  const generationSettleMs = timing.generationSettleMs ?? GENERATION_SETTLE_MS;
  const stallMs = timing.stallMs ?? CONTINUATION_STALL_MS;
  return async (host) => {
    const foregroundToolCalls: ToolCalls = new Map();
    const backgroundTasks = new Set<string>();
    // A settled task's update, and what follows it, while another turn or prompt RPC still owns the session.
    const unadmittedUpdates: SessionUpdate[] = [];
    let continuation: Continuation | null = null;
    let continuationCount = 0;
    let deliveryTail = Promise.resolve();
    let disposed = false;
    let failed = false;

    const isLive = () => !disposed && !failed && !host.signal.aborted;

    /** Register still-running tool calls as tasks whose settlement can resume Agy, then release every witness. */
    const retainBackgroundTasks = (toolCalls: ToolCalls) => {
      for (const [toolCallId, { status }] of toolCalls) {
        if (!isAcpToolCallTerminalStatus(status) && host.registerContinuation({ id: toolCallId, parentToolCallId: toolCallId })) {
          backgroundTasks.add(toolCallId);
        }
      }
      host.releaseToolCalls([...toolCalls.keys()]);
      toolCalls.clear();
    };

    const enqueue = (operation: () => Promise<void>) => {
      deliveryTail = deliveryTail.then(operation).catch((error: unknown) => {
        if (!isLive()) return;
        // A failed delivery leaves the host's continuation open; only retiring the connection releases it.
        failed = true;
        host.fail(error instanceof Error ? error : new Error('Cannot publish resumed Agy work'));
      });
    };

    const clearSettleTimer = (open: Continuation) => {
      if (open.settleTimer) clearTimeout(open.settleTimer);
      open.settleTimer = null;
    };

    const clearTimers = (open: Continuation) => {
      clearSettleTimer(open);
      if (open.stallTimer) clearTimeout(open.stallTimer);
      open.stallTimer = null;
    };

    const finish = (open: Continuation, outcome: AcpTurnOutcome, reason: string) => {
      if (continuation !== open || open.pendingFinish) return;
      clearTimers(open);
      const request = {};
      open.pendingFinish = request;
      enqueue(async () => {
        if (continuation !== open || open.pendingFinish !== request) return;
        continuation = null;
        if (!isLive()) return;
        logger.debug(`[AgyContinuation] Finished ${open.turnId}: ${reason}`);
        // Earlier deliveries have settled, so the host has witnessed every tool call the continuation started.
        retainBackgroundTasks(open.toolCalls);
        await open.sink.finish(outcome);
      });
    };

    const armSettleTimer = (open: Continuation) => {
      if (open.settleTimer || open.pendingFinish) return;
      open.settleTimer = startTimer(generationSettleMs, () => finish(open, COMPLETED_CONTINUATION, 'assistant output went quiet'));
    };

    const restartStallTimer = (open: Continuation) => {
      if (open.stallTimer) clearTimeout(open.stallTimer);
      const onStall = () => {
        if (hasBlockingToolCall(open.toolCalls)) {
          open.stallTimer = startTimer(stallMs, onStall);
          return;
        }
        logger.warn('[AgyContinuation] Agy stopped reporting progress; ending its continuation');
        finish(open, { kind: 'timed_out', capMs: stallMs }, 'stalled');
      };
      open.stallTimer = startTimer(stallMs, onStall);
    };

    const observeProgress = (open: Continuation, update: SessionUpdate, toolCallId: string | null) => {
      if (update.sessionUpdate === 'usage_update') {
        // Agy also reports usage before tool calls and when session configuration changes.
        if (open.sawAssistantOutput && !hasBlockingToolCall(open.toolCalls)) armSettleTimer(open);
        return;
      }
      // Progress that arrives before a queued finish runs belongs to the same continuation.
      open.pendingFinish = null;
      clearSettleTimer(open);
      if (toolCallId || update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'user_message_chunk') {
        open.sawAssistantOutput = false;
      } else if (update.sessionUpdate === 'agent_message_chunk') {
        open.sawAssistantOutput = true;
      }
      restartStallTimer(open);
    };

    const deliver = (open: Continuation, update: SessionUpdate) => {
      const toolCallId = toolCallIdOf(update);
      let delivered = update;
      if (toolCallId && backgroundTasks.has(toolCallId)) {
        if (isAcpToolCallTerminalStatus(update.status)) backgroundTasks.delete(toolCallId);
        // The foreground abandoned this call when its turn ended, so the settled task opens its own card.
        delivered = { ...update, toolCallId: `${open.turnId}:${toolCallId}` };
      } else if (toolCallId) {
        recordToolCall(open.toolCalls, toolCallId, update);
      }
      observeProgress(open, update, toolCallId);
      enqueue(() => open.sink.update(delivered));
    };

    const admitContinuation = () => {
      if (continuation || unadmittedUpdates.length === 0) return;
      const turnId = `agy-continuation-${continuationCount + 1}`;
      const sink = host.beginContinuation({ id: toolCallIdOf(unadmittedUpdates[0]!)!, turnId });
      if (!sink) return;
      continuationCount += 1;
      logger.debug(`[AgyContinuation] Agy resumed on its own as ${turnId}`);
      const open: Continuation = {
        turnId, sink, toolCalls: new Map(), sawAssistantOutput: false, pendingFinish: null, settleTimer: null, stallTimer: null,
      };
      continuation = open;
      for (const update of unadmittedUpdates.splice(0)) deliver(open, update);
    };

    /** Agy folds a task that settles during a prompt into that prompt's turn. */
    const trackForegroundToolCall = (update: SessionUpdate) => {
      const toolCallId = toolCallIdOf(update);
      if (!toolCallId) return;
      if (!backgroundTasks.has(toolCallId)) recordToolCall(foregroundToolCalls, toolCallId, update);
      else if (isAcpToolCallTerminalStatus(update.status)) backgroundTasks.delete(toolCallId);
    };

    /** A prompt that starts before buffered updates were admitted absorbs them, as Agy folds the resumed work into it. */
    const releaseUnadmittedUpdates = () => {
      if (unadmittedUpdates.length === 0) return;
      const released = unadmittedUpdates.splice(0);
      for (const update of released) trackForegroundToolCall(update);
      host.releaseClaimedUpdates(released);
    };

    const settleForegroundTurn = () => {
      if (foregroundToolCalls.size > 0) retainBackgroundTasks(foregroundToolCalls);
    };

    const observeForegroundUpdate = (update: SessionUpdate) => {
      releaseUnadmittedUpdates();
      trackForegroundToolCall(update);
    };

    return {
      async catchUp(input) {
        if (isLive() && input?.foregroundActive) {
          releaseUnadmittedUpdates();
        } else if (isLive()) {
          settleForegroundTurn();
          admitContinuation();
        }
        await deliveryTail;
      },
      claimLiveUpdate(update, { foregroundActive }) {
        if (!isLive()) return false;
        if (foregroundActive) {
          observeForegroundUpdate(update);
          return false;
        }
        settleForegroundTurn();
        if (continuation) {
          if (update.sessionUpdate !== 'usage_update' && !GENERATION_PROGRESS_UPDATES.has(update.sessionUpdate ?? '')) return false;
          deliver(continuation, update);
          return true;
        }
        const toolCallId = toolCallIdOf(update);
        const settlesTask = toolCallId !== null && backgroundTasks.has(toolCallId) && isAcpToolCallTerminalStatus(update.status);
        if (!settlesTask && unadmittedUpdates.length === 0) return false;
        unadmittedUpdates.push(update);
        admitContinuation();
        return true;
      },
      dispose() {
        disposed = true;
        if (continuation) clearTimers(continuation);
        continuation = null;
        unadmittedUpdates.length = 0;
        foregroundToolCalls.clear();
        backgroundTasks.clear();
      },
    };
  };
}
