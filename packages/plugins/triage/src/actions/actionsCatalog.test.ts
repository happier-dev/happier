import { describe, expect, it } from 'vitest';

import { createTestkitAccountSettings } from '../settings/testkit/accountSettings.test-support.js';
import {
    TRIAGE_ACTIONS_SETTING_ID_V1,
    TRIAGE_DEFAULT_ACTIONS_V1,
} from '../settings/actions.js';
import {
    TriageAdministerActionInputV1Schema,
    TriageAdministerActionResultV1Schema,
    TriageReadActionsResultV1Schema,
} from './actionsCatalogProtocol.js';
import { administerTriageAction, readTriageActionsForSurface } from './actionsCatalog.js';

/**
 * The two catalog Actions, exercised through their own published schemas.
 *
 * The Settings service is the one genuine host boundary replaced; the parser,
 * the bounds, the closed vocabularies and the CAS decision underneath are the
 * real `settings/actions.ts`. Every value here crosses its own wire schema
 * rather than being asserted as a bare object, so a result the transport would
 * reject cannot be recorded as one that answered.
 */

describe('the configured-action Actions', () => {
    it('answers an absent catalog as the shipped seed rather than as an empty set', async () => {
        const testkit = createTestkitAccountSettings();

        const result = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { settings: testkit.settings }),
        );

        // `absent` and `parsed` are different answers and the surface needs
        // both: absent is showing the seed and the first write stores it.
        expect(result.availability).toBe('absent');
        expect(result.actions.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review']);
        // The runnable Review arm is explicit on the wire, so nothing
        // downstream infers it from a label.
        expect(result.actions[2]?.target)
            .toEqual({ kind: 'agent', promptInvocationId: null, delivery: 'compose' });
    });

    it('creates against the seed, so a first action does not delete the shipped three', async () => {
        const testkit = createTestkitAccountSettings();

        const input = TriageAdministerActionInputV1Schema.parse({
            v: 1,
            kind: 'create',
            expectedRevision: testkit.revision(),
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: '/explain', delivery: 'send' },
        });
        const applied = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(input, {
            settings: testkit.settings,
            mintActionId: () => 'minted-1',
        }));

        expect(applied.status).toBe('applied');
        expect(applied.actions?.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review', 'Explain']);

        // The seed became stored bytes on that first write, which is also the
        // moment the person first expressed an opinion about it.
        const read = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { settings: testkit.settings }),
        );
        expect(read.availability).toBe('parsed');
        expect(read.revision).toEqual(testkit.revision());
        expect(read.actions.at(-1)).toEqual({
            actionId: 'minted-1',
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: '/explain', delivery: 'send' },
        });
    });

    it('reorders as an exact permutation and refuses anything else', async () => {
        const testkit = createTestkitAccountSettings();
        const deps = { settings: testkit.settings, mintActionId: () => 'unused' };

        const reordered = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'reorder',
                expectedRevision: testkit.revision(),
                actionIds: ['review', 'ask', 'fix'],
            }),
            deps,
        ));
        expect(reordered.actions?.map((action) => action.actionId))
            .toEqual(['review', 'ask', 'fix']);

        // A shorter list would delete an action under the guise of reordering.
        const dropped = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'reorder',
                expectedRevision: testkit.revision(),
                actionIds: ['review', 'ask'],
            }),
            deps,
        ));
        expect(dropped).toEqual({ v: 1, status: 'rejected', reason: 'reorder' });
    });

    it('declines to overwrite a catalog this build cannot read', async () => {
        const testkit = createTestkitAccountSettings();
        testkit.seed(TRIAGE_ACTIONS_SETTING_ID_V1, { v: 9 });

        const read = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { settings: testkit.settings }),
        );
        // Not `absent`: reporting it as "you have configured nothing" is exactly
        // what would invite the next ordinary write to destroy it.
        expect(read.availability).toBe('unavailable');

        const refused = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'delete',
                expectedRevision: testkit.revision(),
                actionId: TRIAGE_DEFAULT_ACTIONS_V1[0]!.actionId,
            }),
            { settings: testkit.settings, mintActionId: () => 'unused' },
        ));
        expect(refused).toEqual({ v: 1, status: 'unreadable' });
        expect(testkit.read(TRIAGE_ACTIONS_SETTING_ID_V1)).toEqual({ v: 9 });
    });

    it('reports the host revision conflict as itself rather than as a failure', async () => {
        const testkit = createTestkitAccountSettings();
        // Another device writes between this owner's read and its write.
        testkit.armConcurrentWrite('unrelated.key', { touched: true });

        const result = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'delete',
                expectedRevision: testkit.revision(),
                actionId: 'ask',
            }),
            { settings: testkit.settings, mintActionId: () => 'unused' },
        ));

        expect(result).toEqual({ v: 1, status: 'conflict' });
    });
});
