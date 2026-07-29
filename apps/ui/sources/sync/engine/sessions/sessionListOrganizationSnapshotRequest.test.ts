import { describe, expect, it } from 'vitest';

import { createSessionListOrganizationSnapshotRequest } from './sessionListOrganizationSnapshotRequest';

describe('createSessionListOrganizationSnapshotRequest', () => {
    it('requests the organization data needed to project the first session list after reload', () => {
        expect(createSessionListOrganizationSnapshotRequest()).toEqual({
            includeFolders: true,
            includeTags: true,
            includeLabels: true,
            includeAllFolderAssignments: true,
            includeAllTagAssignments: true,
        });
    });
});
