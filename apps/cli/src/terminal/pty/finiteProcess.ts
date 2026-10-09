import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionOperationDomainRefV1 } from '@happier-dev/protocol';
import type { TerminalPtyCustody, TerminalPtySessionManager } from './sessions';

export type HostFiniteTerminalOperation = Pick<ActionExecutorContext,
  'actionRequestId' | 'operationAcceptance' | 'operationCancellation' | 'operationProgress' | 'operationOwnerUpdate'> & Readonly<{ signal: AbortSignal }>;
export type HostFiniteTerminalOutcome = Readonly<{
  kind: 'no_launch' | 'process_settled' | 'outcome_uncertain';
  result: ActionExecuteResult;
  terminalId?: string;
}>;

/** Shared finite launch/cancellation/output lifetime. Domain admission and
 * attachment projection remain with the calling machine or Project owner. */
export async function executeHostFiniteTerminalProcess(input: Readonly<{
  operation: HostFiniteTerminalOperation;
  terminalSessions: Pick<TerminalPtySessionManager, 'ensure' | 'waitForExit' | 'requestStop'>;
  requesterAccountId: string;
  terminalCustody?: TerminalPtyCustody;
  terminalKey: string;
  launch: Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; windowsVerbatimArguments?: boolean }>;
  signal?: AbortSignal;
  progress: Readonly<{ phase: string; label: string; current?: number; total?: number }>;
  failureCode: string;
  failureDetails?: Readonly<Record<string, unknown>>;
  attachment(observation: Readonly<{ terminalId: string; exitCode?: number }>): ActionOperationDomainRefV1;
}>): Promise<HostFiniteTerminalOutcome> {
  const signal = input.signal ?? input.operation.signal;
  const failure = (kind: HostFiniteTerminalOutcome['kind'], code: string, terminalId?: string, details?: unknown): HostFiniteTerminalOutcome => ({
    kind, result: { ok: false, errorCode: code, error: code, ...(details === undefined ? {} : { details }) }, ...(terminalId ? { terminalId } : {}),
  });
  if (signal.aborted) return failure('no_launch', 'cancelled');
  let terminal: ReturnType<TerminalPtySessionManager['ensure']>;
  try {
    terminal = input.terminalSessions.ensure({ terminalKey: input.terminalKey, cwd: input.launch.cwd,
      requesterAccountId: input.requesterAccountId, holdUntilExit: true,
      ...(input.terminalCustody ? { custody: input.terminalCustody } : {}),
      launchProcess: { file: input.launch.command, args: input.launch.args, env: input.launch.env,
        ...(input.launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) },
    });
  } catch { return failure('outcome_uncertain', 'outcome_uncertain'); }
  if (!terminal.ok) return failure('no_launch', terminal.errorCode);
  input.operation.operationOwnerUpdate?.update({ state: 'running', progress: input.progress,
    domainRef: input.attachment({ terminalId: terminal.terminalId }) });
  const stop = () => {
    input.operation.operationProgress?.update({ phase: 'stopping', label: 'Stopping command' });
    void input.terminalSessions.requestStop({ terminalId: terminal.terminalId }).then(observation => {
      if (observation.kind === 'unconfirmed' || observation.kind === 'unavailable') {
        input.operation.operationOwnerUpdate?.update({ observation: {
          kind: observation.kind === 'unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
          code: observation.kind === 'unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
        } });
      }
    }).catch(() => input.operation.operationOwnerUpdate?.update({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } }));
  };
  const cancellation = input.operation.operationCancellation;
  const unsubscribe = cancellation?.onRequest(stop);
  const onAbort = () => { if (!cancellation || !input.operation.signal.aborted) stop(); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) stop();
  let observation: Awaited<ReturnType<TerminalPtySessionManager['waitForExit']>>;
  try {
    // Stop is a request. Only this same terminal's physical settlement can
    // release the accepted operation; caller abort does not cancel this wait.
    observation = await input.terminalSessions.waitForExit({ terminalId: terminal.terminalId,
      onOutcomeUncertain: () => input.operation.operationOwnerUpdate?.update({ observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } }) });
  } catch { return failure('outcome_uncertain', signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain', terminal.terminalId); }
  finally { signal.removeEventListener('abort', onAbort); unsubscribe?.(); }
  if (observation.kind === 'unavailable') return failure('outcome_uncertain', signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain', terminal.terminalId);
  input.operation.operationOwnerUpdate?.update({ domainRef: input.attachment({ terminalId: terminal.terminalId,
    ...(observation.exit.exitCode !== null ? { exitCode: observation.exit.exitCode } : {}) }) });
  if (signal.aborted) return failure('process_settled', 'cancelled', terminal.terminalId);
  if (observation.exit.exitCode !== 0 || observation.exit.signal !== null && observation.exit.signal !== 0) {
    return failure('process_settled', input.failureCode, terminal.terminalId, { ...input.failureDetails, ...observation.exit });
  }
  return { kind: 'process_settled', terminalId: terminal.terminalId, result: { ok: true, result: { kind: 'success' } } };
}
