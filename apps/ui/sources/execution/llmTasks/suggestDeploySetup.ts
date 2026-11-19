import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ExecutionRunError } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
    DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1,
    DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
    DEPLOY_SUGGESTION_INSTRUCTIONS_V1,
    DeploySuggestionCatalogV1Schema,
    DeploySuggestionCheckResultV1Schema,
    DeploySuggestionInputV1Schema,
    DeploySuggestionV1Schema,
    type DeploySuggestionCatalogV1,
    type DeploySuggestionCheckResultV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { LlmTaskRunnerResolutionV1, LlmTaskRunnerUnavailableAgentV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';
import { normalizeInteractionTransientQuestionsV1, type InteractionTransientQuestionAnswerV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';

import { waitForAppShellRegistrySourcesSettled } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveWorkspaceLlmTaskRunner, runLlmTaskInWorkspace, stopLlmTaskRun, type LlmTaskHostV1 } from './runLlmTaskInWorkspace';

const executeAction = createFrontDoorActionExecute();

export type DeploySuggestionProgress =
    | Readonly<{ kind: 'catalog'; counts: Readonly<Record<'starters' | 'apps' | 'targets' | 'machines' | 'stores', number>> }>
    | Readonly<{ kind: 'runner'; machineId: string; label: string; agentTargetKey: string; agentTitle?: string }>
    /** `stop` asks this accepted Run's own target to stop it again (after a refused Stop); it settles with the Action's result. */
    | Readonly<{ kind: 'run'; machineId: string; label: string; agentTargetKey: string; agentTitle?: string; runId: string;
        stop: () => Promise<ActionExecuteResult> }>;

export type DeploySuggestionUnavailableMachine = Readonly<{
    machineId: string;
    /** Absent while the Machine owner has no name for it yet; the step reads the settled name from that owner. */
    label?: string;
    online: boolean;
    reason: Extract<LlmTaskRunnerResolutionV1, { ok: false }>['reason'] | 'offline' | 'home_directory_unavailable';
    unavailableAgents: readonly LlmTaskRunnerUnavailableAgentV1[];
}>;

export type DeploySuggestionOutcome =
    | Readonly<{ kind: 'recommendations'; catalog: DeploySuggestionCatalogV1;
        recommendations: DeploySuggestionCheckResultV1['recommendations']; dropped: DeploySuggestionCheckResultV1['dropped'] }>
    // Canonical questions (author defaults filled once), the form the step presents.
    | Readonly<{ kind: 'questions'; catalog: DeploySuggestionCatalogV1; questions: ReturnType<typeof normalizeInteractionTransientQuestionsV1> }>
    | Readonly<{ kind: 'nothing'; catalog: DeploySuggestionCatalogV1; dropped: DeploySuggestionCheckResultV1['dropped'] }>
    | Readonly<{ kind: 'noAgent'; machines: readonly DeploySuggestionUnavailableMachine[] }>
    /**
     * Where it failed: before any agent ran (`setup`), in the agent's Run (`run`, with the Run's typed error when it
     * settled), or on the agent's answer, which the check refused (`answer`).
     */
    | Readonly<{ kind: 'failed'; code: string; stage: 'setup' | 'answer' }>
    | Readonly<{ kind: 'failed'; code: string; stage: 'run'; runError?: ExecutionRunError }>
    | Readonly<{ kind: 'stopped' }>;

/** The one read of what can be offered (`deployments.suggestions.catalog`); a starter picked by hand reads the same snapshot. */
export async function readDeploySuggestionCatalog(params: Readonly<{ serverId: string; signal?: AbortSignal }>): Promise<
    Readonly<{ kind: 'catalog'; catalog: DeploySuggestionCatalogV1 }> | Readonly<{ kind: 'failed'; code: string }>> {
    const listed = await executeAction(DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, {}, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: params.serverId, ...(params.signal ? { signal: params.signal } : {}) });
    if (!listed.ok) return { kind: 'failed', code: listed.errorCode };
    const parsed = DeploySuggestionCatalogV1Schema.safeParse(listed.result);
    return parsed.success ? { kind: 'catalog', catalog: parsed.data } : { kind: 'failed', code: 'invalid_action_output' };
}

/** One snapshot and one accepted task; answers reuse the snapshot supplied by the dialog. */
export async function suggestDeploySetup(params: Readonly<{
    serverId: string;
    description: string;
    note?: string;
    answers?: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>;
    catalog?: DeploySuggestionCatalogV1;
    choice?: LlmTaskRunnerChoiceV1 | null;
    onProgress?: (progress: DeploySuggestionProgress) => void;
    signal?: AbortSignal;
}>): Promise<DeploySuggestionOutcome> {
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        actionCaller: { kind: 'host' as const }, serverId: params.serverId, ...(params.signal ? { signal: params.signal } : {}) };
    try {
        if (params.signal?.aborted) return { kind: 'stopped' };
        let catalog = params.catalog;
        if (!catalog) {
            // A Machine still owing its registry sources may carry the only starters: read once they settle.
            await waitForAppShellRegistrySourcesSettled(params.signal);
            if (params.signal?.aborted) return { kind: 'stopped' };
            const listed = await readDeploySuggestionCatalog(params);
            if (params.signal?.aborted) return { kind: 'stopped' };
            if (listed.kind === 'failed') return { ...listed, stage: 'setup' };
            catalog = listed.catalog;
        }
        params.onProgress?.({ kind: 'catalog', counts: { starters: catalog.starters.length, apps: catalog.apps.length,
            targets: catalog.targets.length, machines: catalog.machines.length, stores: catalog.stores.length } });
        const input = DeploySuggestionInputV1Schema.safeParse({ description: params.description, catalog,
            ...(params.note === undefined ? {} : { note: params.note }), ...(params.answers === undefined ? {} : { answers: params.answers }) });
        if (!input.success) return { kind: 'failed', code: 'invalid_parameters', stage: 'setup' };

        const unavailable: DeploySuggestionUnavailableMachine[] = [];
        for (const machine of catalog.machines) {
            if (params.signal?.aborted) return { kind: 'stopped' };
            if (!machine.online || !machine.homeDir) {
                unavailable.push({ machineId: machine.machineId, ...(machine.label ? { label: machine.label } : {}), online: machine.online,
                    reason: machine.online ? 'home_directory_unavailable' : 'offline', unavailableAgents: [] });
                continue;
            }
            // A no-tools task needs no project folder: the Machine's home always exists (its new-project parent may not).
            const host: LlmTaskHostV1 = { kind: 'workspace', workspace: { serverId: params.serverId,
                machineId: machine.machineId, rootPath: machine.homeDir } };
            const resolved = await resolveWorkspaceLlmTaskRunner(host, params.choice ?? null, 'deploy_suggestion');
            if (params.signal?.aborted) return { kind: 'stopped' };
            if (!resolved.ok) {
                if (resolved.errorCode !== 'LLM_TASK_RUNNER_UNAVAILABLE' || !resolved.reason) {
                    return { kind: 'failed', code: resolved.errorCode ?? 'runner_unavailable', stage: 'setup' };
                }
                unavailable.push({ machineId: machine.machineId, ...(machine.label ? { label: machine.label } : {}), online: true,
                    reason: resolved.reason, unavailableAgents: resolved.unavailableAgents ?? [] });
                continue;
            }
            // The runner is named inside sentences ("Runs on …"); a Machine without a name yet reads as the owner's "this machine".
            const runner = { machineId: machine.machineId, label: machine.label ?? getMachineSentenceName(null),
                agentTargetKey: resolved.runner.modelSelection.agentTargetKey,
                ...(resolved.title ? { agentTitle: resolved.title } : {}) };
            params.onProgress?.({ kind: 'runner', ...runner });
            const run = await runLlmTaskInWorkspace({ host, choice: params.choice ?? null, resolvedRunner: resolved.runner,
                task: 'deploy_suggestion', intent: 'task', instructions: DEPLOY_SUGGESTION_INSTRUCTIONS_V1,
                intentInput: { input: input.data, resultSchema: zodSchemaToJsonSchemaObject(DeploySuggestionV1Schema, { target: 'draft-7' }) },
                ...(params.signal ? { signal: params.signal } : {}),
                onStarted: runId => params.onProgress?.({ kind: 'run', ...runner, runId, stop: () => stopLlmTaskRun({ host, runId }) }),
            });
            if (!run.ok) return params.signal?.aborted && run.errorCode === 'cancelled'
                ? { kind: 'stopped' } : { kind: 'failed', code: run.errorCode ?? 'execution_run_failed', stage: 'run',
                    ...(run.runError ? { runError: run.runError } : {}) };
            if (params.signal?.aborted) return { kind: 'stopped' };
            const checked = await executeAction(DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1, { catalog,
                suggestion: run.terminal.latestToolResult ?? run.terminal.structuredMeta?.payload }, context);
            if (params.signal?.aborted) return { kind: 'stopped' };
            if (!checked.ok) return { kind: 'failed', code: checked.errorCode, stage: 'answer' };
            const result = DeploySuggestionCheckResultV1Schema.safeParse(checked.result);
            if (!result.success) return { kind: 'failed', code: 'invalid_action_output', stage: 'answer' };
            if (result.data.recommendations.length) return { kind: 'recommendations', catalog,
                recommendations: result.data.recommendations, dropped: result.data.dropped };
            if (result.data.questions) return { kind: 'questions', catalog, questions: normalizeInteractionTransientQuestionsV1(result.data.questions) };
            return { kind: 'nothing', catalog, dropped: result.data.dropped };
        }
        return { kind: 'noAgent', machines: unavailable };
    } catch (error) {
        if (params.signal?.aborted) return { kind: 'stopped' };
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        return { kind: 'failed', code: typeof code === 'string' ? code : 'suggestion_failed', stage: 'setup' };
    }
}
