import type { SessionPublicationSource } from '../domains/session/sessionRuntimeObservation';
import type { SessionModelOptionsContext } from '@/sync/domains/models/modelOptions';
import type { TodoState } from '@/sync/domains/todos/todoOps';

import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import type { FeedItem } from '../domains/social/feedTypes';
import type { RelationshipUpdatedEvent, UserProfile } from '../domains/social/friendTypes';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { Session, Machine, ScmStatus, ScmWorkingSnapshot } from '../domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '../domains/state/storageTypes';
import type { PermissionMode } from '../domains/permissions/permissionTypes';
import type { WorkflowRunsDomain } from './domains/workflowRuns';
import type { AutomationsDomain } from './domains/automations';
import type { Profile } from '../domains/profiles/profile';
import type { Purchases } from '../domains/purchases/purchases';
import type { AccountPetMetadata } from '../domains/pets/accountPetLibraryTypes';
import type { LocalPetSourceMetadata } from '../domains/pets/localPetSourceTypes';
import type { Settings } from '../domains/settings/settings';
import type { AuthoringMemoryDomain } from './domains/authoringMemory';
import type { AccountSettingsSyncStatus } from '../domains/settings/accountSettingsSyncStatus';
import type { AccountSettingsScope } from '../domains/settings/scope/accountSettingsScope';
import type { ServerAccountScope } from '../domains/scope/serverAccountScope';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '../domains/session/listing/concurrentSessionListCache';
import type { SessionListQueryMembership } from '../domains/session/listing/sessionListQueryController';
import type { SessionListIndexItem } from '../domains/sessionList/sessionListIndex';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import type { CustomerInfo } from '../domains/purchases/types';
import type { ApplyMachinesOptions, MachinePresence } from './domains/machines';
import type { MachinePoolsDomain } from './domains/machinePools';
import type { ProjectAccountRowsDomain } from './domains/projectAccountRows';
import type { MessagesDomain, SessionMessages } from './domains/messages';
import type { PendingDomain } from './domains/pending';
import type {
    EndpointConnectivitySnapshot,
    EndpointConnectivityStatus,
    NativeUpdateStatus,
    SocketStatus,
    SyncError,
} from './domains/realtime';
import type { SessionActionDraft } from '../domains/sessionActions/sessionActionDraftTypes';
import type { SessionActionDraftStatus } from '../domains/sessionActions/sessionActionDraftTypes';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import type { WorkspaceScopeBase } from '../domains/workspaces/workspaceScope';
import type { SessionOrganizationDomain } from './domains/sessionOrganization';
import type { SessionListRenderableDelta } from './domains/sessionListIndexFinalization';
import type { TranscriptLoadingDomain } from './domains/transcriptLoading';
import type { ProjectAuthoringSessionInputs } from './domains/projectAuthoringSessions';
import type { SessionsDomain, SessionListRowPatchOperation } from './domains/sessions';

export type KnownEntitlements = 'voice' | 'pro';
export type SessionModelMode = NonNullable<Session['modelMode']>;

export interface SettingsDomainSlice {
    settings: Settings;
    settingsVersion: number | null;
    settingsScope: AccountSettingsScope | null;
    localSettings: LocalSettings;
    applySettings: (settings: Settings, version: number) => void;
    activateSettingsScope: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => Promise<void>;
    clearSettingsScope: () => void;
    applySettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>, options?: { source?: SettingsAnalyticsSource; persist?: boolean }) => void;
}

export interface ProfileDomainSlice {
    profile: Profile;
    profileScope: ServerAccountScope | null;
    purchases: Purchases;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    activateProfileScope: (scope: ServerAccountScope, legacyScopes?: readonly ServerAccountScope[]) => void;
    clearProfileScope: () => void;
    applyProfile: (profile: Profile) => void;
    applyProfileForScope: (scope: ServerAccountScope, profile: Profile) => void;
}

export interface SessionsDomainSlice extends Pick<SessionsDomain,
    'sessionArchiveOperations' | 'beginSessionArchive' | 'finishSessionArchive' | 'clearSessionArchiveOperations'> {
    sessions: Record<string, Session>;
    projectAuthoringSessions: ProjectAuthoringSessionInputs;
    /**
     * Ids this viewer has watched be deleted. Neither session map can answer "does this session
     * exist" — both are list-scoped caches that an ordinary refresh evicts from — so anything
     * holding a durable pointer to a session reads this rather than inferring gone-ness from a
     * cache miss. Written only by `deleteSession`. See `SessionsDomain` for the full note.
     */
    /** Session id → the Home whose carrier was retired, or `true` when no Home was addressed. */
    deletedSessionIds: Record<string, string | true>;
    sessionListRenderableDelta: SessionListRenderableDelta;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    ordinarySessionListMembershipByServerId: Readonly<Record<string, readonly string[] | undefined>>;
    archivedSessionListMembershipByServerId: Readonly<Record<string, readonly string[] | undefined>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    /**
     * Last applied strict-query membership per corpus (`buildSessionListQueryKey`), qualified by
     * the Home and Account it was read under. The query controller owns requests and cursors and
     * commits each applied page here; list surfaces render from this, so a remounted controller,
     * a refresh or an unreachable Home keeps the last-known rows until an authoritative page
     * replaces them. Access denial and credential retirement remove it.
     */
    sessionListQueryMembershipByKey: Readonly<Record<string, SessionListQueryMembership | undefined>>;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]>;
    reviewCommentsDraftsBySessionId: Record<string, ReviewCommentDraft[]>;
    reviewCommentsDraftsByWorkspaceCacheKey: Record<string, ReviewCommentDraft[]>;
    sessionActionDraftsByAddressKey: Record<string, SessionActionDraft[]>;
    sessionLocalStateScope: ServerAccountScope | null;
    /** Core Account projections; independent of draft hydration and outbox recovery. */
    isDataReady: boolean;
    /** The focused Account's draft hydration attempt has settled; local drafts remain usable offline. */
    isSessionDraftsReady: boolean;
    activateSessionLocalStateScope: (scope: ServerAccountScope) => void;
    clearSessionLocalStateScope: () => void;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[], source?: SessionPublicationSource) => void;
    applyServerScopedSessionListRows: SessionsDomain['applyServerScopedSessionListRows'];
    applyServerScopedSessionListRowPatches: (
        serverId: string,
        patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: SessionListRowPatchOperation;
        }>>,
    ) => void;
    reconcileSessionListRowsForServerScope: (
        serverId: string,
        sessions: SessionListRenderableSession[],
        baseline: Readonly<Record<string, SessionListRenderableSession>>,
        fullPublicationBaseline: Readonly<Record<string, number | undefined>>,
    ) => void;
    mergeSessionListRowsForServerScope: (serverId: string, sessions: SessionListRenderableSession[]) => void;
    clearSessionListRowsForServerScope: (serverId: string) => void;
    commitSessionListQueryMembership: (queryKey: string, membership: SessionListQueryMembership | null) => void;
    restoreSessionListQueryMemberships: (serverId: string, accountId: string) => void;
    applyScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getActiveSessions: () => Session[];
    getSessionRepositoryTreeExpandedPaths: (sessionId: string) => string[];
    setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => void;
    clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => void;
    getWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => string[];
    setWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase, paths: string[]) => void;
    clearWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => void;
    upsertSessionReviewCommentDraft: (sessionId: string, draft: ReviewCommentDraft) => void;
    setSessionReviewCommentDraftIncluded: (sessionId: string, commentId: string, included: boolean) => void;
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string, expectedDraft?: ReviewCommentDraft) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => void;
    setWorkspaceReviewCommentDraftIncluded: (workspaceCacheKey: string, commentId: string, included: boolean) => void;
    deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string, expectedDraft?: ReviewCommentDraft) => void;
    clearWorkspaceReviewCommentDrafts: (workspaceCacheKey: string) => void;
    createSessionActionDraft: (
        scope: ServerAccountScope,
        address: import('@/sync/domains/session/sessionAddress').SessionAddress,
        draft: Readonly<{ actionId: string; input?: Record<string, unknown> }>,
    ) => SessionActionDraft;
    updateSessionActionDraftInput: (
        scope: ServerAccountScope,
        address: import('@/sync/domains/session/sessionAddress').SessionAddress,
        draftId: string,
        patch: Record<string, unknown>,
    ) => void;
    setSessionActionDraftStatus: (scope: ServerAccountScope, address: import('@/sync/domains/session/sessionAddress').SessionAddress, draftId: string, status: SessionActionDraftStatus, error?: string | null) => void;
    deleteSessionActionDraft: (scope: ServerAccountScope, address: import('@/sync/domains/session/sessionAddress').SessionAddress, draftId: string) => void;
    clearSessionActionDrafts: (scope: ServerAccountScope, address: import('@/sync/domains/session/sessionAddress').SessionAddress) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionResuming: (sessionId: string) => void;
    armSessionResumingFallback: (sessionId: string) => void;
    clearSessionResuming: (sessionId: string) => void;
    clearSessionThinkingGrace: (sessionId: string) => void;
    applySessionTerminalLifecycle: (sessionId: string, turnCompletedAt: number | null) => void;
    markSessionViewed: (sessionId: string) => void;
    /** Applies the server's authoritative responsible Account after a committed mutation. */
    applySessionResponsibleAccount: (sessionId: string, responsibleAccountId: string | null, scope: ServerAccountScope, responsibleAccount?: import('@happier-dev/protocol').SessionAccessAccountSummaryV1 | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode, context?: SessionModelOptionsContext) => void;
    /**
     * Retire a Session locally for ONE Home, or for every Home when `serverId` is
     * omitted or null. Only the addressed Home's row/membership/index goes; the
     * shared per-id carrier (record, transcript, SCM, drafts, modes) goes only when
     * that Home is the carrier's own — see `shouldRetireSessionCarrierForServer`.
     */
    deleteSession: (sessionId: string, serverId?: string | null) => void;
}

export interface MachinesDomainSlice {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    machinePresenceById: Record<string, MachinePresence>;
    machinePresenceByServerId: Record<string, Record<string, MachinePresence>>;
    /**
     * Server-scoped machine lists used for multi-server group/picker contexts.
     * Active server machines still live in `machines` (record) for fast lookup.
     */
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean, options?: ApplyMachinesOptions) => void;
    replaceMachineDisplays: import('./domains/machines').MachinesDomain['replaceMachineDisplays'];
    markMachineListSettled: import('./domains/machines').MachinesDomain['markMachineListSettled'];
    markMachineListUnavailable: (serverId: string) => void;
}

export interface MessagesDomainSlice {
    sessionMessages: Record<string, SessionMessages>;
    sessionMessagesHistoryStartLoaded: Record<string, true>;
    markSessionMessagesHistoryStartLoaded: (sessionId: string) => void;
    applyMessages: MessagesDomain['applyMessages'];
    replaceSessionMessages: MessagesDomain['replaceSessionMessages'];
    applyMessagesLoaded: (sessionId: string) => void;
    evictSessionMessages: (sessionId: string) => void;
    resetSessionMessages: (sessionId: string) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
}

export type PendingDomainSlice = PendingDomain;

export type TranscriptLoadingDomainSlice = TranscriptLoadingDomain;

export interface RealtimeDomainSlice {
    socketStatus: SocketStatus;
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    socketLastError: string | null;
    socketLastErrorAt: number | null;
    syncError: SyncError;
    accountSettingsSyncStatus: AccountSettingsSyncStatus;
    lastSyncAt: number | null;
    endpointStatus: EndpointConnectivityStatus;
    endpointReason: string | null;
    endpointAttempt: number;
    endpointNextRetryAt: number | null;
    endpointLastConnectedAt: number | null;
    endpointLastDisconnectedAt: number | null;
    endpointLastErrorMessage: string | null;
    isDataReady: boolean;
    nativeUpdateStatus: NativeUpdateStatus;
    setSocketStatus: (status: SocketStatus) => void;
    setSocketError: (message: string | null) => void;
    setSyncError: (error: SyncError) => void;
    clearSyncError: () => void;
    setAccountSettingsSyncStatus: (status: AccountSettingsSyncStatus) => void;
    resetAccountSettingsSyncStatus: () => void;
    setLastSyncAt: (ts: number) => void;
    applyNativeUpdateStatus: (status: NativeUpdateStatus) => void;
    setEndpointConnectivity: (snapshot: EndpointConnectivitySnapshot) => void;
    resetEndpointConnectivity: () => void;
}

export interface TodosDomainSlice {
    todoState: TodoState | null;
    todosLoaded: boolean;
    applyTodos: (todoState: TodoState) => void;
}

export interface ArtifactsDomainSlice {
    artifacts: Record<string, DecryptedArtifact>;
    artifactSkillRevisions: Record<string, string>;
    artifactInventoryUnreadyCount: number;
    artifactsLoaded: boolean;
    artifactsStorageRevision: number;
    applyArtifacts: (artifacts: DecryptedArtifact[], inventoryReadStartedWith?: Readonly<Record<string, DecryptedArtifact>>) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
}

/**
 * The one Account-scoped map of workflow Run bodies, keyed by `runId`. Every
 * transport that reads Runs normalizes into it and keeps only its own ordered
 * id window beside it.
 */
export type WorkflowRunsDomainSlice = WorkflowRunsDomain;

export type AutomationsDomainSlice = AutomationsDomain;

export interface PetsDomainSlice {
    accountPetsById: Record<string, AccountPetMetadata>;
    localPetSourcesBySourceKey: Record<string, LocalPetSourceMetadata>;
    applyAccountPets: (pets: AccountPetMetadata[]) => void;
    upsertAccountPet: (pet: AccountPetMetadata) => void;
    removeAccountPet: (petId: string) => void;
    upsertLocalPetSources: (sources: readonly LocalPetSourceMetadata[]) => void;
    removeLocalPetSource: (sourceKey: string) => void;
}

export interface ProjectDomainSlice {
    getProject: (projectId: string) => import('../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string, serverId?: string | null) => import('../runtime/orchestration/projectManager').Project | null;
    getProjectScmStatus: (projectId: string) => ScmStatus | null;
    getSessionProjectScmStatus: (sessionId: string, serverId?: string | null) => ScmStatus | null;
    updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null, serverId?: string | null) => void;
    getProjectScmSnapshot: (projectId: string) => ScmWorkingSnapshot | null;
    getProjectScmSnapshotError: (projectId: string) => import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null;
    getSessionProjectScmSnapshot: (sessionId: string, serverId?: string | null) => ScmWorkingSnapshot | null;
    getSessionProjectScmSnapshotError: (sessionId: string, serverId?: string | null) => import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null;
    updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null, serverId?: string | null) => void;
    updateSessionProjectScmSnapshotError: (
        sessionId: string,
        error: import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null,
        serverId?: string | null,
    ) => void;
    publishSessionProjectScmSnapshots: (
        publishes: ReadonlyArray<Readonly<{
            sessionId: string;
            serverId?: string | null;
            snapshot: ScmWorkingSnapshot;
            status: ScmStatus | null;
        }>>,
    ) => void;
    getWorkspaceScmTouchedPathsForSession: (sessionId: string, serverId?: string | null) => string[];
    markWorkspaceScmTouchedPathsForSession: (sessionId: string, paths: string[], serverId?: string | null) => void;
    pruneWorkspaceScmTouchedPathsForSession: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => void;
    getSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => string[];
    markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => void;
    unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => void;
    clearSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => void;
    pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => void;
    getSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => ScmCommitSelectionPatch[];
    upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch, serverId?: string | null) => void;
    removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string, serverId?: string | null) => void;
    clearSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => void;
    pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => void;
    getSessionProjectScmOperationLog: (sessionId: string, serverId?: string | null) => import('../runtime/orchestration/projectManager').ScmProjectOperationLogEntry[];
    appendSessionProjectScmOperation: (
        sessionId: string,
        entry: Omit<import('../runtime/orchestration/projectManager').ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
        serverId?: string | null,
    ) => void;
    getSessionProjectScmInFlightOperation: (sessionId: string, serverId?: string | null) => import('../runtime/orchestration/projectManager').ScmProjectInFlightOperation | null;
    beginSessionProjectScmOperation: (
        sessionId: string,
        operation: import('../runtime/orchestration/projectManager').ScmProjectOperationKind,
        serverId?: string | null,
    ) => import('../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string, serverId?: string | null) => boolean;
    updateSessionProjectScmOperationProgress: (sessionId: string, operationId: string, progressText?: string, serverId?: string | null) => boolean;

    getWorkspaceScmStatus: (scope: WorkspaceScopeBase) => ScmStatus | null;
    updateWorkspaceScmStatus: (scope: WorkspaceScopeBase, status: ScmStatus | null) => void;
    getWorkspaceScmSnapshot: (scope: WorkspaceScopeBase) => ScmWorkingSnapshot | null;
    getWorkspaceScmSnapshotError: (scope: WorkspaceScopeBase) => import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null;
    updateWorkspaceScmSnapshot: (scope: WorkspaceScopeBase, snapshot: ScmWorkingSnapshot | null) => void;
    updateWorkspaceScmSnapshotError: (
        scope: WorkspaceScopeBase,
        error: import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null
    ) => void;
    getWorkspaceScmTouchedPaths: (scope: WorkspaceScopeBase) => string[];
    markWorkspaceScmTouchedPaths: (scope: WorkspaceScopeBase, paths: string[], touchedAt?: number) => void;
    pruneWorkspaceScmTouchedPaths: (scope: WorkspaceScopeBase, activePaths: Set<string>) => void;
    getWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase) => string[];
    markWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase, paths: string[], selectedAt?: number) => void;
    unmarkWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase, paths: string[]) => void;
    clearWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase) => void;
    pruneWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase, activePaths: Set<string>) => void;
    getWorkspaceScmCommitSelectionPatches: (scope: WorkspaceScopeBase) => ScmCommitSelectionPatch[];
    upsertWorkspaceScmCommitSelectionPatch: (scope: WorkspaceScopeBase, patchSelection: ScmCommitSelectionPatch, selectedAt?: number) => void;
    removeWorkspaceScmCommitSelectionPatch: (scope: WorkspaceScopeBase, path: string) => void;
    clearWorkspaceScmCommitSelectionPatches: (scope: WorkspaceScopeBase) => void;
    pruneWorkspaceScmCommitSelectionPatches: (scope: WorkspaceScopeBase, activePaths: Set<string>) => void;
    getWorkspaceScmOperationLog: (scope: WorkspaceScopeBase) => import('../runtime/orchestration/projectManager').ScmProjectOperationLogEntry[];
    appendWorkspaceScmOperation: (
        scope: WorkspaceScopeBase,
        entry: Omit<import('../runtime/orchestration/projectManager').ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
    getWorkspaceScmInFlightOperation: (scope: WorkspaceScopeBase) => import('../runtime/orchestration/projectManager').ScmProjectInFlightOperation | null;
    beginWorkspaceScmOperation: (
        scope: WorkspaceScopeBase,
        operation: import('../runtime/orchestration/projectManager').ScmProjectOperationKind,
    ) => import('../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
    finishWorkspaceScmOperation: (scope: WorkspaceScopeBase, operationId: string) => boolean;
    updateWorkspaceScmOperationProgress: (scope: WorkspaceScopeBase, operationId: string, progressText?: string) => boolean;
}

export interface FriendsDomainSlice {
    friends: Record<string, UserProfile>;
    users: Record<string, UserProfile | null>;
    friendsLoaded: boolean;
    applyFriends: (friends: UserProfile[]) => void;
    applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
    getFriend: (userId: string) => UserProfile | undefined;
    getAcceptedFriends: () => UserProfile[];
    applyUsers: (users: Record<string, UserProfile | null>) => void;
    getUser: (userId: string) => UserProfile | null | undefined;
    assumeUsers: (userIds: string[]) => Promise<void>;
}

export interface FeedDomainSlice {
    feedItems: FeedItem[];
    feedHead: string | null;
    feedTail: string | null;
    feedHasMore: boolean;
    feedLoaded: boolean;
    applyFeedItems: (items: FeedItem[]) => void;
    clearFeed: () => void;
}

export interface BootstrapSlice {
    applyReady: () => void;
}

export type StorageState = SettingsDomainSlice
    & AuthoringMemoryDomain
    & ProfileDomainSlice
    & SessionsDomainSlice
    & SessionOrganizationDomain
    & MachinesDomainSlice
    & MachinePoolsDomain
    & ProjectAccountRowsDomain
    & MessagesDomainSlice
    & PendingDomainSlice
    & TranscriptLoadingDomainSlice
    & RealtimeDomainSlice
    & TodosDomainSlice
    & ArtifactsDomainSlice
    & WorkflowRunsDomainSlice
    & AutomationsDomainSlice
    & PetsDomainSlice
    & ProjectDomainSlice
    & FriendsDomainSlice
    & FeedDomainSlice
    & BootstrapSlice;
