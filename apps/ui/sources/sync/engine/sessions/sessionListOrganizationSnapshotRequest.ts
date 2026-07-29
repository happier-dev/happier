import type { SessionOrganizationSnapshotRequest } from '@happier-dev/protocol';

export function createSessionListOrganizationSnapshotRequest(): Partial<SessionOrganizationSnapshotRequest> {
    return {
        includeFolders: true,
        includeTags: true,
        includeLabels: true,
        includeAllFolderAssignments: true,
        includeAllTagAssignments: true,
    };
}
