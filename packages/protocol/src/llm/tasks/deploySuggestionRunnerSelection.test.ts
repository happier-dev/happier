import { expect, it } from 'vitest';
import { resolveLlmTaskRunnerV1, type LlmTaskRunnerCandidateV1 } from './llmTaskRunnerSelection.js';

const models = (['low', 'premium', 'standard'] as const).map(costTier => ({
    title: costTier,
    costTier,
    structuredOutput: 'supported',
    noTools: true,
    modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: costTier },
})) satisfies LlmTaskRunnerCandidateV1[];

const muse = { ...models[0]!, noTools: false, modelSelection: { agentTargetKey: 'agent:happier.agent.muse/muse',
    providerConnectionId: null, modelId: 'meta/muse-spark-1.3-contributor' } } as const;

it('skips native Muse and undeclared Agents when choosing a no-tools runner', () => {
    const winner = models.find(model => model.costTier === 'standard')!;
    const undeclared = { ...winner, noTools: undefined };
    expect(resolveLlmTaskRunnerV1({ task: 'deploy_suggestion', choice: null, candidates: [muse, undeclared, winner] }))
        .toMatchObject({ ok: true, runner: { modelSelection: winner.modelSelection, permissionMode: 'no_tools' } });
    expect(resolveLlmTaskRunnerV1({ task: 'deploy_suggestion', choice: null, candidates: [muse, undeclared] }))
        .toMatchObject({ ok: false, reason: 'no_matching_model' });
    expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: { v: 1, mode: 'auto', permissionMode: 'read_only' },
        candidates: [muse] })).toMatchObject({ ok: true, runner: { modelSelection: muse.modelSelection, permissionMode: 'read_only' } });
});

it('refuses an explicit Agent that cannot enforce no-tools, while preserving explicit read-only choices', () => {
    const choice = { v: 1 as const, modelSelection: muse.modelSelection };
    const candidates = [...models, muse];
    expect(resolveLlmTaskRunnerV1({ task: 'session_replay_summary', choice: { ...choice, permissionMode: 'read_only' }, candidates }))
        .toEqual({ ok: true, source: 'explicit', runner: { ...choice, permissionMode: 'read_only' } });
    const enforcingChoice = { ...choice, modelSelection: models[0]!.modelSelection };
    expect(resolveLlmTaskRunnerV1({ task: 'deploy_suggestion', choice: enforcingChoice, candidates }))
        .toEqual({ ok: true, source: 'explicit', runner: { ...enforcingChoice, permissionMode: 'no_tools' } });
    expect(resolveLlmTaskRunnerV1({ task: 'deploy_suggestion', choice, candidates }))
        .toEqual({ ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_matching_model', unavailableAgents: [] });
});

it('prefers standard then premium then low for deploy suggestions while commit tasks stay cheapest-first', () => {
    for (const [candidates, modelId] of [
        [models, 'standard'],
        [models.filter(row => row.costTier !== 'standard'), 'premium'],
        [models.filter(row => row.costTier === 'low'), 'low'],
    ] as const) {
        expect(resolveLlmTaskRunnerV1({ task: 'deploy_suggestion', choice: null, candidates }))
            .toMatchObject({ ok: true, runner: { modelSelection: { modelId }, permissionMode: 'no_tools' } });
    }
    expect(resolveLlmTaskRunnerV1({ task: 'scm_commit_message', choice: null, candidates: models }))
        .toMatchObject({ ok: true, runner: { modelSelection: { modelId: 'low' } } });
    const choice = { v: 1 as const, modelSelection: models[0]!.modelSelection };
    expect(resolveLlmTaskRunnerV1({ task: 'deploy_suggestion', choice, candidates: models }))
        .toMatchObject({ ok: true, source: 'explicit', runner: choice });
});
