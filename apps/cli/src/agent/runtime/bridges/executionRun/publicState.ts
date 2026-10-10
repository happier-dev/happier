import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { projectExecutionRunRequestedConfiguration, projectExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';

/** The same owner projection serves retained readers and live controller reads. */
export function projectExecutionRunPublicState(
  run: ExecutionRunState,
  controller: ExecutionRunController | null = null,
  voiceTurnInFlight?: boolean,
): ExecutionRunPublicState {
  const turnInFlight = controller?.kind === 'backend'
    ? controller.runtimeId ? controller.turnInFlight : undefined
    : controller?.kind === 'voice_agent' ? voiceTurnInFlight : undefined;
  const requestedConfiguration = projectExecutionRunRequestedConfiguration({
    modelId: run.launch?.modelSelection?.modelId ?? run.launch?.modelId,
    sessionConfigOptionOverrides: run.launch?.sessionConfigOptionOverrides,
  });
  const resolvedSelection = projectExecutionRunResolvedSelection({
    source: run.launch?.selectionSource,
    modelId: run.launch?.modelId,
    modelSelection: run.launch?.modelSelection,
    teamCredentialModel: run.launch?.teamCredentialModel,
    connectedServices: run.launch?.connectedServicesSelection,
  });
  return ExecutionRunPublicStateSchema.parse({
    runId: run.runId, callId: run.callId, sidechainId: run.sidechainId, intent: run.intent,
    ...(run.originWorkflowRunId ? { originWorkflowRunId: run.originWorkflowRunId } : {}),
    backendTarget: run.backendTarget, ...(run.display ? { display: run.display } : {}),
    ...(run.launch?.launchOrigin ? { launchOrigin: run.launch.launchOrigin } : {}),
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
    ...(resolvedSelection ? { resolvedSelection } : {}),
    permissionMode: run.permissionMode, retentionPolicy: run.retentionPolicy, runClass: run.runClass, ioMode: run.ioMode,
    status: run.status, lifecycle: resolveExecutionRunLifecycle(run, controller).projection,
    ...(run.inputTurns ? { inputTurns: run.inputTurns } : {}),
    ...(typeof turnInFlight === 'boolean' ? { turnInFlight } : {}),
    ...(controller?.kind === 'backend' && controller.backend.interaction ? { interaction: controller.backend.interaction } : {}),
    ...(run.voiceAgentConfig?.transcript ? { transcript: run.voiceAgentConfig.transcript } : {}),
    ...(run.voiceAgentConfig?.voicePolicy ? { voicePolicy: run.voiceAgentConfig.voicePolicy } : {}),
    startedAtMs: run.startedAtMs, ...(run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}),
    ...(run.finishedAtMs !== undefined ? { finishedAtMs: run.finishedAtMs } : {}), ...(run.error ? { error: run.error } : {}),
  });
}
