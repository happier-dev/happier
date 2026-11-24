import { describe, expect, it } from 'vitest';
import { projectExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { applyExecutionRunChildSelection, clearExecutionRunChildSelection, readExecutionRunChildChoice, readExecutionRunFanoutMembers } from './executionRunChildChoice';
import { selectReviewLauncherRetryReviewers } from './reviewLauncherSelection';

describe('child choice permission for a fresh launch', () => {
    it('retains an explicit native account when a static or freeform native model has no catalog binding', () => {
        const connectedServices = { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        } };
        const modelSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' };
        expect(applyExecutionRunChildSelection({ connectedServices }, modelSelection))
            .toEqual({ modelSelection, connectedServices });
    });

    it('retains a native Agent model catalog account binding instead of opting out to machine login', () => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const modelSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' };
        expect(applyExecutionRunChildSelection({ connectedServices: null }, modelSelection, {
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'model-inference' },
            target: { kind: 'account', account: { service, accountId: 'selected-codex-account' } },
        })).toEqual({ modelSelection, connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'selected-codex-account' },
        } } });
    });

    it.each(['account', 'group'] as const)('retains the selected connected-account model and exact %s route', (kind) => {
        const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
        const modelSelection = { source: 'connected_account' as const, agentTargetKey: 'agent:happier.agent.claude/claude',
            modelId: 'sonnet', endpointTemplateId: 'claude-subscription',
            purpose: { consumer: service, purpose: 'model-inference' } };
        const target = kind === 'account'
            ? { kind, account: { service, accountId: 'chosen-account' } }
            : { kind, service, groupId: 'chosen-group' };
        const chosen = applyExecutionRunChildSelection({ instructions: 'Inspect', connectedServices: null }, modelSelection,
            { purpose: modelSelection.purpose, target });
        expect(chosen).toEqual({ instructions: 'Inspect', modelSelection, connectedServices: { v: 2,
            bindingsByServiceId: { 'happier.agent.claude/claude-subscription': kind === 'account'
                ? { source: 'connected', selection: 'profile', profileId: 'chosen-account' }
                : { source: 'connected', selection: 'group', groupId: 'chosen-group' } } } });
        expect(clearExecutionRunChildSelection(chosen)).toEqual({ instructions: 'Inspect' });
    });

    it('retains the standard Agent Team connected-account route when selecting a native runner model', () => {
        const connectedServices = { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'team_resource', resourceId: 'shared-account', deliveryMode: 'brokered' },
        } };
        const modelSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' };
        const input = { reviewers: [{ kind: 'engine', engineId: 'clawpatch', connectedServices }] };
        expect(applyExecutionRunChildSelection(input, modelSelection).reviewers).toEqual([
            { ...input.reviewers[0], modelSelection },
        ]);
    });

    it('authors native credential routing with an exact native model and clears it for inherited or Account-default choices', () => {
        const modelSelection = { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'sonnet' };
        const chosen = applyExecutionRunChildSelection({ instructions: 'Inspect', connectedServices: null }, modelSelection);
        expect(chosen).toEqual({ instructions: 'Inspect', modelSelection, connectedServices: null });
        expect(clearExecutionRunChildSelection(chosen)).toEqual({ instructions: 'Inspect' });
        expect(applyExecutionRunChildSelection(chosen, 'agentDefault')).toEqual({ instructions: 'Inspect', childSelection: 'agentDefault' });
    });

    it('keeps a Provider model source responsible for its route after a native choice', () => {
        const modelSelection = { agentTargetKey: 'agent:claude', providerConnectionId: 'provider_1', modelId: 'sonnet' };
        expect(applyExecutionRunChildSelection({ instructions: 'Inspect', connectedServices: null }, modelSelection))
            .toEqual({ instructions: 'Inspect', modelSelection });
    });
    it('retries the original indexed engine selection with its configuration and excludes mixed participants', () => {
        const first = { kind: 'engine', engineId: 'codex', modelId: 'first-model' };
        const second = { kind: 'engine', engineId: 'codex', modelId: 'second-model' };
        const input = { instructions: 'review', reviewers: [first,
            { kind: 'session', session: { serverId: 'home', sessionId: 'session' } }, second] };
        expect(selectReviewLauncherRetryReviewers(input, ['step-1-reviewer-3', 'step-1-reviewer-2']))
            .toEqual({ instructions: 'review', reviewers: [second] });
    });
    it('revokes the previous no-effect choice after an unknown-effect attempt', () => {
        const refusal = { ok: false as const, error: 'Choose', errorCode: 'execution_run_child_choice_required',
            details: { childChoice: projectExecutionRunChildChoiceV1({ agentTargetKey: 'agent:codex' }),
                executionRunStart: { v: 1, runCreation: 'noRunCreated' } } };
        const choice = readExecutionRunChildChoice(refusal);
        expect(choice).toEqual(refusal.details.childChoice);
        expect(readExecutionRunChildChoice({ ...refusal, details: {
            ...refusal.details, executionRunStart: { v: 1, runCreation: 'outcomeUnknown' },
        } })).toBeNull();
        expect(readExecutionRunChildChoice({ ok: false, error: 'Lost transport', errorCode: 'action_failed' })).toBeNull();
    });

    it('reads each target of a fan-out as started, refused with a choice, or unknown', () => {
        const childChoice = projectExecutionRunChildChoiceV1({ agentTargetKey: 'agent:codex' });
        const noRunCreated = { executionRunStart: { v: 1, runCreation: 'noRunCreated' } };
        const members = readExecutionRunFanoutMembers({ ok: true, result: { results: [
            { key: 'claude', ok: true, result: { runId: 'run_1' } },
            { key: 'codex', ok: false, errorCode: 'execution_run_child_choice_required', details: { ...noRunCreated, childChoice } },
            { key: 'gemini', ok: false, errorCode: 'execution_run_failed', details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } } },
        ] } } as never);
        expect(members).toEqual([
            { key: 'claude', runId: 'run_1', choice: null },
            { key: 'codex', runId: null, choice: childChoice },
            { key: 'gemini', runId: null, choice: null },
        ]);
    });

    it('leaves one child choice on a start input and none when returning to the session', () => {
        const input = { instructions: 'x', modelId: 'm', modelSelection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'm' },
            teamCredentialSessionBindingConsent: { v: 1 }, connectedServicesByBackendTargetKey: { a: 'b' }, connectedServices: 'c' };
        expect(clearExecutionRunChildSelection(input)).toEqual({ instructions: 'x' });
        expect(applyExecutionRunChildSelection(input, 'agentDefault')).toEqual({ instructions: 'x', childSelection: 'agentDefault' });
    });
});
