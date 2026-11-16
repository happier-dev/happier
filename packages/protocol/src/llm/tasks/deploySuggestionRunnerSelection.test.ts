import { expect, it } from 'vitest';
import { resolveLlmTaskRunnerV1, type LlmTaskRunnerCandidateV1 } from './llmTaskRunnerSelection.js';

const models = (['low', 'premium', 'standard'] as const).map(costTier => ({
    title: costTier,
    costTier,
    structuredOutput: 'supported',
    modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: costTier },
})) satisfies LlmTaskRunnerCandidateV1[];

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
