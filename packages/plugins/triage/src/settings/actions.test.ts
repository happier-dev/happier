import { describe, expect, it } from 'vitest';

import { createTestkitAccountSettings } from './testkit/accountSettings.test-support.js';
import {
    MAX_TRIAGE_ACTIONS_V1,
    TRIAGE_ACTIONS_SETTING_ID_V1,
    TRIAGE_DEFAULT_ACTIONS_V1,
    mutateTriageAction,
    parseTriageActions,
    readTriageActions,
    type TriageActionV1,
} from './actions.js';

const ASK = TRIAGE_DEFAULT_ACTIONS_V1[0]!;
const FIX = TRIAGE_DEFAULT_ACTIONS_V1[1]!;
const REVIEW = TRIAGE_DEFAULT_ACTIONS_V1[2]!;

function storedFrom(actions: readonly TriageActionV1[]): unknown {
    return {
        v: 1,
        actions: actions.map((action) => ({
            actionId: action.actionId,
            label: action.label,
            enabled: action.enabled,
            appliesTo: [...action.appliesTo],
            profileId: action.profileId,
            workspaceMode: action.workspaceMode,
            target: action.target.kind === 'reviewStart'
                ? { kind: 'reviewStart' }
                : {
                    kind: 'agent',
                    promptInvocationToken: action.target.promptInvocationToken,
                    delivery: action.target.delivery,
                },
        })),
    };
}

describe('the Triage action record', () => {
    it('seeds Ask, Fix and Review when nothing has ever been written', () => {
        const read = parseTriageActions(undefined);

        expect(read.kind).toBe('absent');
        expect(read.value.actions).toEqual(TRIAGE_DEFAULT_ACTIONS_V1);
        // The seed is what a reader sees, not what the record holds: an absent
        // value must not need a write before the headline controls exist.
        expect(read.value.actions.map((action) => action.label)).toEqual(['Ask', 'Fix', 'Review']);
    });

    it('keeps an explicitly emptied catalog empty rather than restoring the seed', () => {
        const read = parseTriageActions({ v: 1, actions: [] });

        expect(read.kind).toBe('parsed');
        expect(read.value.actions).toEqual([]);
    });

    it('answers the five configured questions and states the Review arm explicitly', () => {
        expect(ASK.workspaceMode).toBe('reference_only');
        expect(FIX.workspaceMode).toBe('repository');
        expect(REVIEW.workspaceMode).toBe('pull_request');

        // Review is not inferred from its label: the arm is a member.
        expect(REVIEW.target).toEqual({ kind: 'reviewStart' });
        expect(ASK.target).toEqual({ kind: 'agent', promptInvocationToken: null, delivery: 'compose' });

        // Only a pull request reaches the incumbent review contract.
        expect(REVIEW.appliesTo).toEqual(['pullRequest']);
        expect(ASK.appliesTo).toEqual(['pullRequest', 'issue', 'errorIssue', 'other']);

        // Neither agent nor model is a member; a Launch Profile owns them.
        expect(Object.keys(ASK).sort()).toEqual([
            'actionId',
            'appliesTo',
            'enabled',
            'label',
            'profileId',
            'target',
            'workspaceMode',
        ]);
    });

    it('refuses a stored value this build cannot read instead of reporting it absent', () => {
        expect(parseTriageActions({ v: 2, actions: [] }).kind).toBe('unreadable');
        expect(parseTriageActions({ v: 1, actions: [], extra: true }).kind).toBe('unreadable');
        expect(parseTriageActions({
            v: 1,
            actions: [{ ...storedFrom([ASK]) }],
        }).kind).toBe('unreadable');
    });

    it('refuses an action that applies to nothing, and one that names a subject twice', async () => {
        const testkit = createTestkitAccountSettings();

        const empty = await mutateTriageAction({ settings: testkit.settings, mintActionId: () => 'a' }, {
            kind: 'create',
            label: 'Nowhere',
            enabled: true,
            appliesTo: [],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationToken: null, delivery: 'compose' },
        });
        expect(empty).toEqual({ status: 'rejected', reason: 'appliesTo' });

        const duplicate = await mutateTriageAction({ settings: testkit.settings, mintActionId: () => 'a' }, {
            kind: 'create',
            label: 'Twice',
            enabled: true,
            appliesTo: ['issue', 'issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationToken: null, delivery: 'compose' },
        });
        expect(duplicate).toEqual({ status: 'rejected', reason: 'duplicateSubject' });
    });

    it('creates against the seed so the first user action does not delete Ask, Fix and Review', async () => {
        const testkit = createTestkitAccountSettings();

        const created = await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'minted-1',
        }, {
            kind: 'create',
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationToken: '/explain', delivery: 'send' },
        });

        expect(created.status).toBe('applied');
        if (created.status !== 'applied') return;
        expect(created.value.actions.map((action) => action.label)).toEqual([
            'Ask',
            'Fix',
            'Review',
            'Explain',
        ]);
        expect(created.value.actions[3]).toEqual({
            actionId: 'minted-1',
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationToken: '/explain', delivery: 'send' },
        });
    });

    it('renames, disables, deletes and reorders through the one writer', async () => {
        const testkit = createTestkitAccountSettings();
        const deps = { settings: testkit.settings, mintActionId: () => 'unused' };

        const renamed = await mutateTriageAction(deps, {
            kind: 'update',
            actionId: ASK.actionId,
            label: 'Discuss',
            enabled: false,
            appliesTo: [...ASK.appliesTo],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationToken: null, delivery: 'compose' },
        });
        expect(renamed.status).toBe('applied');
        if (renamed.status !== 'applied') return;
        expect(renamed.value.actions[0]?.label).toBe('Discuss');
        expect(renamed.value.actions[0]?.enabled).toBe(false);

        const reordered = await mutateTriageAction(deps, {
            kind: 'reorder',
            actionIds: [REVIEW.actionId, FIX.actionId, ASK.actionId],
        });
        expect(reordered.status).toBe('applied');
        if (reordered.status !== 'applied') return;
        expect(reordered.value.actions.map((action) => action.actionId)).toEqual([
            REVIEW.actionId,
            FIX.actionId,
            ASK.actionId,
        ]);

        const deleted = await mutateTriageAction(deps, { kind: 'delete', actionId: FIX.actionId });
        expect(deleted.status).toBe('applied');
        if (deleted.status !== 'applied') return;
        expect(deleted.value.actions.map((action) => action.actionId)).toEqual([
            REVIEW.actionId,
            ASK.actionId,
        ]);
    });

    it('refuses a reorder that is not an exact permutation of the stored set', async () => {
        const testkit = createTestkitAccountSettings();
        const deps = { settings: testkit.settings, mintActionId: () => 'unused' };

        // Dropping a member would delete it under the guise of reordering.
        expect(await mutateTriageAction(deps, {
            kind: 'reorder',
            actionIds: [ASK.actionId, FIX.actionId],
        })).toEqual({ status: 'rejected', reason: 'reorder' });

        expect(await mutateTriageAction(deps, {
            kind: 'reorder',
            actionIds: [ASK.actionId, ASK.actionId, FIX.actionId],
        })).toEqual({ status: 'rejected', reason: 'reorder' });
    });

    it('reports an unknown action rather than creating one', async () => {
        const testkit = createTestkitAccountSettings();
        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: 'not-a-stored-action' })).toEqual({ status: 'unknownAction' });
    });

    it('declines to overwrite a stored value it cannot read', async () => {
        const testkit = createTestkitAccountSettings();
        testkit.seed(TRIAGE_ACTIONS_SETTING_ID_V1, { v: 9 });

        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: ASK.actionId })).toEqual({ status: 'unreadable' });
    });

    it('reports the host revision conflict as itself', async () => {
        const testkit = createTestkitAccountSettings();
        // Another device writes between this owner's read and its write.
        testkit.armConcurrentWrite('unrelated.key', { touched: true });

        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: ASK.actionId })).toEqual({ status: 'conflict' });
    });

    it('refuses to grow past the catalog bound', async () => {
        const testkit = createTestkitAccountSettings();
        const full: TriageActionV1[] = [];
        for (let index = 0; index < MAX_TRIAGE_ACTIONS_V1; index += 1) {
            full.push({ ...ASK, actionId: `seeded-${index}`, label: `Action ${index}` });
        }
        testkit.seed(TRIAGE_ACTIONS_SETTING_ID_V1, storedFrom(full) as never);

        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'one-too-many',
        }, {
            kind: 'create',
            label: 'One too many',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationToken: null, delivery: 'compose' },
        })).toEqual({ status: 'rejected', reason: 'actionLimit' });
    });

    it('round-trips every written value through its own reader', async () => {
        const testkit = createTestkitAccountSettings();
        const written = await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'round-trip',
        }, {
            kind: 'create',
            label: 'Review with agent',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-3',
            workspaceMode: 'pull_request',
            target: { kind: 'agent', promptInvocationToken: '/review', delivery: 'compose' },
        });
        expect(written.status).toBe('applied');

        const read = await readTriageActions({ settings: testkit.settings });
        expect(read.kind).toBe('parsed');
        expect(read.value.actions.at(-1)).toEqual({
            actionId: 'round-trip',
            label: 'Review with agent',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-3',
            workspaceMode: 'pull_request',
            target: { kind: 'agent', promptInvocationToken: '/review', delivery: 'compose' },
        });
    });
});
