import type { SessionOrganizationSnapshotRequest } from '@happier-dev/protocol/sessions/organization/snapshot';

export function createSessionListOrganizationSnapshotRequest(): Partial<SessionOrganizationSnapshotRequest> {
    return {
        includeFolders: true,
        includeTags: true,
        includeLabels: true,
        includeAllFolderAssignments: true,
        includeAllTagAssignments: true,
        includeAttentionStandings: true,
        includeSessionAppearances: true,
        includeAttentionReminderTimes: true,
    };
}
