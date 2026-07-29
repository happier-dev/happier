import type { AgentMessageHandler } from '@/agent/core/AgentMessage';
import type { StartSessionResult } from '@/agent/core/AgentTypes';
import type {
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunSessionProvisionOptions,
  ExecutionRunSessionProvisionResult,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { AcpPromptSubmissionResult } from '@/agent/acp/runtime/acpRuntimeBackendContract';

type AcpExecutionRunResumeCapable = Readonly<{
  loadSession?: ((sessionId: string) => Promise<StartSessionResult>) | undefined;
  loadSessionWithReplayCapture?: ((sessionId: string) => Promise<StartSessionResult & { replay: unknown[] }>) | undefined;
}>;

type AcpExecutionRunSessionStarter = AcpExecutionRunResumeCapable & Readonly<{
  startSession: () => Promise<StartSessionResult>;
  sendPrompt: (sessionId: string, prompt: string) => Promise<AcpPromptSubmissionResult>;
}>;

type AcpExecutionRunMessageEmitter = Readonly<{
  onMessage: (handler: AgentMessageHandler) => void;
  offMessage?: ((handler: AgentMessageHandler) => void) | undefined;
}>;

export async function provisionAcpBackendExecutionRunSession(
  backend: AcpExecutionRunSessionStarter,
  opts?: ExecutionRunSessionProvisionOptions,
): Promise<ExecutionRunSessionProvisionResult> {
  if (opts?.resumeSessionId) {
    const loaded = opts.captureReplay === true
      ? await backend.loadSessionWithReplayCapture?.(opts.resumeSessionId)
      : await backend.loadSession?.(opts.resumeSessionId);
    if (!loaded) {
      throw new Error('ACP backend does not support resume');
    }
    return { sessionId: loaded.sessionId };
  }

  const started = await backend.startSession();
  if (opts?.initialPrompt !== undefined) {
    const submissionResult = await backend.sendPrompt(started.sessionId, opts.initialPrompt);
    if (
      submissionResult.kind === 'rejected_before_effect'
      || submissionResult.kind === 'effect_may_have_occurred'
    ) {
      throw submissionResult.error;
    }
  }
  return { sessionId: started.sessionId };
}

export function readAcpBackendExecutionRunResumeSupport(
  backend: AcpExecutionRunResumeCapable,
  opts?: Readonly<{ captureReplay?: boolean }>,
): boolean {
  return opts?.captureReplay === true
    ? typeof backend.loadSessionWithReplayCapture === 'function'
    : typeof backend.loadSession === 'function';
}

export function subscribeAcpBackendExecutionRunMessages(
  backend: AcpExecutionRunMessageEmitter,
  handler: ExecutionRunHostRuntimeMessageHandler,
): () => void {
  const wrapped: AgentMessageHandler = (message) => {
    handler(message);
  };
  backend.onMessage(wrapped);
  return () => {
    backend.offMessage?.(wrapped);
  };
}
