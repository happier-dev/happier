import { describe, expect, it } from 'vitest';
import { projectExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { applyExecutionRunChildSelection, clearExecutionRunChildSelection, readExecutionRunChildChoice, readExecutionRunFanoutMembers } from './executionRunChildChoice';
import { selectReviewLauncherRetryReviewers } from './reviewLauncherSelection';

describe('child choice permission for a fresh launch', () => {
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
