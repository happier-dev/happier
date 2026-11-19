import type {
    SessionAttentionStanding} from '@happier-dev/protocol/sessions/organization/standings';
import type {
    SessionOrganizationFolder} from '@happier-dev/protocol/sessions/organization/folders';
import type {
    SessionOrganizationLabel,
    SessionOrganizationOrderEntry} from '@happier-dev/protocol/sessions/organization/ordering';
import type {
    SessionOrganizationPin} from '@happier-dev/protocol/sessions/organization/pins';
import type {
    SessionOrganizationSnapshot,
    SessionOrganizationSnapshotRequest} from '@happier-dev/protocol/sessions/organization/snapshot';
import type {
    SessionOrganizationTag,
} from '@happier-dev/protocol/sessions/organization/tags';
import type { SessionOrganizationOpenedDisplayStateV1 } from '@happier-dev/protocol/sessions/organization/folders';
import type { SessionOrganizationSessionAppearance } from '@happier-dev/protocol/sessions/organization/appearances';
import type { SessionAppearanceColor } from './appearanceColor';

export type SessionOrganizationFolderAssignmentValue = string | null;
export type SessionOrganizationFolderAssignmentEntry = Readonly<{
    sessionId: string;
    folderId: SessionOrganizationFolderAssignmentValue;
}>;
export type SessionOrganizationTagAssignmentEntry = Readonly<{
    sessionId: string;
    tagIds: readonly string[];
}>;

export type SessionOrganizationDisplayState = SessionOrganizationOpenedDisplayStateV1;

export type UiSessionOrganizationFolder = Omit<SessionOrganizationFolder, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationTag = Omit<SessionOrganizationTag, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationLabel = Omit<SessionOrganizationLabel, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationSessionAppearance = Omit<SessionOrganizationSessionAppearance, 'displayState'> & Readonly<{
    displayState: SessionOrganizationDisplayState;
}>;

export type UiSessionOrganizationSnapshot = Omit<
    SessionOrganizationSnapshot,
    'folders' | 'tags' | 'labels' | 'sessionAppearances'
> & Readonly<{
    folders: UiSessionOrganizationFolder[];
    tags: UiSessionOrganizationTag[];
    labels: UiSessionOrganizationLabel[];
    sessionAppearances?: UiSessionOrganizationSessionAppearance[];
}>;

export type NormalizedSessionOrganizationState = Readonly<{
    schemaVersionByServerId: Readonly<Record<string, number>>;
    snapshotVersionByServerId: Readonly<Record<string, number>>;
    folderAssignmentsCompleteByServerId?: Readonly<Record<string, boolean>>;
    pinsBySessionKey: Readonly<Record<string, SessionOrganizationPin>>;
    foldersByFolderKey: Readonly<Record<string, UiSessionOrganizationFolder>>;
    folderAssignmentsBySessionKey: Readonly<Record<string, SessionOrganizationFolderAssignmentEntry>>;
    tagsByTagKey: Readonly<Record<string, UiSessionOrganizationTag>>;
    tagAssignmentsBySessionKey: Readonly<Record<string, SessionOrganizationTagAssignmentEntry>>;
    attentionStandingsBySessionKey: Readonly<Record<string, SessionAttentionStanding>>;
    appearancesBySessionKey: Readonly<Record<string, UiSessionOrganizationSessionAppearance>>;
    sessionAppearancesSupportedByServerId: Readonly<Record<string, boolean>>;
    orderEntriesByScopeKey: Readonly<Record<string, readonly SessionOrganizationOrderEntry[]>>;
    labelsByLabelKey: Readonly<Record<string, UiSessionOrganizationLabel>>;
}>;

export type SessionOrganizationSnapshotApplyOptions = Partial<Pick<
    SessionOrganizationSnapshotRequest,
    | 'includeFolders'
    | 'includeTags'
    | 'includeLabels'
    | 'includeSessionAppearances'
    | 'includeAllFolderAssignments'
    | 'includeAllTagAssignments'
    | 'assignmentSessionIds'
    | 'entityKind'
    | 'folderIds'
    | 'tagIds'
    | 'orderScopes'
>>;

export type SessionOrganizationProjection = Readonly<{
    schemaVersion: number | null;
    version: number | null;
    /** False/absent is unknown coverage, not evidence of zero members. */
    folderAssignmentsComplete?: boolean;
    /** One personal order shared by list and rail membership, including retained demoted choices. */
    orderedPinSessionIds: readonly string[];
    pinnedSessionIds: readonly string[];
    railPinnedSessionIds: readonly string[];
    pinsBySessionId: Readonly<Record<string, SessionOrganizationPin>>;
    foldersById: Readonly<Record<string, UiSessionOrganizationFolder>>;
    folderAssignmentsBySessionId: Readonly<Record<string, SessionOrganizationFolderAssignmentValue>>;
    tagsById: Readonly<Record<string, UiSessionOrganizationTag>>;
    tagAssignmentsBySessionId: Readonly<Record<string, readonly string[]>>;
    attentionStandingsBySessionId: Readonly<Record<string, SessionAttentionStanding>>;
    appearancesBySessionId: Readonly<Record<string, SessionAppearanceColor>>;
    sessionAppearancesBySessionId: Readonly<Record<string, UiSessionOrganizationSessionAppearance>>;
    sessionAppearancesSupported: boolean;
    orderEntriesByScopeKey: Readonly<Record<string, readonly SessionOrganizationOrderEntry[]>>;
    labelsByLabelKey: Readonly<Record<string, UiSessionOrganizationLabel>>;
}>;
