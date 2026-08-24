import { describe, expect, it } from 'vitest';

import {
    TRIAGE_DEFAULT_ACTIONS_V1,
    planTriageOfferedActionsV1,
    readTriageActionTitleKeyV1,
    type TriageActionV1,
} from '../../settings/actions.js';
import {
    triageMovedActionOrderV1,
    triageUpdateActionInputV1,
    type TriageActionEditorDraftV1,
} from './actionsCommand.js';
import {
    newTriageActionDraftV1,
    triageActionDraftBlockerV1,
    triageActionDraftV1,
    triagePromptInvocationEditorOptionsV1,
    withTriageActionTargetKindV1,
    withTriageAppliesToV1,
    withTriageDeliveryV1,
    withTriageProfileIdV1,
    withTriagePromptTokenV1,
} from './editorModel.js';

const ASK = TRIAGE_DEFAULT_ACTIONS_V1[0]!;
const FIX = TRIAGE_DEFAULT_ACTIONS_V1[1]!;
const REVIEW = TRIAGE_DEFAULT_ACTIONS_V1[2]!;

describe('which actions an entry is offered', () => {
    it('offers an action on the subjects it declares, in the configured order', () => {
        expect(planTriageOfferedActionsV1(TRIAGE_DEFAULT_ACTIONS_V1, 'pullRequest')
            .map((action) => action.actionId)).toEqual(['ask', 'fix', 'review', 'code-review']);
        // Review reaches the incumbent `review.start` contract and is declared
        // on pull requests alone, so an error group is offered the other two.
        expect(planTriageOfferedActionsV1(TRIAGE_DEFAULT_ACTIONS_V1, 'errorIssue')
            .map((action) => action.actionId)).toEqual(['ask', 'fix']);
    });

    it('offers a disabled action nowhere while keeping it configured', () => {
        const disabled: readonly TriageActionV1[] = [{ ...FIX, enabled: false }, ASK];

        expect(planTriageOfferedActionsV1(disabled, 'issue').map((action) => action.actionId))
            .toEqual(['ask']);
        // Retained, not removed: it is still there to re-enable.
        expect(disabled).toHaveLength(2);
    });

    it('preserves the stored order rather than reapplying one of its own', () => {
        const reordered: readonly TriageActionV1[] = [REVIEW, ASK, FIX];

        expect(planTriageOfferedActionsV1(reordered, 'pullRequest').map((action) => action.actionId))
            .toEqual(['review', 'ask', 'fix']);
    });
});

describe('the words on a configured control', () => {
    it('translates a seeded label and shows a renamed one verbatim', () => {
        expect(readTriageActionTitleKeyV1(ASK)).toBe('plugins.triage.surface.session.ask');
        expect(readTriageActionTitleKeyV1(REVIEW)).toBe('plugins.triage.surface.session.review');
        // The first rename ends translation for exactly that action: the words
        // are now the person's, and a locale must not replace them.
        expect(readTriageActionTitleKeyV1({ ...ASK, label: 'Discuss' })).toBeNull();
    });

    it('never translates an action the seed does not name', () => {
        expect(readTriageActionTitleKeyV1({ ...ASK, actionId: 'minted-1' })).toBeNull();
    });
});

describe('moving one action inside the set', () => {
    it('produces an exact permutation the writer will accept', () => {
        expect(triageMovedActionOrderV1(TRIAGE_DEFAULT_ACTIONS_V1, 'fix', 'up'))
            .toEqual(['fix', 'ask', 'review', 'code-review']);
        expect(triageMovedActionOrderV1(TRIAGE_DEFAULT_ACTIONS_V1, 'fix', 'down'))
            .toEqual(['ask', 'review', 'fix', 'code-review']);
    });

    it('refuses a move off either end rather than wrapping or writing a no-op', () => {
        expect(triageMovedActionOrderV1(TRIAGE_DEFAULT_ACTIONS_V1, 'ask', 'up')).toBeNull();
        expect(triageMovedActionOrderV1(TRIAGE_DEFAULT_ACTIONS_V1, 'code-review', 'down')).toBeNull();
        expect(triageMovedActionOrderV1(TRIAGE_DEFAULT_ACTIONS_V1, 'not-a-stored-action', 'up'))
            .toBeNull();
    });
});

describe('the draft a person is editing', () => {
    it('claims a configured prompt was deleted only from a complete inventory', () => {
        const base = {
            heldInvocationId: 'prompt-outside-window',
            invocations: [{ id: 'prompt-1', token: '/review', title: 'Review' }],
            noPromptLabel: 'No prompt',
            missingPromptLabel: 'Prompt no longer in your library',
        } as const;

        expect(triagePromptInvocationEditorOptionsV1({
            ...base,
            coverage: 'truncated',
        }).at(-1)).toEqual({
            value: 'prompt-outside-window',
            label: 'prompt-outside-window',
        });
        expect(triagePromptInvocationEditorOptionsV1({
            ...base,
            coverage: null,
        }).at(-1)).toEqual({
            value: 'prompt-outside-window',
            label: 'prompt-outside-window',
        });
        expect(triagePromptInvocationEditorOptionsV1({
            ...base,
            coverage: 'complete',
        }).at(-1)).toEqual({
            value: 'prompt-outside-window',
            label: 'Prompt no longer in your library',
        });
    });

    it('starts offered everywhere and needing nothing materialized', () => {
        const draft = newTriageActionDraftV1();

        expect(draft.appliesTo).toEqual(['pullRequest', 'issue', 'errorIssue', 'other']);
        expect(draft.workspaceMode).toBe('reference_only');
        expect(draft.target).toEqual({
            kind: 'agent',
            promptInvocationId: null,
            delivery: 'compose',
        });
        // Unnamed is the one thing that blocks it, so **Save** says so instead
        // of sending a write the owner will refuse.
        expect(triageActionDraftBlockerV1(draft)).toBe('label');
    });

    it('blocks a draft offered on nothing, which no writer would accept either', () => {
        const draft = withTriageAppliesToV1({ ...newTriageActionDraftV1(), label: 'Explain' }, []);

        expect(draft.appliesTo).toEqual([]);
        expect(triageActionDraftBlockerV1(draft)).toBe('appliesTo');
    });

    it('keeps chosen subjects in the vocabulary order and free of repeats', () => {
        const draft = withTriageAppliesToV1(
            newTriageActionDraftV1(),
            ['other', 'pullRequest', 'other'],
        );

        // The writer refuses a repeated subject outright, so an ordinary click
        // sequence must not become a rejected write.
        expect(draft.appliesTo).toEqual(['pullRequest', 'other']);
    });

    it('states the arm rather than inferring it, and keeps the prompt across a switch', () => {
        const configured = withTriageDeliveryV1(
            withTriagePromptTokenV1(newTriageActionDraftV1(), '/explain'),
            'send',
        );
        expect(configured.target).toEqual({
            kind: 'agent',
            promptInvocationId: '/explain',
            delivery: 'send',
        });

        // `review.start` starts runs and has no other delivery, so the review
        // arm drops `delivery`. The prompt reference SURVIVES: it answers the
        // same question on both arms, and silently discarding a person's
        // configuration for changing an unrelated member is a loss, not a
        // simplification.
        const review = withTriageActionTargetKindV1(configured, 'reviewStart');
        expect(review.target).toEqual({ kind: 'reviewStart', promptInvocationId: '/explain' });

        // Switching back restores the agent default delivery and keeps the
        // prompt, so a round trip through the arm control loses nothing.
        expect(withTriageActionTargetKindV1(review, 'agent').target).toEqual({
            kind: 'agent',
            promptInvocationId: '/explain',
            delivery: 'compose',
        });
    });

    it('treats an emptied prompt or profile field as "not set", never as an empty value', () => {
        const withValues = withTriageProfileIdV1(
            withTriagePromptTokenV1(newTriageActionDraftV1(), '  /review  '),
            '  profile-7  ',
        );
        expect(withValues.profileId).toBe('profile-7');
        expect(withValues.target).toEqual({
            kind: 'agent',
            promptInvocationId: '/review',
            delivery: 'compose',
        });

        const cleared = withTriageProfileIdV1(withTriagePromptTokenV1(withValues, '   '), '');
        expect(cleared.profileId).toBeNull();
        expect(cleared.target).toEqual({
            kind: 'agent',
            promptInvocationId: null,
            delivery: 'compose',
        });
    });

    it('sends a rename, a disable and a reconfigure as one whole update', () => {
        // Rename, disable and reconfigure are the same write of the same five
        // answers. A partial command would be a second answer to "what does
        // rename leave untouched", and the first stale member it met would be
        // written back over another device's change.
        const draft: TriageActionEditorDraftV1 = {
            ...triageActionDraftV1(ASK),
            label: 'Discuss',
            enabled: false,
        };

        expect(triageUpdateActionInputV1(ASK.actionId, draft, 'revision-4')).toEqual({
            v: 1,
            kind: 'update',
            actionId: 'ask',
            expectedRevision: 'revision-4',
            label: 'Discuss',
            enabled: false,
            appliesTo: ['pullRequest', 'issue', 'errorIssue', 'other'],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
    });
});
