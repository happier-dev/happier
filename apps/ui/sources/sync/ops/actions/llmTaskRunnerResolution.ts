import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { LlmTaskRunnerResolutionWireV1Schema, type LlmTaskIdV1, type LlmTaskRunnerResolutionWireV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';

import type { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction } from './accountActionDeps';

type ActionAccount = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

type RunnerResolutionParams = Readonly<{
    machineId: string;
    task: LlmTaskIdV1;
    choice: LlmTaskRunnerChoiceV1 | null;
    /** The Session's own Agent; omitted outside a Session (the owner then uses the default Agent). */
    sessionAgentTargetKey?: string | null;
    signal?: AbortSignal;
}>;

/**
 * The Machine's answer to `agents.models.list` for a background task, unparsed: only that Machine knows its ready
 * Agents, so the UI host never answers this itself (its own Action host forwards here, and Settings reads it below).
 */
export async function executeLlmTaskRunnerResolutionOnMachine(account: ActionAccount, params: RunnerResolutionParams): Promise<unknown> {
    account.assertCurrent();
    const result = await createUiAccountAction({ account })({ actionId: 'agents.models.list',
        input: { purpose: 'llm_task_runner', task: params.task, machineId: params.machineId, ...(params.choice ? { choice: params.choice } : {}),
            ...(params.sessionAgentTargetKey ? { sessionAgentTargetKey: params.sessionAgentTargetKey } : {}) },
        context: { serverId: account.serverId, runtimeAccountId: account.accountId, surface: 'ui',
            authority: 'account_automation', actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'machine', machineId: params.machineId } },
        ...(params.signal ? { signal: params.signal } : {}) });
    account.assertCurrent();
    return result;
}

/** What a background task runs on this Machine: the stored choice, or what Auto picks there now. */
export async function readLlmTaskRunnerResolutionForMachine(account: ActionAccount, params: RunnerResolutionParams): Promise<LlmTaskRunnerResolutionWireV1 | null> {
    const result = await executeLlmTaskRunnerResolutionOnMachine(account, params);
    const parsed = LlmTaskRunnerResolutionWireV1Schema.safeParse(result && typeof result === 'object'
        && 'llmTaskRunner' in result ? result.llmTaskRunner : null);
    return parsed.success ? parsed.data : null;
}
