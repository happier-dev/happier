import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';

export function buildExecutionRunProfileStartParams(run: ExecutionRunState): ExecutionRunProfileStartParams {
  return {
    sessionId: run.sessionId,
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    intent: run.intent,
    backendId: run.backendId,
    backendTarget: run.backendTarget,
    instructions: run.instructions,
    intentInput: run.intentInput,
    permissionMode: run.permissionMode,
    retentionPolicy: run.retentionPolicy,
    runClass: run.runClass,
    ioMode: run.ioMode,
    startedAtMs: run.startedAtMs,
  };
}
