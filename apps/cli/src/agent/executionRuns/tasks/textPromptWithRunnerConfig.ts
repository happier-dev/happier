import type { ExecutionRunIntent } from '@happier-dev/protocol';
import { convertBackendTargetRefV2ToV1, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { LlmTaskRunnerChoiceV1, LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { LlmTaskIdV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';

import {
  runEphemeralExecutionRunTextPrompt,
  type EphemeralExecutionRunTextPromptStartAction,
} from '@/agent/runtime/bridges/executionRun/runtime/textPrompt';
import type { StoredCredentials } from '@/persistence';

import { LlmTaskRunnerUnavailableError, resolveLlmTaskRunnerOnThisMachine, type LlmTaskRunnerMachineCandidates } from './llmTaskRunner';

type TextPromptRunParams = Readonly<{
  /** The hosting Session, or `null` for the daemon-owned detached scope. */
  sessionId: string | null;
  intent: ExecutionRunIntent;
  prompt: string;
  credentials?: StoredCredentials | null;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  executeStart?: EphemeralExecutionRunTextPromptStartAction;
}>;

/** Runs one bounded text prompt with an already resolved runner. */
export async function runEphemeralExecutionRunTextPromptWithRunnerConfig(params: TextPromptRunParams & Readonly<{
  runner: LlmTaskRunnerConfigV1;
}>): Promise<string> {
  const { runner } = params;
  const backendTarget = convertBackendTargetRefV2ToV1(readBackendTargetRefV2(parseBackendTargetKeyV2(runner.modelSelection.agentTargetKey)));
  return await runEphemeralExecutionRunTextPrompt({
    sessionId: params.sessionId,
    backendTarget,
    modelSelection: runner.modelSelection,
    ...(runner.connectedServices !== undefined ? { connectedServices: runner.connectedServices } : {}),
    ...(runner.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: runner.sessionConfigOptionOverrides } : {}),
    permissionMode: runner.permissionMode ?? 'no_tools',
    intent: params.intent,
    prompt: params.prompt,
    ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    timeoutMs: params.timeoutMs,
    ...(params.executeStart ? { executeStart: params.executeStart } : {}),
  });
}

/**
 * A background task's text prompt: the task names itself and the person's
 * choice; the runner owner decides what runs. Nothing ready ⇒ a typed failure.
 */
export async function runLlmTaskTextPrompt(params: TextPromptRunParams & Readonly<{
  task: LlmTaskIdV1;
  choice: LlmTaskRunnerChoiceV1 | null | undefined;
  sessionAgentTargetKey?: string | null;
  readCandidates?: () => Promise<LlmTaskRunnerMachineCandidates>;
}>): Promise<string> {
  const resolved = await resolveLlmTaskRunnerOnThisMachine({
    task: params.task,
    choice: params.choice,
    ...(params.sessionAgentTargetKey !== undefined ? { sessionAgentTargetKey: params.sessionAgentTargetKey } : {}),
    ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.readCandidates ? { readCandidates: params.readCandidates } : {}),
  });
  if (!resolved.ok) throw new LlmTaskRunnerUnavailableError(params.task, resolved.reason, resolved.unavailableAgents);
  return await runEphemeralExecutionRunTextPromptWithRunnerConfig({ ...params, runner: resolved.runner });
}
