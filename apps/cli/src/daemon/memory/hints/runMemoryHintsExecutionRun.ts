import type { StoredCredentials } from '@/persistence';
import type { runEphemeralExecutionRunTextPromptWithRunnerConfig } from '@/agent/executionRuns/tasks/textPromptWithRunnerConfig';

/**
 * The memory worker owns prompt construction and result consumption. Execution
 * lifecycle stays with the canonical execution.run Action supplied here.
 */
export type MemoryHintsExecutionRunTextPromptRunner =
  typeof runEphemeralExecutionRunTextPromptWithRunnerConfig;

export async function runMemoryHintsExecutionRun(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendId: string;
  modelId?: string;
  permissionMode: 'no_tools' | 'read_only';
  prompt: string;
  credentials?: StoredCredentials | null;
  timeoutMs?: number | null;
  runTextPrompt?: MemoryHintsExecutionRunTextPromptRunner;
}>): Promise<string> {
  const runTextPrompt = params.runTextPrompt ?? (await import(
    '@/agent/executionRuns/tasks/textPromptWithRunnerConfig'
  )).runEphemeralExecutionRunTextPromptWithRunnerConfig;

  return await runTextPrompt({
    cwd: params.cwd,
    sessionId: params.sessionId,
    runner: {
      backendTarget: { kind: 'builtInAgent', agentId: params.backendId },
      ...(params.modelId ? { modelId: params.modelId } : {}),
      permissionMode: params.permissionMode,
    },
    intent: 'memory_hints',
    prompt: params.prompt,
    ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
    timeoutMs: params.timeoutMs,
  });
}
