import { describe, expect, it } from 'vitest';

import type { SessionOrganizationProjection } from './types';
import { listSessionOrganizationRequiredHydrationSessionIds } from './requiredHydration';

function projection(overrides: Partial<SessionOrganizationProjection>): SessionOrganizationProjection {
    return {
        schemaVersion: 1,
        version: 4,
        pinnedSessionIds: [],
        pinsBySessionId: {},
        foldersById: {},
        folderAssignmentsBySessionId: {},
        tagsById: {},
        tagAssignmentsBySessionId: {},
        attentionStandingsBySessionId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
        ...overrides,
    };
}

describe('listSessionOrganizationRequiredHydrationSessionIds', () => {
    it('requires the row of a session the user explicitly kept in Needs attention', () => {
        const ids = listSessionOrganizationRequiredHydrationSessionIds(projection({
            attentionStandingsBySessionId: {
                's_kept': { sessionId: 's_kept', standing: true, updatedAt: 1 },
            },
        }));

        expect(ids).toEqual(['s_kept']);
    });

    it('does not require the row of a session the user explicitly removed from Needs attention', () => {
        const ids = listSessionOrganizationRequiredHydrationSessionIds(projection({
            attentionStandingsBySessionId: {
                's_removed': { sessionId: 's_removed', standing: false, updatedAt: 1 },
            },
        }));

        expect(ids).toEqual([]);
    });

    it('unions pinned and explicitly kept sessions without duplicating an id in both', () => {
        const ids = listSessionOrganizationRequiredHydrationSessionIds(projection({
            pinnedSessionIds: ['s_pinned', 's_both'],
            attentionStandingsBySessionId: {
                's_both': { sessionId: 's_both', standing: true, updatedAt: 1 },
                's_kept': { sessionId: 's_kept', standing: true, updatedAt: 2 },
            },
        }));

        expect(ids).toEqual(['s_pinned', 's_both', 's_kept']);
    });

    it('requires nothing before an organization snapshot has been observed', () => {
        const ids = listSessionOrganizationRequiredHydrationSessionIds(projection({
            version: null,
            pinnedSessionIds: ['s_pinned'],
            attentionStandingsBySessionId: {
                's_kept': { sessionId: 's_kept', standing: true, updatedAt: 1 },
            },
        }));

        expect(ids).toEqual([]);
    });
});
