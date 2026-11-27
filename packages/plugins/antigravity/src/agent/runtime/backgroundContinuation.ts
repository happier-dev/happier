import { isNewerVersion, readNonBlankOpaqueIdentifier } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentAcpCompletionEvidenceOutcome,
  AgentAcpProviderTurnSink,
  AgentAcpProviderTurnSourceFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

type Update = Readonly<Record<string, unknown>>;
type ToolState = Readonly<{ status: unknown; kind: unknown; canDetach: boolean }>;
type ToolCalls = Map<string, ToolState>;

type Continuation = {
  sink: AgentAcpProviderTurnSink;
  tools: ToolCalls;
  sawAssistantOutput: boolean;
  pendingFinish: object | null;
  settle?: ReturnType<typeof setTimeout>;
  stall?: ReturnType<typeof setTimeout>;
};

const progressUpdates = new Set<unknown>([
  'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'user_message_chunk',
]);
const isTerminal = (status: unknown) => status === 'completed' || status === 'failed' || status === 'cancelled';
const toolId = (update: Update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
  ? readNonBlankOpaqueIdentifier(update.toolCallId) : null;

function observeCall(tools: ToolCalls, id: string, update: Update, legacyWaitCanDetach: boolean): void {
  const previous = tools.get(id);
  if (isTerminal(previous?.status)) return;
  const kind = update.kind ?? previous?.kind;
  const raw = update.rawInput;
  const input = kind === 'execute' && raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;
  const wait = input?.WaitMsBeforeAsync;
  const canDetach = previous?.canDetach === true || input?.IsDaemon === true
    || (legacyWaitCanDetach && typeof wait === 'number' && Number.isFinite(wait) && wait >= 0);
  tools.set(id, { status: update.status ?? previous?.status, kind, canDetach });
}

function hasBlockingCalls(tools: ToolCalls): boolean {
  for (const { status, canDetach } of tools.values()) {
    if (!isTerminal(status) && (status !== 'in_progress' || !canDetach)) return true;
  }
  return false;
}

function timer(ms: number, callback: () => void): ReturnType<typeof setTimeout> {
  const scheduled = setTimeout(callback, ms);
  scheduled.unref?.();
  return scheduled;
}

/** Agy resumes generation on the same connection after a background command finishes. ACP supplies no terminal frame for it. */
export function createAntigravityBackgroundContinuation(
  { settleMs = 2_000, stallMs = 5 * 60_000 } = {},
): AgentAcpProviderTurnSourceFactory {
  return async host => {
    const legacyWaitCanDetach = isNewerVersion(host.agentVersion?.split(/[-+]/u, 1)[0] ?? null, '1.5.15');
    const foreground: ToolCalls = new Map();
    const background = new Set<string>();
    const pendingWitnesses = new Map<string, boolean>();
    const pending: Update[] = [];
    let observedBackground = false;
    let open: Continuation | null = null;
    let sequence = 0;
    let delivery = Promise.resolve();
    let stopped = false;

    const current = () => !stopped && !host.signal.aborted;
    const enqueue = (work: () => Promise<void>) => {
      delivery = delivery.then(async () => { if (current()) await work(); }).catch(error => {
        if (!current()) return;
        stopped = true;
        host.fail(error instanceof Error ? error : new Error('Cannot deliver Antigravity continuation'));
      });
    };

    function stageWitnesses(tools: ToolCalls, finished: boolean): readonly string[] {
      const retain: string[] = [];
      for (const [id, { status }] of tools) {
        const keep = finished && status === 'in_progress';
        pendingWitnesses.set(id, keep);
        if (keep) {
          background.add(id);
          retain.push(id);
          observedBackground = true;
        }
      }
      tools.clear();
      return retain;
    }

    function registerWitnesses(): void {
      for (const [id, keep] of pendingWitnesses) {
        if (keep && !host.registerContinuation({ id, parentToolCallId: id })) {
          throw new Error('Antigravity continuation lost its originating tool call');
        }
      }
      host.releaseToolCalls([...pendingWitnesses.keys()]);
      pendingWitnesses.clear();
    }

    function finish(turn: Continuation, outcome: AgentAcpCompletionEvidenceOutcome): void {
      if (open !== turn || turn.pendingFinish) return;
      clearTimeout(turn.settle);
      clearTimeout(turn.stall);
      turn.settle = undefined;
      turn.stall = undefined;
      const finishRequest = {};
      turn.pendingFinish = finishRequest;
      enqueue(async () => {
        if (open !== turn || turn.pendingFinish !== finishRequest) return;
        open = null;
        const retainToolCallIds = stageWitnesses(turn.tools, outcome.kind === 'completed');
        registerWitnesses();
        await turn.sink.finish(outcome, { retainToolCallIds });
      });
    }

    function armStall(turn: Continuation): void {
      clearTimeout(turn.stall);
      turn.stall = timer(stallMs, () => {
        if (hasBlockingCalls(turn.tools)) armStall(turn);
        else finish(turn, { kind: 'failed', message: 'Antigravity continuation stopped reporting progress' });
      });
    }

    function deliver(turn: Continuation, update: Update): void {
      const id = toolId(update);
      if (id && background.has(id)) {
        if (isTerminal(update.status)) background.delete(id);
      } else if (id) {
        observeCall(turn.tools, id, update, legacyWaitCanDetach);
      }
      if (update.sessionUpdate === 'usage_update') {
        if (turn.sawAssistantOutput && !hasBlockingCalls(turn.tools) && !turn.settle && !turn.pendingFinish) {
          turn.settle = timer(settleMs, () => finish(turn, { kind: 'completed' }));
        }
      } else {
        turn.pendingFinish = null;
        clearTimeout(turn.settle);
        turn.settle = undefined;
        if (id || update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'user_message_chunk') {
          turn.sawAssistantOutput = false;
        } else if (update.sessionUpdate === 'agent_message_chunk') {
          turn.sawAssistantOutput = true;
        }
        armStall(turn);
      }
      // Agy may mirror a native user chunk. Use it only as progress evidence.
      if (update.sessionUpdate !== 'user_message_chunk') enqueue(() => turn.sink.update(update));
    }

    function admit(): void {
      if (open || !pending.length || pendingWitnesses.size > 0) return;
      const id = toolId(pending[0]);
      const sink = host.beginContinuation({
        ...(id && background.has(id) ? { id } : {}),
        turnId: `antigravity-continuation-${sequence + 1}`,
      });
      if (!sink) return;
      sequence += 1;
      open = { sink, tools: new Map(), sawAssistantOutput: false, pendingFinish: null };
      for (const update of pending.splice(0)) deliver(open, update);
    }

    function observeForeground(update: Update): void {
      const id = toolId(update);
      if (!id) return;
      if (background.has(id)) {
        if (isTerminal(update.status)) background.delete(id);
      } else {
        observeCall(foreground, id, update, legacyWaitCanDetach);
      }
    }

    async function releaseToForeground(): Promise<void> {
      if (!pending.length) return;
      const updates = pending.splice(0);
      for (const update of updates) observeForeground(update);
      await host.releaseClaimedUpdates(updates);
    }

    return {
      async catchUp(input) {
        if (!current()) return;
        try {
          registerWitnesses();
          if (input?.foregroundActive) await releaseToForeground();
          else admit();
        } catch (error) {
          stopped = true;
          host.fail(error instanceof Error ? error : new Error('Cannot admit Antigravity continuation'));
          return;
        }
        await delivery;
      },
      claimLiveUpdate(update, { foregroundActive }) {
        if (!current()) return false;
        if (foregroundActive) {
          const release = pending.length ? releaseToForeground() : null;
          observeForeground(update);
          return release ? release.then(() => false) : false;
        }
        const kind = update.sessionUpdate;
        if (kind !== 'usage_update' && !progressUpdates.has(kind)) return false;
        if (open) {
          deliver(open, update);
          return true;
        }
        const id = toolId(update);
        const settlesBackground = id !== null && background.has(id) && isTerminal(update.status);
        const beginsWork = observedBackground
          && (kind === 'tool_call' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk');
        if (!settlesBackground && !beginsWork && !pending.length) return false;
        pending.push(update);
        admit();
        return true;
      },
      hasUnattributedWork: () => observedBackground,
      onForegroundTurnFinished: outcome => stageWitnesses(foreground, outcome.kind === 'completed'),
      dispose() {
        stopped = true;
        if (open) {
          clearTimeout(open.settle);
          clearTimeout(open.stall);
        }
        open = null;
        foreground.clear();
        background.clear();
        pendingWitnesses.clear();
        pending.length = 0;
      },
    };
  };
}
