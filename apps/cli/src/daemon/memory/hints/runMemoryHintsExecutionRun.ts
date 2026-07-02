import type { EphemeralExecutionRunTextPromptRuntimeFactory } from '@/agent/runtime/bridges/executionRun/runtime/textPrompt';
import { runEphemeralExecutionRunTextPromptWithRunnerConfig } from '@/agent/executionRuns/tasks/textPromptWithRunnerConfig';

export type MemoryHintsExecutionRunBackendFactory = EphemeralExecutionRunTextPromptRuntimeFactory;

export async function runMemoryHintsExecutionRun(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendId: string;
  modelId?: string;
  permissionMode: 'no_tools' | 'read_only';
  prompt: string;
  createBackend?: MemoryHintsExecutionRunBackendFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  return await runEphemeralExecutionRunTextPromptWithRunnerConfig({
    cwd: params.cwd,
    sessionId: params.sessionId,
    runner: {
      backendTarget: { kind: 'builtInAgent', agentId: params.backendId },
      modelId: params.modelId,
      permissionMode: params.permissionMode,
    },
    intent: 'memory_hints',
    prompt: params.prompt,
    createRuntime: params.createBackend,
    timeoutMs: params.timeoutMs,
  });
}
