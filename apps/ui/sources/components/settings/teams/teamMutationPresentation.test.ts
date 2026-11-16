import { describe, expect, it, vi } from 'vitest';

// `t` is a genuine module boundary owned by the testkit. Mocking it here keeps
// these assertions about which message a failure maps to, rather than about the
// wording of one locale, which is not this owner's contract.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { isTeamCreateOwnerRefusal, teamCreateFailureLabel, teamMutationFailureLabel, teamReadFailureAction, teamReadFailureLabel } from './teamMutationPresentation';

describe('teamReadFailureLabel', () => {
    it('distinguishes transport loss from a retryable server answer and access refusal', () => {
        expect(teamReadFailureLabel({ kind: 'unreachable', retryable: true, code: null })).toBe('teams.unavailable.offline');
        expect(teamReadFailureLabel({ kind: 'unknown', retryable: true, code: null })).toBe('teams.errors.loadFailed');
        expect(teamReadFailureLabel({ kind: 'invalid', retryable: false, code: null })).toBe('teams.errors.loadFailed');
        expect(teamReadFailureLabel({ kind: 'forbidden', retryable: false, code: 'team_not_found' })).toBe('teams.errors.forbidden');
        expect(teamReadFailureLabel({ kind: 'unsupported', retryable: false, code: null })).toBe('teams.unavailable.updateRequired');
    });
});

describe('a Team read the person turned off in Settings, Actions', () => {
    const turnedOff = { kind: 'unknown' as const, retryable: false, code: 'action_disabled' };

    it('says it is turned off rather than that loading failed', () => {
        expect(teamReadFailureLabel(turnedOff)).toBe('actionConfirmations.turnedOffReadMessage');
    });

    it('leads to Actions settings instead of offering a retry that cannot help', () => {
        const retry = vi.fn();
        const openActionSettings = vi.fn();
        const action = teamReadFailureAction(turnedOff, { onPress: retry, testIDPrefix: 'team-x' }, openActionSettings);
        expect(action).toMatchObject({ label: 'actionConfirmations.openActionSettings', testID: 'team-x-open-actions-settings' });
        action!.onPress();
        expect(openActionSettings).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
    });

    it('still offers Retry for a retryable failure and nothing for a settled refusal', () => {
        const retry = vi.fn();
        const action = teamReadFailureAction({ kind: 'unknown', retryable: true, code: null }, { onPress: retry, testIDPrefix: 'team-x' }, vi.fn());
        expect(action).toMatchObject({ label: 'teams.unavailable.retry', testID: 'team-x-retry' });
        action!.onPress();
        expect(retry).toHaveBeenCalledOnce();
        expect(teamReadFailureAction({ kind: 'forbidden', retryable: false, code: null }, { onPress: retry }, vi.fn())).toBeUndefined();
    });
});

describe('teamMutationFailureLabel', () => {
    it.each(['approval_canceled', 'approval_rejected'])('silently keeps the person’s %s decision distinct from genuine permission refusals', code => {
        const failure = { kind: 'forbidden' as const, retryable: false, code };
        expect(teamMutationFailureLabel(failure)).toBeNull();
        expect(teamCreateFailureLabel(failure, false)).toBeNull();
        expect(teamMutationFailureLabel({ ...failure, code: 'team_forbidden' })).toBe('teams.errors.forbidden');
    });

    it('uses a single actionable sentence for a generic Team policy refusal', () => {
        expect(teamMutationFailureLabel({ kind: 'invalid', retryable: false, code: 'invalid_team_input' }, 'policy'))
            .toBe('teams.errors.policySaveFailed');
    });

    it('keeps managed Team creation causes at the presenter owner', () => {
        const failure = { kind: 'invalid' as const, retryable: false, code: 'invalid_team_input' };
        expect(isTeamCreateOwnerRefusal(failure)).toBe(true);
        expect(teamCreateFailureLabel(failure, false)).toBe('teams.create.initialOwnerRequired');
        expect(teamCreateFailureLabel(failure, true)).toBe('teams.create.initialOwnerIneligible');
    });

    it('distinguishes sign-in qualification from role permission for reads and mutations', () => {
        const failure = { kind: 'forbidden' as const, retryable: false, code: 'team_authentication_required' };
        expect(teamMutationFailureLabel(failure)).toBe('teams.errors.authenticationRequired');
        expect(teamReadFailureLabel(failure)).toBe('teams.errors.authenticationRequired');
        expect(teamMutationFailureLabel(failure, 'authentication_policy')).toBe('teams.authentication.policy.authenticationRequired');
        expect(teamMutationFailureLabel({ ...failure, code: null })).toBe('teams.errors.forbidden');
    });
    it('does not claim nothing changed when an Action outcome is unknown', () => {
        expect(teamMutationFailureLabel({ kind: 'outcome_unknown', retryable: true, code: null }))
            .toBe('teams.errors.outcomeUnknown');
    });

    it('reports an operation this Home does not have as an update, not a domain failure', () => {
        // Relabelling a missing operation as, say, a mail-delivery problem sends
        // a manager to fix the wrong thing. It is a fact about the Home's age.
        expect(teamMutationFailureLabel({ kind: 'unsupported', retryable: false, code: null }))
            .toBe('teams.unavailable.updateRequired');
    });

    it('keeps pre-dispatch reachability and authoritative refusals distinct', () => {
        expect(teamMutationFailureLabel({ kind: 'unreachable', retryable: true, code: null }))
            .toBe('teams.errors.offline');
        expect(teamMutationFailureLabel({ kind: 'forbidden', retryable: false, code: null }))
            .toBe('teams.errors.forbidden');
        expect(teamMutationFailureLabel({ kind: 'conflict', retryable: false, code: null }))
            .toBe('teams.errors.conflict');
    });

    it('explains a refusal over an inactive Account instead of a generic conflict', () => {
        // Every new Team ownership requires an active Account (L01/01 :337); the
        // role picker cannot know the target's Account status, so the Home's
        // typed refusal is the answer the person must be able to act on.
        expect(teamMutationFailureLabel({ kind: 'conflict', retryable: false, code: 'account_ineligible' }))
            .toBe('teams.members.accountInactive');
    });
});
