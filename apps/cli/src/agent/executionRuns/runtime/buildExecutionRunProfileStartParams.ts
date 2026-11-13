import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunLaunchRoleV1, ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';

/** The prompt-facing part of a run's launch role. */
export function toExecutionRunProfileRole(role: ExecutionRunLaunchRoleV1): NonNullable<ExecutionRunProfileStartParams['role']> {
  return { id: role.id, name: role.name, instructions: role.instructions };
}

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
    ...(run.launch?.role ? { role: toExecutionRunProfileRole(run.launch.role) } : {}),
  };
}
