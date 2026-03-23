import type { BackendTargetRefV1, LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

import { runEphemeralExecutionRunTextPromptWithRunnerConfig } from '@/agent/executionRuns/tasks/runEphemeralExecutionRunTextPromptWithRunnerConfig';

import type { HappierReplayDialogItem } from '../types';

export type ReplaySummaryTextPromptRunner = (params: Readonly<{
  cwd: string;
  sessionId: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  intent: string;
  prompt: string;
  timeoutMs?: number | null;
}>) => Promise<string>;

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

export async function runReplaySummaryForDialog(params: Readonly<{
  cwd: string;
  parentSessionId: string;
  runner: LlmTaskRunnerConfigV1;
  dialog: readonly HappierReplayDialogItem[];
  deps?: Readonly<{
    runTextPrompt?: ReplaySummaryTextPromptRunner;
  }>;
}>): Promise<string> {
  const backendTarget = params.runner?.backendTarget;
  if (!backendTarget) return '';
  const modelId = typeof params.runner.modelId === 'string' && params.runner.modelId.trim().length > 0 ? params.runner.modelId.trim() : undefined;
  const permissionMode =
    typeof params.runner.permissionMode === 'string' && params.runner.permissionMode.trim().length > 0
      ? params.runner.permissionMode.trim()
      : 'no_tools';

  const prompt = buildReplaySummaryPrompt({
    parentSessionId: params.parentSessionId,
    dialog: params.dialog,
  });

  const runTextPrompt = params.deps?.runTextPrompt ?? (async (p) => {
    return await runEphemeralExecutionRunTextPromptWithRunnerConfig({
      cwd: p.cwd,
      sessionId: p.sessionId,
      runner: { backendTarget: p.backendTarget, modelId: p.modelId, permissionMode: p.permissionMode },
      intent: p.intent,
      prompt: p.prompt,
    });
  });
  const out = await runTextPrompt({
    cwd: params.cwd,
    sessionId: params.parentSessionId,
    backendTarget,
    modelId,
    permissionMode,
    intent: 'replay_summary',
    prompt,
  });

  return String(out ?? '').trim();
}
