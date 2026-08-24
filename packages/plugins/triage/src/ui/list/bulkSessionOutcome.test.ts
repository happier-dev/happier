import { describe, expect, it } from 'vitest';

import {
    isTriageBulkEntryOutcomeIncompleteV1,
    projectTriageBulkEntryOutcomesV1,
    projectTriageBulkSeedOutcomesV1,
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
});
