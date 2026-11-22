import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type { AcpProviderTurnSink, AcpProviderTurnSourceFactory } from '@/agent/acp/backend/turn/providerTurns';
import type { SessionUpdate } from '@/agent/acp/updates/types';
import { logger } from '@/ui/logger';

/** Agy reports usage when a model generation ends and streams that generation's tool calls within milliseconds. */
const GENERATION_SETTLE_MS = 2_000;
/** Ends a continuation that has neither an awaited tool call nor Agy output for this long. */
const CONTINUATION_STALL_MS = 5 * 60_000;
const COMPLETED_CONTINUATION: AcpTurnOutcome = { kind: 'completed', stopReason: 'end_turn' };
/** Updates showing that Agy is still generating or running tools; session metadata updates are not progress. */
const GENERATION_PROGRESS_UPDATES = new Set([
  'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan',
]);

/** Tool call id to whether the call has reached a terminal status. */
type ToolCallTerminality = Map<string, boolean>;

type Continuation = {
  readonly turnId: string;
  readonly sink: AcpProviderTurnSink;
  /** Every call the continuation started, so calls still running when it ends can resume Agy again. */
  readonly toolCalls: ToolCallTerminality;
  /** Running calls started since Agy's latest generation; Agy waits for them or moves them to the background. */
  readonly awaitedToolCalls: Set<string>;
  /** The finish queued behind earlier deliveries; output that arrives before it runs cancels it. */
  pendingFinish: object | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
};

export type AgyBackgroundContinuationTiming = Readonly<{
  generationSettleMs?: number;
  stallMs?: number;
}>;

function isTerminalToolStatus(status: unknown): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function toolCallIdOf(update: SessionUpdate): string | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null;
  return typeof update.toolCallId === 'string' && update.toolCallId.trim() ? update.toolCallId : null;
}

function recordToolCall(toolCalls: ToolCallTerminality, toolCallId: string, update: SessionUpdate): void {
  toolCalls.set(toolCallId, toolCalls.get(toolCallId) === true || isTerminalToolStatus(update.status));
}

function startTimer(delayMs: number, onElapsed: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onElapsed, delayMs);
  timer.unref?.();
  return timer;
}

/**
 * `agy acp` ends a prompt turn while a backgrounded command keeps its tool call open, then resumes the
 * conversation on its own once that command settles. ACP has no frame for the resumed work: Agy streams it on
 * the session, and a usage report that no further output follows is the only sign that it ended.
 */
export function createAgyBackgroundContinuationSource(
  timing: AgyBackgroundContinuationTiming = {},
): AcpProviderTurnSourceFactory {
  const generationSettleMs = timing.generationSettleMs ?? GENERATION_SETTLE_MS;
  const stallMs = timing.stallMs ?? CONTINUATION_STALL_MS;
  return async (host) => {
    const foregroundToolCalls: ToolCallTerminality = new Map();
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
    const retainBackgroundTasks = (toolCalls: ToolCallTerminality) => {
      for (const [toolCallId, terminal] of toolCalls) {
        if (!terminal && host.registerContinuation({ id: toolCallId, parentToolCallId: toolCallId })) {
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

    const finish = (open: Continuation, reason: string) => {
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
        await open.sink.finish(COMPLETED_CONTINUATION);
      });
    };

    const armSettleTimer = (open: Continuation) => {
      clearSettleTimer(open);
      open.settleTimer = startTimer(generationSettleMs, () => finish(open, 'no output followed the last generation'));
    };

    const restartStallTimer = (open: Continuation) => {
      if (open.stallTimer) clearTimeout(open.stallTimer);
      const onStall = () => {
        if (open.awaitedToolCalls.size > 0) {
          open.stallTimer = startTimer(stallMs, onStall);
          return;
        }
        logger.warn('[AgyContinuation] Agy stopped reporting progress; ending its continuation');
        finish(open, 'stalled');
      };
      open.stallTimer = startTimer(stallMs, onStall);
    };

    /** Output that arrives before a queued finish runs belongs to the same continuation. */
    const reopen = (open: Continuation) => {
      if (!open.pendingFinish) return;
      open.pendingFinish = null;
      // The queued finish already found Agy quiet, so only further generation progress extends the continuation.
      armSettleTimer(open);
    };

    const observeProgress = (open: Continuation, update: SessionUpdate) => {
      if (update.sessionUpdate === 'usage_update') {
        // Agy generates again only once the calls it started have finished or moved to the background.
        open.awaitedToolCalls.clear();
        armSettleTimer(open);
      } else if (GENERATION_PROGRESS_UPDATES.has(update.sessionUpdate ?? '')) {
        clearSettleTimer(open);
      }
      restartStallTimer(open);
    };

    const deliver = (open: Continuation, update: SessionUpdate) => {
      const toolCallId = toolCallIdOf(update);
      let delivered = update;
      if (toolCallId && backgroundTasks.has(toolCallId)) {
        if (isTerminalToolStatus(update.status)) backgroundTasks.delete(toolCallId);
        // The foreground abandoned this call when its turn ended, so the settled task opens its own card.
        delivered = { ...update, toolCallId: `${open.turnId}:${toolCallId}` };
      } else if (toolCallId) {
        recordToolCall(open.toolCalls, toolCallId, update);
        if (open.toolCalls.get(toolCallId)) open.awaitedToolCalls.delete(toolCallId);
        else open.awaitedToolCalls.add(toolCallId);
      }
      observeProgress(open, update);
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
        turnId, sink, toolCalls: new Map(), awaitedToolCalls: new Set(), pendingFinish: null, settleTimer: null, stallTimer: null,
      };
      continuation = open;
      for (const update of unadmittedUpdates.splice(0)) deliver(open, update);
    };

    /** A prompt that starts before buffered updates were admitted absorbs them, as Agy folds the resumed work into it. */
    const releaseUnadmittedUpdates = () => {
      if (unadmittedUpdates.length === 0) return;
      const released = unadmittedUpdates.splice(0);
      for (const update of released) {
        const taskId = toolCallIdOf(update);
        if (taskId && isTerminalToolStatus(update.status)) backgroundTasks.delete(taskId);
      }
      host.releaseClaimedUpdates(released);
    };

    const settleForegroundTurn = () => {
      if (foregroundToolCalls.size > 0) retainBackgroundTasks(foregroundToolCalls);
    };

    /** Agy folds a task that settles during a prompt into that prompt's turn. */
    const observeForegroundUpdate = (update: SessionUpdate) => {
      releaseUnadmittedUpdates();
      const toolCallId = toolCallIdOf(update);
      if (!toolCallId) return;
      if (!backgroundTasks.has(toolCallId)) recordToolCall(foregroundToolCalls, toolCallId, update);
      else if (isTerminalToolStatus(update.status)) backgroundTasks.delete(toolCallId);
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
          reopen(continuation);
          deliver(continuation, update);
          return true;
        }
        const toolCallId = toolCallIdOf(update);
        const settlesTask = toolCallId !== null && backgroundTasks.has(toolCallId) && isTerminalToolStatus(update.status);
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
