import { describe, expect, it } from 'vitest';

import { createTestkitAccountKv } from './testkit/accountKv.test-support.js';
import {
    MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1,
    TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1,
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
        expect(REVIEW.workspaceMode).toBe('pull_request');

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

    it('refuses incoherent subjects and formal-review materialization at the one writer', async () => {
        const testkit = createTestkitAccountKv();

        const empty = await mutateTriageAction({ catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'a' }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Nowhere',
            enabled: true,
            appliesTo: [],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
        expect(empty).toEqual({ status: 'rejected', reason: 'appliesTo' });

        const duplicate = await mutateTriageAction({ catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'a' }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Twice',
            enabled: true,
            appliesTo: ['issue', 'issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });
        expect(duplicate).toEqual({ status: 'rejected', reason: 'duplicateSubject' });

        const wrongReviewMode = await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'formal-review',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Formal review',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'reviewStart', promptInvocationId: '/review' },
        });
        expect(wrongReviewMode).toEqual({ status: 'rejected', reason: 'workspaceMode' });

        const wrongReviewSubject = await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'formal-review',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Formal review',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'pull_request',
            target: { kind: 'reviewStart', promptInvocationId: '/review' },
        });
        expect(wrongReviewSubject).toEqual({ status: 'rejected', reason: 'workspaceMode' });
    });

    it('creates against the seed so the first user action does not delete Ask, Fix and Review', async () => {
        const testkit = createTestkitAccountKv();

        const created = await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'minted-1',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
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

    it('admits a long single-line label while the canonical Account KV value still fits', async () => {
        const testkit = createTestkitAccountKv();
        const label = 'Explain '.repeat(512).trim();
        const created = await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'long-label',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label,
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        });

        expect(created).toMatchObject({ status: 'applied' });
        if (created.status === 'applied') {
            expect(created.value.actions.at(-1)?.label).toBe(label);
        }
    });

    it('renames, disables, deletes and reorders through the one writer', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };

        const renamed = await mutateTriageAction(deps, {
            kind: 'update',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
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
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            actionIds: [REVIEW.actionId, FIX.actionId, ASK.actionId],
        });
        expect(reordered.status).toBe('applied');
        if (reordered.status !== 'applied') return;
        expect(reordered.value.actions.map((action) => action.actionId)).toEqual([
            REVIEW.actionId,
            FIX.actionId,
            ASK.actionId,
        ]);

        const deleted = await mutateTriageAction(deps, { kind: 'delete', actionId: FIX.actionId, expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) });
        expect(deleted.status).toBe('applied');
        if (deleted.status !== 'applied') return;
        expect(deleted.value.actions.map((action) => action.actionId)).toEqual([
            REVIEW.actionId,
            ASK.actionId,
        ]);
    });

    it('refuses a reorder that is not an exact permutation of the stored set', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };

        // Dropping a member would delete it under the guise of reordering.
        expect(await mutateTriageAction(deps, {
            kind: 'reorder',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            actionIds: [ASK.actionId, FIX.actionId],
        })).toEqual({ status: 'rejected', reason: 'reorder' });

        expect(await mutateTriageAction(deps, {
            kind: 'reorder',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            actionIds: [ASK.actionId, ASK.actionId, FIX.actionId],
        })).toEqual({ status: 'rejected', reason: 'reorder' });
    });

    it('reports an unknown action rather than creating one', async () => {
        const testkit = createTestkitAccountKv();
        expect(await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: 'not-a-stored-action', expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) })).toEqual({ status: 'unknownAction' });
    });

    it('declines to overwrite a stored value it cannot read', async () => {
        const testkit = createTestkitAccountKv();
        testkit.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 9 });

        expect(await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: ASK.actionId, expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) })).toEqual({ status: 'unreadable' });
    });

    it('does not conflict when an unrelated Account KV key changes', async () => {
        const testkit = createTestkitAccountKv();
        // Account KV versions are per key. Moving another key must not make
        // this catalog inherit the old record-wide Settings conflict model.
        testkit.armConcurrentWrite('unrelated.key', { touched: true });

        expect(await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'unused',
        }, { kind: 'delete', actionId: ASK.actionId, expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }))
            .toMatchObject({ status: 'applied' });
    });

    it('admits a thirty-third action when the serialized Account KV value still fits', async () => {
        const testkit = createTestkitAccountKv();
        const full: TriageActionV1[] = [];
        for (let index = 0; index < 32; index += 1) {
            full.push({ ...ASK, actionId: `seeded-${index}`, label: `Action ${index}` });
        }
        testkit.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, storedFrom(full) as never);

        expect(await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'thirty-third',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Thirty third',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        })).toMatchObject({ status: 'applied', actionId: 'thirty-third' });
        expect((await readTriageActions({ catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) })).value.actions)
            .toHaveLength(33);
    });

    it('refuses growth only when the complete serialized Account KV value exceeds its byte bound', async () => {
        const testkit = createTestkitAccountKv();
        const deps = {
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: (() => {
                let index = 0;
                return () => `wide-action-${index++}`;
            })(),
        };
        let overflowed: string | null = null;

        for (let index = 0; index < 1_000; index += 1) {
            const result = await mutateTriageAction(deps, {
                kind: 'create',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
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
        const serialized = JSON.stringify(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1));
        expect(new TextEncoder().encode(serialized).byteLength)
            .toBeLessThanOrEqual(MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1);
    });

    it('round-trips every written value through its own reader', async () => {
        const testkit = createTestkitAccountKv();
        const written = await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'round-trip',
        }, {
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Review with agent',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-3',
            workspaceMode: 'pull_request',
            target: { kind: 'agent', promptInvocationId: '/review', delivery: 'compose' },
        });
        expect(written.status).toBe('applied');

        const read = await readTriageActions({ catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) });
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
        const testkit = createTestkitAccountKv();
        const opened = await readTriageActions({ catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) });

        // Another device configures the catalog while the editor is open.
        const other = await mutateTriageAction({
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
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
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'stale',
        }, {
            kind: 'delete',
            expectedRevision: opened.revision,
            actionId: ASK.actionId,
        });

        expect(stale).toEqual({ status: 'conflict' });
        // Nothing was written, and the other device's action is still there.
        const now = parseTriageActions(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1));
        expect(now.value.actions.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review', 'Triage']);
    });

    it('returns the revision an applied write landed on, so a second edit can name it', async () => {
        const testkit = createTestkitAccountKv();
        const opened = await readTriageActions({ catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) });
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };

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

});
