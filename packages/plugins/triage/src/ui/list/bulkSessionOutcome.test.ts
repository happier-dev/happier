import { describe, expect, it } from 'vitest';

import {
    isTriageBulkEntryOutcomeIncompleteV1,
    projectTriageBulkEntryOutcomesV1,
    projectTriageBulkSeedOutcomesV1,
    summarizeTriageBulkSettlementV1,
} from './bulkSessionOutcome.js';

describe('bulk per-entry settlement', () => {
    const entries = [
        {
            entryRef: {
                source: { pluginId: 'happier.test', localId: 'entries' },
                kindId: 'issue',
                collisionScope: 'example',
                entryId: '17',
            },
        },
        {
            entryRef: {
                source: { pluginId: 'happier.test', localId: 'entries' },
                kindId: 'issue',
                collisionScope: 'example',
                entryId: '18',
            },
        },
    ];

    it('does not hide a secondary link failure behind a created Session and accepted send', () => {
        const outcomes = projectTriageBulkEntryOutcomesV1({
            entries,
            start: {
                v: 1,
                type: 'opened',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'accepted',
            },
            secondaryLinks: ['conflictedOrUnavailable'],
            compose: 'notRequested',
        });

        expect(outcomes.map((outcome) => outcome.link)).toEqual([
            'created',
            'conflictedOrUnavailable',
        ]);
        expect(outcomes.map((outcome) => outcome.attachment)).toEqual(['carried', 'carried']);
        expect(outcomes.map((outcome) => outcome.directSend)).toEqual(['applied', 'applied']);
        expect(outcomes.map(isTriageBulkEntryOutcomeIncompleteV1)).toEqual([false, true]);
    });

    it('reports a New Session seed refusal for every selected entry', () => {
        expect(projectTriageBulkSeedOutcomesV1(entries, 'refused').map((outcome) => ({
            attachment: outcome.attachment,
            seed: outcome.newSessionSeed,
        }))).toEqual([
            { attachment: 'refused', seed: 'refused' },
            { attachment: 'refused', seed: 'refused' },
        ]);
    });

    it('does not report an answered creation failure as a started Session', () => {
        const failed = projectTriageBulkEntryOutcomesV1({
            entries: [entries[0]!],
            start: {
                v: 1,
                type: 'creationFailed',
            },
            secondaryLinks: [],
            compose: 'notRequested',
        });
        const pending = projectTriageBulkEntryOutcomesV1({
            entries: [entries[1]!],
            start: {
                v: 1,
                type: 'creationPending',
                outcome: 'unknown',
            },
            secondaryLinks: [],
            compose: 'notRequested',
        });

        expect(summarizeTriageBulkSettlementV1({
            results: [
                { status: 'settled', outcome: { start: {
                    v: 1,
                    type: 'creationFailed',
                }, entries: failed } },
                { status: 'settled', outcome: { start: {
                    v: 1,
                    type: 'creationPending',
                    outcome: 'unknown',
                }, entries: pending } },
            ],
            unavailableCount: 0,
            refusalCount: 0,
        })).toEqual({ opened: 0, unknown: 1, notStarted: 1, left: 0 });
    });
});
