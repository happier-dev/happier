import type { AgentSessionCompactRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { CodexAppServerEventInput } from './core.js';

type CompactionEvent = Extract<CodexAppServerEventInput, { kind: 'context-compaction' }>;

/** Native item identity belongs to the existing pending operation, never to a foreground turn. */
export function createCodexCompactionOperation(
  request: AgentSessionCompactRequest,
  publish: (event: CompactionEvent) => void,
) {
  let nativeItemId: string | null = null;
  let phase: CompactionEvent['phase'] | null = null;
  const finish = (terminal: 'completed' | 'failed' | 'cancelled'): void => {
    if (phase === 'completed' || phase === 'failed' || phase === 'cancelled') return;
    phase = terminal;
    const event = { kind: 'context-compaction' as const, compactionId: request.compactionId, trigger: request.trigger };
    if (terminal === 'failed') publish({ ...event, phase: terminal,
      diagnostic: { code: 'codex_compaction_failed', severity: 'error' } });
    else publish({ ...event, phase: terminal });
  };
  return {
    get phase() { return phase; },
    finish,
    observeItem(itemId: string, completed: boolean): void {
      if (nativeItemId !== null && nativeItemId !== itemId) return;
      nativeItemId = itemId;
      if (completed) finish('completed');
      else if (phase === null) {
        phase = 'started';
        publish({ kind: 'context-compaction', compactionId: request.compactionId, trigger: request.trigger, phase });
      }
    },
  };
}

export type CodexCompactionOperation = ReturnType<typeof createCodexCompactionOperation>;
