import { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { sessionExecutionRunGet } from '@/sync/ops/sessionExecutionRuns';

/** Execution custody retired locally without an acknowledgement of remote Stop. */
export class VoiceRunStopUnconfirmedError extends Error {
  readonly rpcErrorCode = 'target_unavailable';

  constructor(
    readonly rpcSessionId: string,
    readonly runId: string | null,
    cause: unknown,
  ) {
    super('Voice remote Stop is unconfirmed', { cause });
    this.name = 'VoiceRunStopUnconfirmedError';
  }
}

export async function reconcileUnavailableVoiceRunStop(input: Readonly<{
  accountLifetime: ServerAccountScopeLifetime;
  rpcSessionId: string;
  runId: string | null;
  signal?: AbortSignal;
}>): Promise<'gone' | 'unreachable'> {
  input.signal?.throwIfAborted();
  // Publisher presence (including active:false) cannot establish Run finality.
  // Only the execution owner's exact Run observation can release custody.
  if (!input.runId) return 'unreachable';

  const observed = await sessionExecutionRunGet(input.rpcSessionId, {
    runId: input.runId, includeStructured: false,
  }, { scope: input.accountLifetime.scope, signal: input.signal }).catch(() => null);
  input.signal?.throwIfAborted();
  if (observed && 'run' in observed && observed.run.runId === input.runId
    && isExecutionRunTerminalStatus(observed.run.status)) return 'gone';
  if (observed && 'errorCode' in observed && observed.errorCode === 'execution_run_not_found') return 'gone';
  return 'unreachable';
}
