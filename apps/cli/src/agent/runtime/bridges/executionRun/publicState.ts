import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { projectExecutionRunRequestedConfiguration } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';

/** The same owner projection serves retained readers and live controller reads. */
export function projectExecutionRunPublicState(run: ExecutionRunState, controller: ExecutionRunController | null = null): ExecutionRunPublicState {
  const requestedConfiguration = projectExecutionRunRequestedConfiguration({
    modelId: run.launch?.modelSelection?.modelId ?? run.launch?.modelId,
    sessionConfigOptionOverrides: run.launch?.sessionConfigOptionOverrides,
  });
  return ExecutionRunPublicStateSchema.parse({
    runId: run.runId, callId: run.callId, sidechainId: run.sidechainId, intent: run.intent,
    backendTarget: run.backendTarget, ...(run.display ? { display: run.display } : {}),
    ...(run.launch?.launchOrigin ? { launchOrigin: run.launch.launchOrigin } : {}),
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
    permissionMode: run.permissionMode, retentionPolicy: run.retentionPolicy, runClass: run.runClass, ioMode: run.ioMode,
    status: run.status, lifecycle: resolveExecutionRunLifecycle(run, controller).projection,
    ...(run.inputTurns ? { inputTurns: run.inputTurns } : {}),
    ...(controller?.kind === 'backend' ? { turnInFlight: controller.turnInFlight } : {}),
    ...(controller?.kind === 'backend' && controller.backend.interaction ? { interaction: controller.backend.interaction } : {}),
    ...(run.voiceAgentConfig?.transcript ? { transcript: run.voiceAgentConfig.transcript } : {}),
    ...(run.voiceAgentConfig?.voicePolicy ? { voicePolicy: run.voiceAgentConfig.voicePolicy } : {}),
    startedAtMs: run.startedAtMs, ...(run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}),
    ...(run.finishedAtMs !== undefined ? { finishedAtMs: run.finishedAtMs } : {}), ...(run.error ? { error: run.error } : {}),
  });
}
