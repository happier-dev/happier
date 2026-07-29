import { describe, expect, it } from 'vitest';

import { buildSessionOrganizationProjection } from './projection';

describe('buildSessionOrganizationProjection', () => {
    it('projects only the requested server organization state in pinned order', () => {
        const projection = buildSessionOrganizationProjection({
            schemaVersionByServerId: { 'server-a': 1 },
            snapshotVersionByServerId: { 'server-a': 9 },
            pinsBySessionKey: {
                'server-a:s2': { sessionId: 's2', sortKey: '0002', pinnedAt: 20 },
                'server-a:s1': { sessionId: 's1', sortKey: '0001', pinnedAt: 10 },
                'server-b:s3': { sessionId: 's3', sortKey: '0000', pinnedAt: 1 },
            },
            foldersByFolderKey: {
                'server-a:folder-a': {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: null,
                    display: null,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionKey: { 'server-a:s1': 'folder-a' },
            tagsByTagKey: {},
            tagAssignmentsBySessionKey: { 'server-a:s1': ['tag-a'] },
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        }, 'server-a');

        expect(projection.schemaVersion).toBe(1);
        expect(projection.version).toBe(9);
        expect(projection.pinnedSessionIds).toEqual(['s1', 's2']);
        expect(projection.folderAssignmentsBySessionId).toEqual({ s1: 'folder-a' });
        expect(projection.tagAssignmentsBySessionId).toEqual({ s1: ['tag-a'] });
        expect(projection.pinsBySessionId.s3).toBeUndefined();
    });
});
