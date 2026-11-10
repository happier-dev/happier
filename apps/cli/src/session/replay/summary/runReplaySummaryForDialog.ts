import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { EphemeralExecutionRunTextPromptStartAction } from '@/agent/runtime/bridges/executionRun/runtime/textPrompt';

import { runLlmTaskTextPrompt } from '@/agent/executionRuns/tasks/textPromptWithRunnerConfig';
import type { LlmTaskRunnerMachineCandidates } from '@/agent/executionRuns/tasks/llmTaskRunner';

import type { HappierReplayDialogItem } from '../types';

function buildReplaySummaryPrompt(params: Readonly<{
  parentSessionId: string;
  dialog: readonly HappierReplayDialogItem[];
}>): string {
  const lines: string[] = [];
  lines.push('Generate a concise, information-dense summary of the conversation so far.');
  lines.push('This summary will be used to resume/fork a session when vendor resume is unavailable.');
  lines.push('Return plain text only (no markdown code fences).');
  lines.push('Preserve exact identifiers, codes, names, numbers, paths, and user constraints when they matter.');
  lines.push('Do not drop older facts just because later turns are shorter or more repetitive.');
  lines.push('');
  lines.push('Use this exact template:');
  lines.push('---');
  lines.push('## Goal');
  lines.push('[What is the user trying to accomplish?]');
  lines.push('');
  lines.push('## Instructions');
  lines.push('- [Important constraints/instructions from the user]');
  lines.push('');
  lines.push('## Discoveries');
  lines.push('[Important facts learned; decisions made; key context that must persist]');
  lines.push('');
  lines.push('## Accomplished');
  lines.push('[What has been completed; what is in progress; what remains]');
  lines.push('');
  lines.push('## Relevant files / directories');
  lines.push('- [Paths that matter; include brief purpose if known]');
  lines.push('');
  lines.push('## Open questions / Next steps');
  lines.push('- [What needs clarification, and what should happen next]');
  lines.push('---');
  lines.push('');
  lines.push(`Previous session id: ${params.parentSessionId}`);
  lines.push('');
  lines.push('Conversation:');
  for (const item of params.dialog) {
    const role = item.role === 'Assistant' ? 'Assistant' : 'User';
    lines.push(`${role}: ${item.text}`);
  }
  lines.push('');
  lines.push('Summary:');
  return lines.join('\n');
}

/**
 * Summarizes a Replay dialog. The person's choice (Auto or one runner) goes to
 * the background-task runner owner; nothing ready ⇒ LlmTaskRunnerUnavailableError.
 */
export async function runReplaySummaryForDialog(params: Readonly<{
  parentSessionId: string;
  choice: LlmTaskRunnerChoiceV1 | null | undefined;
  /** The parent Session's own Agent: it wins Auto's cost ties. */
  sessionAgentTargetKey?: string | null;
  dialog: readonly HappierReplayDialogItem[];
  deps?: Readonly<{
    executeStart?: EphemeralExecutionRunTextPromptStartAction;
    readCandidates?: () => Promise<LlmTaskRunnerMachineCandidates>;
  }>;
}>): Promise<string> {
  const out = await runLlmTaskTextPrompt({
    task: 'session_replay_summary',
    choice: params.choice,
    sessionAgentTargetKey: params.sessionAgentTargetKey ?? null,
    sessionId: params.parentSessionId,
    // Replay summary is a generic bounded task; it does not own a separate
    // execution-run lifecycle or intent vocabulary.
    intent: 'task',
    prompt: buildReplaySummaryPrompt({ parentSessionId: params.parentSessionId, dialog: params.dialog }),
    ...(params.deps?.executeStart ? { executeStart: params.deps.executeStart } : {}),
    ...(params.deps?.readCandidates ? { readCandidates: params.deps.readCandidates } : {}),
  });
  return String(out ?? '').trim();
}
