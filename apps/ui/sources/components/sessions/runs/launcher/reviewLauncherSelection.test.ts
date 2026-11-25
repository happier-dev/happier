import { describe, expect, it } from 'vitest';
import { ReviewStartInputSchema, type ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { applyExecutionRunChildSelection, selectReviewLauncherRunner } from './executionRunChildChoice';
import { compileReviewLauncherInput, updateReviewLauncherEngineConfiguration, updateReviewLauncherStepInput, updateReviewLauncherReviewerInput, appendReviewLauncherEngineMember, selectReviewLauncherEngines } from './reviewLauncherSelection';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';

describe('review launcher submission', () => {
    it('defaults a new engine to the first existing member runner when supported, otherwise the first ready runner', () => {
        const codex = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const claude = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const choices: readonly ExecutionRunLauncherBackendChoice[] = [
            { backendTarget: codex, targetKey: 'agent:happier.agent.codex/codex', backendId: 'codex', agentId: 'codex', title: 'Codex', disabled: false },
            { backendTarget: claude, targetKey: 'agent:happier.agent.claude/claude', backendId: 'claude', agentId: 'claude', title: 'Claude', disabled: false },
            { backendTarget: { kind: 'backend', backendId: 'deepsec' }, targetKey: 'deepsec', backendId: 'deepsec', agentId: 'deepsec', title: 'DeepSec', disabled: false,
                reviewInventoryItem: { engineId: 'deepsec', label: 'DeepSec', enabled: true, capabilities: { structuredNarration: true }, runnerAgents: [
                    { agentTarget: codex, providerProtocols: ['openai-responses'] }, { agentTarget: claude, providerProtocols: ['anthropic'] },
                ] } },
        ];
        const member = { kind: 'engine', engineId: 'roborev', runnerAgentTarget: claude };
        expect(selectReviewLauncherEngines({ reviewers: [member] }, ['roborev', 'deepsec'], choices).reviewers)
            .toEqual([member, { kind: 'engine', engineId: 'deepsec', runnerAgentTarget: claude }]);
        expect(selectReviewLauncherEngines({ reviewers: [] }, ['deepsec'], choices.map(choice => choice.backendId === 'codex'
            ? { ...choice, disabled: true } : choice)).reviewers)
            .toEqual([{ kind: 'engine', engineId: 'deepsec', runnerAgentTarget: claude }]);
        expect(selectReviewLauncherEngines({ reviewers: [] }, ['deepsec'], choices.filter(choice => choice.backendId === 'deepsec')).reviewers)
            .toEqual([{ kind: 'engine', engineId: 'deepsec', runnerAgentTarget: codex }]);
        expect(selectReviewLauncherEngines({ reviewers: [{ kind: 'engine', engineId: 'deepsec' }] }, ['deepsec'], choices).reviewers)
            .toEqual([{ kind: 'engine', engineId: 'deepsec', runnerAgentTarget: codex }]);
        expect(selectReviewLauncherEngines({ reviewers: [member] }, ['roborev', 'deepsec'], choices.filter(choice => choice.backendId === 'deepsec')).reviewers)
            .toEqual([member, { kind: 'engine', engineId: 'deepsec', runnerAgentTarget: claude }]);
    });
    it('changes the runner without carrying the previous Agent account or model into the next invocation', () => {
        const runnerAgentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const changed = selectReviewLauncherRunner({ roleId: 'reviewer', modelId: 'sonnet',
            connectedServices: { account: 'claude' }, modelSelection: { modelId: 'sonnet' },
            teamCredentialModel: { resourceId: 'claude-team' } }, runnerAgentTarget);
        expect(changed).toEqual({ roleId: 'reviewer', runnerAgentTarget });
    });
    it('edits one repeated panel member without sharing its selected account with another member', () => {
        const runnerAgentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const member = { kind: 'engine', engineId: 'roborev', runnerAgentTarget, connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'first' },
        } } };
        const input = appendReviewLauncherEngineMember({ reviewers: [member] }, 0);
        const modelSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6.1-luna' };
        const changed = updateReviewLauncherReviewerInput(input, 1, previous =>
            applyExecutionRunChildSelection(previous, modelSelection));
        expect(changed.reviewers).toEqual([member, { ...member, modelSelection }]);
    });
    it('defaults a new panel member to the first member of that engine when added from another member', () => {
        const first = { kind: 'engine', engineId: 'roborev', connectedServices: { account: 'first' } };
        const otherEngine = { kind: 'engine', engineId: 'clawpatch', connectedServices: { account: 'other' } };
        const second = { ...first, connectedServices: { account: 'second' } };
        const input = { reviewers: [otherEngine, first, second] };
        expect(appendReviewLauncherEngineMember(input, 2).reviewers).toEqual([otherEngine, first, second, first]);
    });
    it('compiles the chosen reviewer exact native model and explicit native route through the start schema', () => {
        const reviewer = { kind: 'engine', engineId: 'claude' };
        const modelSelection = { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'sonnet' };
        const selected = applyExecutionRunChildSelection({ reviewers: [reviewer], steps: [
            { kind: 'review', reviewers: [reviewer], instructions: '' },
        ] }, modelSelection);
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput(selected, 'Inspect', null));
        expect(parsed.reviewers).toEqual([{ ...reviewer, modelSelection, connectedServices: null }]);
    });

    const transcriptReviewers = [
        { kind: 'session', session: { serverId: 'peer-home', sessionId: 'peer' }, includeSessionTranscript: true },
        { kind: 'model', launch: {
            executionTarget: { serverId: 'model-home', machineId: 'machine' },
            directory: { kind: 'path', path: '/work' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            permissionMode: 'read-only',
        }, includeSessionTranscript: true },
    ] satisfies ReviewReviewerSelectionV1[];

    it.each(transcriptReviewers)('submits selected transcript scope for a $kind-only roster', reviewer => {
        const sourceSession = { serverId: 'source-home', sessionId: 'source' };
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput({ reviewers: [reviewer] }, 'Inspect', sourceSession));
        expect(parsed.sourceSession).toEqual(sourceSession);
        expect(parsed.reviewers).toEqual([reviewer]);
    });

    it.each(transcriptReviewers)('omits unselected transcript scope for a $kind-only roster', reviewer => {
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput({
            reviewers: [{ ...reviewer, includeSessionTranscript: false }],
        }, 'Inspect', { serverId: 'source-home', sessionId: 'source' }));
        expect(parsed.sourceSession).toBeUndefined();
    });

    it.each(transcriptReviewers)('keeps detached selected transcript refusal for a $kind-only roster', reviewer => {
        const parsed = ReviewStartInputSchema.safeParse(compileReviewLauncherInput({ reviewers: [reviewer] }, 'Inspect', null));
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'custom', path: ['sourceSession'] }),
        ]));
    });

    it('edits the chosen later-step configuration while retaining repeated engines and the scalar first roster', () => {
        const first = { kind: 'engine', engineId: 'claude', modelId: 'first-model' };
        const input = { reviewers: [first], steps: [
            { kind: 'review', reviewers: [first], instructions: 'Security' },
            { kind: 'verify', reviewers: [{ kind: 'engine', engineId: 'claude', modelId: 'second-model' },
                { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true }], instructions: 'Check fixes' },
        ] };
        const updated = updateReviewLauncherStepInput(input, 1, step => updateReviewLauncherEngineConfiguration(step,
            previous => ({ ...previous, modelId: 'third-model', roleId: 'reviewer' })));
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput(updated, 'Inspect', null));
        expect(parsed.reviewers).toEqual([first]);
        expect(parsed.steps![1]!.reviewers).toEqual([
            { kind: 'engine', engineId: 'claude', modelId: 'third-model', roleId: 'reviewer' },
            { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true },
        ]);
        expect(parsed.steps!.map(step => step.instructions)).toEqual(['Security', 'Check fixes']);
    });
    it('submits authored steps with their own reviewers and focus through the canonical start schema', () => {
        const input = compileReviewLauncherInput({ reviewers: [], steps: [
            { kind: 'review', reviewers: [{ kind: 'engine', engineId: 'claude', includeSessionTranscript: true }], instructions: 'Security' },
            { kind: 'verify', reviewers: [{ kind: 'session', session: { serverId: 'home', sessionId: 'peer' } }], instructions: '' },
        ], then: 'fix' }, 'Inspect changes', { serverId: 'home', sessionId: 'source' });
        const parsed = ReviewStartInputSchema.parse(input);
        expect(parsed.reviewers).toEqual(parsed.steps![0]!.reviewers);
        expect(parsed.steps![0]!.instructions).toBe('Security');
        expect(parsed.steps![1]!.instructions).toBe('Inspect changes');
        expect(parsed.sourceSession).toEqual({ serverId: 'home', sessionId: 'source' });
        expect(parsed.then).toBe('fix');
    });
    it('keeps a step reviewer model edit when compiling the retained draft', () => {
        const reviewer = { kind: 'engine', engineId: 'claude' };
        const updated = updateReviewLauncherEngineConfiguration({ reviewers: [reviewer], steps: [
            { kind: 'review', reviewers: [reviewer], instructions: '' },
        ] }, previous => ({ ...previous, modelId: 'chosen-model' }));
        expect(compileReviewLauncherInput(updated, 'Inspect', null).reviewers).toEqual([
            { ...reviewer, modelId: 'chosen-model' },
        ]);
    });
    it('retains the direct one-step path and does not invent transcript scope for detached starts', () => {
        const parsed = ReviewStartInputSchema.parse(compileReviewLauncherInput({ reviewers: [{ kind: 'engine', engineId: 'claude' }], outputs: [] }, 'Inspect', null));
        expect(parsed.steps).toBeUndefined();
        expect(parsed.sourceSession).toBeUndefined();
    });
});
