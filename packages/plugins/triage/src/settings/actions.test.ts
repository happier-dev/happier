import { describe, expect, it } from 'vitest';

import { PluginSettingsAdministrationActionInputSchemasV1 } from '@happier-dev/protocol';

import { createTestkitAccountSettings } from './testkit/accountSettings.test-support.js';
import {
    MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1,
    MAX_TRIAGE_SETTINGS_REVISION_TOKEN_LENGTH_V1,
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
                ? { kind: 'reviewStart', promptInvocationId: action.target.promptInvocationId }
                : {
                    kind: 'agent',
                    promptInvocationId: action.target.promptInvocationId,
                    delivery: action.target.delivery,
                },
        })),
    };
}

describe('the Triage action record', () => {
    it('seeds only actions the current product can run when nothing has ever been written', () => {
        const read = parseTriageActions(undefined);

        expect(read.kind).toBe('absent');
        expect(read.value.actions).toEqual(TRIAGE_DEFAULT_ACTIONS_V1);
        // The seed is what a reader sees, not what the record holds: an absent
        // value must not need a write before the headline controls exist.
        expect(read.value.actions.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review']);
    });

    it('keeps an explicitly emptied catalog empty rather than restoring the seed', () => {
        const read = parseTriageActions({ v: 1, actions: [] });

        expect(read.kind).toBe('parsed');
        expect(read.value.actions).toEqual([]);
    });

    it('answers the five configured questions and states both Review arms explicitly', () => {
        expect(ASK.workspaceMode).toBe('reference_only');
        expect(FIX.workspaceMode).toBe('repository');
        expect(REVIEW.workspaceMode).toBe('repository');

        // Neither Review is inferred from its label: the arm is a member, and
        // the two arms are two different user actions that ship side by side.
        expect(REVIEW.target)
            .toEqual({ kind: 'agent', promptInvocationId: null, delivery: 'compose' });
        expect(ASK.target).toEqual({ kind: 'agent', promptInvocationId: null, delivery: 'compose' });

        // Only a pull request reaches either review action.
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
            expectedRevision: testkit.revision(),
            label: 'Nowhere',
            enabled: true,
            appliesTo: [],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
        expect(empty).toEqual({ status: 'rejected', reason: 'appliesTo' });

        const duplicate = await mutateTriageAction({ settings: testkit.settings, mintActionId: () => 'a' }, {
            kind: 'create',
            expectedRevision: testkit.revision(),
            label: 'Twice',
            enabled: true,
            appliesTo: ['issue', 'issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
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
            expectedRevision: testkit.revision(),
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: '/explain', delivery: 'send' },
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
            target: { kind: 'agent', promptInvocationId: '/explain', delivery: 'send' },
        });
    });

    it('renames, disables, deletes and reorders through the one writer', async () => {
        const testkit = createTestkitAccountSettings();
        const deps = { settings: testkit.settings, mintActionId: () => 'unused' };

        const renamed = await mutateTriageAction(deps, {
            kind: 'update',
            expectedRevision: testkit.revision(),
            actionId: ASK.actionId,
            label: 'Discuss',
            enabled: false,
            appliesTo: [...ASK.appliesTo],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
        expect(renamed.status).toBe('applied');
        if (renamed.status !== 'applied') return;
        expect(renamed.value.actions[0]?.label).toBe('Discuss');
        expect(renamed.value.actions[0]?.enabled).toBe(false);

        const reordered = await mutateTriageAction(deps, {
            kind: 'reorder',
            expectedRevision: testkit.revision(),
            actionIds: [REVIEW.actionId, FIX.actionId, ASK.actionId],
        });
        expect(reordered.status).toBe('applied');
        if (reordered.status !== 'applied') return;
        expect(reordered.value.actions.map((action) => action.actionId)).toEqual([
            REVIEW.actionId,
            FIX.actionId,
            ASK.actionId,
        ]);

        const deleted = await mutateTriageAction(deps, { kind: 'delete', actionId: FIX.actionId, expectedRevision: testkit.revision() });
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
            expectedRevision: testkit.revision(),
            actionIds: [ASK.actionId, FIX.actionId],
        })).toEqual({ status: 'rejected', reason: 'reorder' });

        expect(await mutateTriageAction(deps, {
            kind: 'reorder',
            expectedRevision: testkit.revision(),
            actionIds: [ASK.actionId, ASK.actionId, FIX.actionId],
        })).toEqual({ status: 'rejected', reason: 'reorder' });
    });

    it('reports an unknown action rather than creating one', async () => {
        const testkit = createTestkitAccountSettings();
        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: 'not-a-stored-action', expectedRevision: testkit.revision() })).toEqual({ status: 'unknownAction' });
    });

    it('declines to overwrite a stored value it cannot read', async () => {
        const testkit = createTestkitAccountSettings();
        testkit.seed(TRIAGE_ACTIONS_SETTING_ID_V1, { v: 9 });

        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: ASK.actionId, expectedRevision: testkit.revision() })).toEqual({ status: 'unreadable' });
    });

    it('reports the host revision conflict as itself', async () => {
        const testkit = createTestkitAccountSettings();
        // Another device writes between this owner's read and its write.
        testkit.armConcurrentWrite('unrelated.key', { touched: true });

        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: ASK.actionId, expectedRevision: testkit.revision() })).toEqual({ status: 'conflict' });
    });

    it('admits a thirty-third action when the serialized Settings value still fits', async () => {
        const testkit = createTestkitAccountSettings();
        const full: TriageActionV1[] = [];
        for (let index = 0; index < 32; index += 1) {
            full.push({ ...ASK, actionId: `seeded-${index}`, label: `Action ${index}` });
        }
        testkit.seed(TRIAGE_ACTIONS_SETTING_ID_V1, storedFrom(full) as never);

        expect(await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'thirty-third',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(),
            label: 'Thirty third',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        })).toMatchObject({ status: 'applied', actionId: 'thirty-third' });
        expect((await readTriageActions({ settings: testkit.settings })).value.actions)
            .toHaveLength(33);
    });

    it('refuses growth only when the complete serialized Settings value exceeds its byte bound', async () => {
        const testkit = createTestkitAccountSettings();
        const deps = {
            settings: testkit.settings,
            mintActionId: (() => {
                let index = 0;
                return () => `wide-action-${index++}`;
            })(),
        };
        let overflowed: string | null = null;

        for (let index = 0; index < 1_000; index += 1) {
            const result = await mutateTriageAction(deps, {
                kind: 'create',
                expectedRevision: testkit.revision(),
                label: `Action ${index}`,
                enabled: true,
                appliesTo: ['pullRequest', 'issue', 'errorIssue', 'other'],
                profileId: `profile-${'p'.repeat(240)}-${index}`,
                workspaceMode: 'repository',
                target: { kind: 'agent', promptInvocationId: `prompt-${index}`, delivery: 'compose' },
            });
            if (result.status === 'rejected') {
                overflowed = result.reason;
                break;
            }
        }

        expect(overflowed).toBe('valueTooLarge');
        const serialized = JSON.stringify(testkit.read(TRIAGE_ACTIONS_SETTING_ID_V1));
        expect(new TextEncoder().encode(serialized).byteLength)
            .toBeLessThanOrEqual(MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1);
    });

    it('round-trips every written value through its own reader', async () => {
        const testkit = createTestkitAccountSettings();
        const written = await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'round-trip',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(),
            label: 'Review with agent',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-3',
            workspaceMode: 'pull_request',
            target: { kind: 'agent', promptInvocationId: '/review', delivery: 'compose' },
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
            target: { kind: 'agent', promptInvocationId: '/review', delivery: 'compose' },
        });
    });
});

describe('the caller-observed revision', () => {
    /**
     * Re-reading immediately before the write and CASing against THAT revision
     * makes the final `set` atomic and nothing more. It cannot notice a change
     * made while somebody had the editor open, because the value it compares is
     * read after that change landed. These are the tests for the window the
     * host cannot see.
     */
    it('refuses a write formed against a catalog that has since moved', async () => {
        const testkit = createTestkitAccountSettings();
        const opened = await readTriageActions({ settings: testkit.settings });

        // Another device configures the catalog while the editor is open.
        const other = await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'other-device',
        }, {
            kind: 'create',
            expectedRevision: opened.revision,
            label: 'Triage',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
        expect(other.status).toBe('applied');

        const stale = await mutateTriageAction({
            settings: testkit.settings,
            mintActionId: () => 'stale',
        }, {
            kind: 'delete',
            expectedRevision: opened.revision,
            actionId: ASK.actionId,
        });

        expect(stale).toEqual({ status: 'conflict' });
        // Nothing was written, and the other device's action is still there.
        const now = parseTriageActions(testkit.read(TRIAGE_ACTIONS_SETTING_ID_V1));
        expect(now.value.actions.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review', 'Triage']);
    });

    it('returns the revision an applied write landed on, so a second edit can name it', async () => {
        const testkit = createTestkitAccountSettings();
        const opened = await readTriageActions({ settings: testkit.settings });
        const deps = { settings: testkit.settings, mintActionId: () => 'unused' };

        const first = await mutateTriageAction(deps, {
            kind: 'update',
            expectedRevision: opened.revision,
            actionId: ASK.actionId,
            label: 'Discuss',
            enabled: true,
            appliesTo: ASK.appliesTo,
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
        expect(first.status).toBe('applied');
        if (first.status !== 'applied') return;
        expect(first.revision).not.toEqual(opened.revision);

        // The revision the write landed on is enough for the next one: an
        // editor that had to re-read between two edits would race itself.
        const second = await mutateTriageAction(deps, {
            kind: 'delete',
            expectedRevision: first.revision,
            actionId: FIX.actionId,
        });
        expect(second.status).toBe('applied');
    });

    it('bounds the revision token at the canonical Settings-administration length', () => {
        // Not a picked number: the same token on the incumbent settings
        // administration Action is bounded by that owner, and this is a
        // projection of it. If that owner moves, this fails rather than drifts.
        const setSchema = PluginSettingsAdministrationActionInputSchemasV1['plugins.settings.set'];
        const base = {
            scope: { kind: 'account' as const },
            target: { kind: 'account' as const },
            pluginId: 'triage',
            contributionId: 'actions',
            fieldId: TRIAGE_ACTIONS_SETTING_ID_V1,
            value: { v: 1 },
        };
        const atBound = setSchema.safeParse({
            ...base,
            expectedRevision: 'r'.repeat(MAX_TRIAGE_SETTINGS_REVISION_TOKEN_LENGTH_V1),
        });
        const overBound = setSchema.safeParse({
            ...base,
            expectedRevision: 'r'.repeat(MAX_TRIAGE_SETTINGS_REVISION_TOKEN_LENGTH_V1 + 1),
        });

        // The owner may refuse either payload for its own unrelated reasons, so
        // the assertion is on the DIFFERENCE the length makes, not on success.
        const atBoundRevisionIssue = atBound.success
            ? false
            : atBound.error.issues.some((issue) => issue.path[0] === 'expectedRevision');
        const overBoundRevisionIssue = overBound.success
            ? false
            : overBound.error.issues.some((issue) => issue.path[0] === 'expectedRevision');
        expect(atBoundRevisionIssue).toBe(false);
        expect(overBoundRevisionIssue).toBe(true);
    });
});
