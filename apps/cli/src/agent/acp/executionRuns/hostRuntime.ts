import type { AgentMessageHandler, StartSessionResult } from '@/agent/core/AgentBackend';
import type {
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunSessionProvisionOptions,
  ExecutionRunSessionProvisionResult,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

type AcpExecutionRunResumeCapable = Readonly<{
  loadSession?: ((sessionId: string) => Promise<StartSessionResult>) | undefined;
  loadSessionWithReplayCapture?: ((sessionId: string) => Promise<StartSessionResult & { replay: unknown[] }>) | undefined;
}>;

type AcpExecutionRunSessionStarter = AcpExecutionRunResumeCapable & Readonly<{
  startSession: (initialPrompt?: string) => Promise<StartSessionResult>;
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

  const started = await backend.startSession(opts?.initialPrompt);
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
