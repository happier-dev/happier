import type { ExecutionRunIntentProfile, ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunState } from './executionRunTypes';
import { readScmAccountScope, runWithScmAccountScope } from '@/scm/accountScope';
import { runWithScmComparisonOperations } from '@/scm/comparisons/comparisonOperations';

export function buildExecutionRunProfileStartParams(run: ExecutionRunState): ExecutionRunProfileStartParams {
  return {
    ...(run.executionAuthorization ? { executionAuthorization: run.executionAuthorization } : {}),
    ...(run.scmComparisonOperations ? { scmComparisonOperations: run.scmComparisonOperations } : {}),
    ...(run.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: run.requesterWorkAttributionV1 } : {}),
    ...(run.workflowOriginSessionId ? { workflowOriginSessionId: run.workflowOriginSessionId } : {}),
    sessionId: run.sessionId,
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    intent: run.intent,
    backendId: run.backendId,
    backendTarget: run.backendTarget,
    ...(run.launch?.modelId !== undefined ? { modelId: run.launch.modelId } : {}),
    ...(run.launch?.modelSelection ? { modelSelection: run.launch.modelSelection } : {}),
    ...(run.launch?.connectedServicesSelection !== undefined ? { connectedServices: run.launch.connectedServicesSelection } : {}),
    instructions: run.instructions,
    intentInput: run.intentInput,
    permissionMode: run.permissionMode,
    retentionPolicy: run.retentionPolicy,
    runClass: run.runClass,
    ioMode: run.ioMode,
    startedAtMs: run.startedAtMs,
  };
}

/** Publication/recovery uses the retained Run's requester, including after restart. */
export function runWithScmExecutionRunAccountScope<T>(
  run: Pick<ExecutionRunProfileStartParams, 'requesterWorkAttributionV1' | 'scmComparisonOperations' | 'executionAuthorization'
    | 'workflowOriginSessionId'> | undefined,
  effect: () => T,
): T {
  const originSessionId = run?.workflowOriginSessionId;
  // A detached Workflow Run can read origin Session evidence only under its retained requester.
  const accountId = run?.requesterWorkAttributionV1?.accountId ?? (originSessionId ? undefined : readScmAccountScope());
  const execute = () => run?.scmComparisonOperations ? runWithScmComparisonOperations(run.scmComparisonOperations, effect) : effect();
  return accountId || originSessionId ? runWithScmAccountScope(accountId, execute, run?.executionAuthorization, originSessionId) : execute();
}

export function bindScmExecutionRunProfileAccountScope(profile: ExecutionRunIntentProfile): ExecutionRunIntentProfile {
  function bind<Params extends Readonly<{ start: ExecutionRunProfileStartParams }>, Result>(effect: (params: Params) => Result) {
    return (params: Params): Result => runWithScmExecutionRunAccountScope(params.start, () => effect(params));
  }
  return { ...profile,
    ...(profile.onStarted ? { onStarted: bind(profile.onStarted) } : {}),
    ...(profile.onBeforeRetainedInput ? { onBeforeRetainedInput: bind(profile.onBeforeRetainedInput) } : {}),
    ...(profile.onTurnComplete ? { onTurnComplete: bind(profile.onTurnComplete) } : {}),
    ...(profile.onTurnFailed ? { onTurnFailed: bind(profile.onTurnFailed) } : {}),
    ...(profile.onTerminal ? { onTerminal: bind(profile.onTerminal) } : {}),
  };
}
