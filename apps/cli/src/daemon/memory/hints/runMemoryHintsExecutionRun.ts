import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

import type { StoredCredentials } from '@/persistence';
import type { runLlmTaskTextPrompt } from '@/agent/executionRuns/tasks/textPromptWithRunnerConfig';

/**
 * The memory worker owns prompt construction and result consumption. Execution
 * lifecycle stays with the canonical execution.run Action supplied here, and the
 * background-task runner owner decides which Agent, model and route run it.
 *
 * Hint Runs are background work: they start in the daemon-owned detached scope
 * so they never resume (wake) the hinted Session or spawn its runner. The
 * prompt carries the transcript text; `commitHint` writes the result to the
 * Session independently. Nothing ready throws `LlmTaskRunnerUnavailableError`,
 * which the hint pass treats as a failed Run and backs off.
 */
export type MemoryHintsExecutionRunTextPromptRunner = typeof runLlmTaskTextPrompt;

export async function runMemoryHintsExecutionRun(params: Readonly<{
  sessionId: string;
  choice: LlmTaskRunnerChoiceV1;
  /** The hinted Session's own Agent, which wins Auto's cost ties; null when unknown. */
  sessionAgentTargetKey: string | null;
  prompt: string;
  credentials?: StoredCredentials | null;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  runTextPrompt?: MemoryHintsExecutionRunTextPromptRunner;
}>): Promise<string> {
  const runTextPrompt = params.runTextPrompt ?? (await import(
    '@/agent/executionRuns/tasks/textPromptWithRunnerConfig'
  )).runLlmTaskTextPrompt;

  return await runTextPrompt({
    task: 'memory_hints',
    choice: params.choice,
    // Auto prefers the Session's own Agent on a cost tie.
    sessionAgentTargetKey: params.sessionAgentTargetKey,
    sessionId: null,
    intent: 'memory_hints',
    prompt: params.prompt,
    ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
