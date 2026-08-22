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

export type SessionOrganizationDisplayState =
    | Readonly<{
        status: 'available';
        value: unknown | null;
    }>
    | Readonly<{
        status: 'locked';
        reason:
            | 'account_key_unavailable'
            | 'content_unreadable'
            | 'invalid_stored_display'
            | 'storage_mode_mismatch';
    }>;

export type UiSessionOrganizationFolder = Omit<SessionOrganizationFolder, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationTag = Omit<SessionOrganizationTag, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationLabel = Omit<SessionOrganizationLabel, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationSnapshot = Omit<
    SessionOrganizationSnapshot,
    'folders' | 'tags' | 'labels'
> & Readonly<{
    folders: UiSessionOrganizationFolder[];
    tags: UiSessionOrganizationTag[];
    labels: UiSessionOrganizationLabel[];
}>;

export type NormalizedSessionOrganizationState = Readonly<{
    schemaVersionByServerId: Readonly<Record<string, number>>;
    snapshotVersionByServerId: Readonly<Record<string, number>>;
    pinsBySessionKey: Readonly<Record<string, SessionOrganizationPin>>;
    foldersByFolderKey: Readonly<Record<string, UiSessionOrganizationFolder>>;
    folderAssignmentsBySessionKey: Readonly<Record<string, SessionOrganizationFolderAssignmentValue>>;
    tagsByTagKey: Readonly<Record<string, UiSessionOrganizationTag>>;
    tagAssignmentsBySessionKey: Readonly<Record<string, readonly string[]>>;
    attentionStandingsBySessionKey: Readonly<Record<string, SessionAttentionStanding>>;
    orderEntriesByScopeKey: Readonly<Record<string, readonly SessionOrganizationOrderEntry[]>>;
    labelsByLabelKey: Readonly<Record<string, UiSessionOrganizationLabel>>;
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
    foldersById: Readonly<Record<string, UiSessionOrganizationFolder>>;
    folderAssignmentsBySessionId: Readonly<Record<string, SessionOrganizationFolderAssignmentValue>>;
    tagsById: Readonly<Record<string, UiSessionOrganizationTag>>;
    tagAssignmentsBySessionId: Readonly<Record<string, readonly string[]>>;
    attentionStandingsBySessionId: Readonly<Record<string, SessionAttentionStanding>>;
    orderEntriesByScopeKey: Readonly<Record<string, readonly SessionOrganizationOrderEntry[]>>;
    labelsByLabelKey: Readonly<Record<string, UiSessionOrganizationLabel>>;
}>;
