import { runLlmTaskInWorkspace, readLlmTaskRun, stopLlmTaskRun, type LlmTaskHostV1, type LlmTaskRunResult } from '@/execution/llmTasks/runLlmTaskInWorkspace';
import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { ExecutionRunStatus } from '@happier-dev/protocol/execution/runs/responseSchemas';

export type ScmCommitMessageGeneratorResult =
    | { ok: true; message: string }
    | { ok: false; error: string; errorCode?: string; runId?: string; outcome?: 'pending' | 'unknown' };

export type CommitMessageHostV1 = LlmTaskHostV1;

function readMessage(result: LlmTaskRunResult): ScmCommitMessageGeneratorResult {
    if (!result.ok) return result;
    const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    const value = object(result.terminal.latestToolResult) ?? object(result.terminal.structuredMeta?.payload);
    const message = value && typeof value === 'object' && 'message' in value ? value.message : null;
    return typeof message === 'string' && message.trim()
        ? { ok: true, message: message.trim() }
        : { ok: false, error: 'Empty commit message suggestion' };
}

export async function generateScmCommitMessage(params: Readonly<{
    host: CommitMessageHostV1; choice: LlmTaskRunnerChoiceV1 | null; instructions?: string; scopePaths?: ReadonlyArray<string>;
}>): Promise<ScmCommitMessageGeneratorResult> {
    return readMessage(await runLlmTaskInWorkspace({ host: params.host, choice: params.choice,
        task: 'scm_commit_message', intent: 'scm_commit_message', intentInput: {
            ...(typeof params.instructions === 'string' && params.instructions.trim() ? { instructions: params.instructions.trim() } : {}),
            scope: { kind: 'paths', include: (params.scopePaths ?? []).filter(value => typeof value === 'string' && value.length > 0) },
        } }));
}

export async function readScmCommitMessageSuggestion(params: Readonly<{
    host: CommitMessageHostV1; runId: string; expectedStatus?: ExecutionRunStatus;
}>): Promise<ScmCommitMessageGeneratorResult> {
    return readMessage(await readLlmTaskRun(params));
}

export const stopScmCommitMessageSuggestion = stopLlmTaskRun;
