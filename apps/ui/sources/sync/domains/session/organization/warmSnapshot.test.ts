import { describe, expect, it } from 'vitest';

import { buildSessionOrganizationProjection } from './projection';
import type { NormalizedSessionOrganizationState } from './types';
import { buildSessionOrganizationSnapshotFromProjection } from './warmSnapshot';

const SERVER_ID = 'server-a';

function buildNormalizedState(
    overrides?: Partial<NormalizedSessionOrganizationState>,
): NormalizedSessionOrganizationState {
    return {
        schemaVersionByServerId: { [SERVER_ID]: 1 },
        snapshotVersionByServerId: { [SERVER_ID]: 7 },
        pinsBySessionKey: {
            [`${SERVER_ID}:s1`]: { sessionId: 's1', sortKey: '00000001', pinnedAt: 10 },
        },
        foldersByFolderKey: {
            [`${SERVER_ID}:f1`]: {
                folderId: 'f1',
                folderKey: 'folder-key-1',
                parentFolderId: null,
                parentFolderKey: null,
                sortKey: '00000001',
                display: { t: 'plain', v: { name: 'Work' } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 2,
            },
        },
        folderAssignmentsBySessionKey: {
            [`${SERVER_ID}:s1`]: 'f1',
            [`${SERVER_ID}:s2`]: null,
        },
        tagsByTagKey: {
            [`${SERVER_ID}:t1`]: {
                tagId: 't1',
                tagKey: 'tag-key-1',
                sortKey: null,
                display: { t: 'plain', v: { label: 'Urgent' } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 2,
            },
        },
        tagAssignmentsBySessionKey: {
            [`${SERVER_ID}:s1`]: ['t1'],
        },
        attentionStandingsBySessionKey: {
            [`${SERVER_ID}:s1`]: { sessionId: 's1', standing: true, updatedAt: 20 },
            [`${SERVER_ID}:s2`]: { sessionId: 's2', standing: false, updatedAt: 21 },
        },
        orderEntriesByScopeKey: {
            [`${SERVER_ID}:group:pinned`]: [
                { scopeKind: 'group', scopeKey: 'pinned', itemKind: 'session', itemKey: 's1', sortKey: '00000001' },
            ],
        },
        labelsByLabelKey: {
            [`${SERVER_ID}:group:pinned`]: {
                labelKind: 'group',
                scopeKey: 'pinned',
                display: { t: 'plain', v: { label: 'Pinned' } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 2,
            },
        },
        ...overrides,
    };
}

describe('buildSessionOrganizationSnapshotFromProjection', () => {
    it('rebuilds the complete organization snapshot a warm boot has to repaint from', () => {
        const projection = buildSessionOrganizationProjection(buildNormalizedState(), SERVER_ID);

        const snapshot = buildSessionOrganizationSnapshotFromProjection(projection);

        expect(snapshot).toEqual({
            schemaVersion: 1,
            version: 7,
            pins: [{ sessionId: 's1', sortKey: '00000001', pinnedAt: 10 }],
            folders: [expect.objectContaining({ folderId: 'f1', display: { t: 'plain', v: { name: 'Work' } } })],
            folderAssignments: [{ sessionId: 's1', folderId: 'f1' }],
            tags: [expect.objectContaining({ tagId: 't1' })],
            tagAssignments: [{ sessionId: 's1', tagIds: ['t1'] }],
            orderEntries: [
                { scopeKind: 'group', scopeKey: 'pinned', itemKind: 'session', itemKey: 's1', sortKey: '00000001' },
            ],
            labels: [expect.objectContaining({ labelKind: 'group', scopeKey: 'pinned' })],
            attentionStandings: [
                { sessionId: 's1', standing: true, updatedAt: 20 },
                { sessionId: 's2', standing: false, updatedAt: 21 },
            ],
        });
    });

    it('carries both polarities of an attention standing so a warm boot repaints the same attention section', () => {
        const projection = buildSessionOrganizationProjection(buildNormalizedState(), SERVER_ID);

        const snapshot = buildSessionOrganizationSnapshotFromProjection(projection);

        expect(snapshot?.attentionStandings).toEqual([
            { sessionId: 's1', standing: true, updatedAt: 20 },
            { sessionId: 's2', standing: false, updatedAt: 21 },
        ]);
    });

    it('omits unassigned sessions instead of persisting an assignment the protocol cannot express', () => {
        const projection = buildSessionOrganizationProjection(buildNormalizedState(), SERVER_ID);

        const snapshot = buildSessionOrganizationSnapshotFromProjection(projection);

        expect(snapshot?.folderAssignments.map((assignment) => assignment.sessionId)).toEqual(['s1']);
    });

    it('returns null when no snapshot version has been observed for the server yet', () => {
        const projection = buildSessionOrganizationProjection(
            buildNormalizedState({ snapshotVersionByServerId: {} }),
            SERVER_ID,
        );

        expect(buildSessionOrganizationSnapshotFromProjection(projection)).toBeNull();
    });

    it('returns null when the observed schema version is not the supported snapshot version', () => {
        const projection = buildSessionOrganizationProjection(
            buildNormalizedState({ schemaVersionByServerId: { [SERVER_ID]: 2 } }),
            SERVER_ID,
        );

        expect(buildSessionOrganizationSnapshotFromProjection(projection)).toBeNull();
    });
});
