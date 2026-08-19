import type {
    SessionAttentionStanding,
    SessionOrganizationFolder,
    SessionOrganizationLabel,
    SessionOrganizationOrderEntry,
    SessionOrganizationPin,
    SessionOrganizationSnapshot,
    SessionOrganizationSnapshotRequest,
    SessionOrganizationTag,
} from '@happier-dev/protocol';

export type SessionOrganizationFolderAssignmentValue = string | null;

export type NormalizedSessionOrganizationState = Readonly<{
    schemaVersionByServerId: Readonly<Record<string, number>>;
    snapshotVersionByServerId: Readonly<Record<string, number>>;
    pinsBySessionKey: Readonly<Record<string, SessionOrganizationPin>>;
    foldersByFolderKey: Readonly<Record<string, SessionOrganizationFolder>>;
    folderAssignmentsBySessionKey: Readonly<Record<string, SessionOrganizationFolderAssignmentValue>>;
    tagsByTagKey: Readonly<Record<string, SessionOrganizationTag>>;
    tagAssignmentsBySessionKey: Readonly<Record<string, readonly string[]>>;
    attentionStandingsBySessionKey: Readonly<Record<string, SessionAttentionStanding>>;
    orderEntriesByScopeKey: Readonly<Record<string, readonly SessionOrganizationOrderEntry[]>>;
    labelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>>;
}>;

export type SessionOrganizationSnapshotApplyOptions = Partial<Pick<
    SessionOrganizationSnapshotRequest,
    | 'includeFolders'
    | 'includeTags'
    | 'includeLabels'
    | 'includeAllFolderAssignments'
    | 'includeAllTagAssignments'
    | 'assignmentSessionIds'
    | 'folderIds'
    | 'tagIds'
    | 'orderScopes'
>>;

export type SessionOrganizationProjection = Readonly<{
    schemaVersion: number | null;
    version: number | null;
    pinnedSessionIds: readonly string[];
    pinsBySessionId: Readonly<Record<string, SessionOrganizationPin>>;
    foldersById: Readonly<Record<string, SessionOrganizationFolder>>;
    folderAssignmentsBySessionId: Readonly<Record<string, SessionOrganizationFolderAssignmentValue>>;
    tagsById: Readonly<Record<string, SessionOrganizationTag>>;
    tagAssignmentsBySessionId: Readonly<Record<string, readonly string[]>>;
    attentionStandingsBySessionId: Readonly<Record<string, SessionAttentionStanding>>;
    orderEntriesByScopeKey: Readonly<Record<string, readonly SessionOrganizationOrderEntry[]>>;
    labelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>>;
}>;
