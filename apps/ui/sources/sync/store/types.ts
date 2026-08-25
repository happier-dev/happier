import type { TodoState } from '@/sync/domains/todos/todoOps';

import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import type { AutomationDefinition, AutomationDefinitionRun } from '../domains/automations/automationTypes';
import type { FeedItem } from '../domains/social/feedTypes';
import type { RelationshipUpdatedEvent, UserProfile } from '../domains/social/friendTypes';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { ReviewCommentDraft } from '../domains/input/reviewComments/reviewCommentTypes';
import type { PendingMessage, Session, Machine, ScmStatus, ScmWorkingSnapshot, DiscardedPendingMessage } from '../domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '../domains/state/storageTypes';
import type { NormalizedMessage } from '../typesRaw';
import type { PermissionMode } from '../domains/permissions/permissionTypes';
import type { Profile } from '../domains/profiles/profile';
import type { Purchases } from '../domains/purchases/purchases';
import type { AccountPetMetadata } from '../domains/pets/accountPetLibraryTypes';
import type { LocalPetSourceMetadata } from '../domains/pets/localPetSourceTypes';
import type { Settings } from '../domains/settings/settings';
import type { AccountSettingsSyncStatus } from '../domains/settings/accountSettingsSyncStatus';
import type { AccountSettingsScope } from '../domains/settings/scope/accountSettingsScope';
import type { ServerAccountScope } from '../domains/scope/serverAccountScope';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '../domains/session/listing/concurrentSessionListCache';
import type { SessionListIndexItem } from '../domains/sessionList/sessionListIndex';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import type { CustomerInfo } from '../domains/purchases/types';
import type { ApplyMachinesOptions } from './domains/machines';
import type { SessionMessages } from './domains/messages';
import type { SessionPending } from './domains/pending';
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
import type { SessionTranscriptLoadIssue } from './domains/transcriptLoading';

export type KnownEntitlements = 'voice' | 'pro';
export type SessionModelMode = NonNullable<Session['modelMode']>;

export interface SettingsDomainSlice {
    settings: Settings;
    settingsVersion: number | null;
    settingsScope: AccountSettingsScope | null;
    localSettings: LocalSettings;
    applySettings: (settings: Settings, version: number) => void;
    replaceSettings: (settings: Settings, version: number) => void;
    activateSettingsScope: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => void;
    clearSettingsScope: () => void;
    applySettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    replaceSettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>, options?: { source?: SettingsAnalyticsSource }) => void;
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

export interface SessionsDomainSlice {
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    /**
     * Ids this viewer has watched be deleted. Neither session map can answer "does this session
     * exist" — both are list-scoped caches that an ordinary refresh evicts from — so anything
     * holding a durable pointer to a session reads this rather than inferring gone-ness from a
     * cache miss. Written only by `deleteSession`. See `SessionsDomain` for the full note.
     */
    deletedSessionIds: Record<string, true>;
    sessionListRenderableDelta: SessionListRenderableDelta;
    sessionListRowStateByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]>;
    reviewCommentsDraftsBySessionId: Record<string, ReviewCommentDraft[]>;
    reviewCommentsDraftsByWorkspaceCacheKey: Record<string, ReviewCommentDraft[]>;
    actionDraftsBySessionId: Record<string, SessionActionDraft[]>;
    sessionLocalStateScope: ServerAccountScope | null;
    isDataReady: boolean;
    activateSessionLocalStateScope: (scope: ServerAccountScope) => void;
    clearSessionLocalStateScope: () => void;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    replaceSessionListRenderables: (sessions: SessionListRenderableSession[]) => void;
    mergeSessionListRenderables: (sessions: SessionListRenderableSession[]) => void;
    applySessionListRenderablePatches: (
        patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>>,
    ) => void;
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
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => void;
    setWorkspaceReviewCommentDraftIncluded: (workspaceCacheKey: string, commentId: string, included: boolean) => void;
    deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string) => void;
    clearWorkspaceReviewCommentDrafts: (workspaceCacheKey: string) => void;
    createSessionActionDraft: (
        sessionId: string,
        draft: Readonly<{ actionId: string; input?: Record<string, unknown> }>,
    ) => SessionActionDraft;
    updateSessionActionDraftInput: (
        sessionId: string,
        draftId: string,
        patch: Record<string, unknown>,
    ) => void;
    setSessionActionDraftStatus: (sessionId: string, draftId: string, status: SessionActionDraftStatus, error?: string | null) => void;
    deleteSessionActionDraft: (sessionId: string, draftId: string) => void;
    clearSessionActionDrafts: (sessionId: string) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionResuming: (sessionId: string) => void;
    armSessionResumingFallback: (sessionId: string) => void;
    clearSessionResuming: (sessionId: string) => void;
    clearSessionThinkingGrace: (sessionId: string) => void;
    applySessionTerminalLifecycle: (sessionId: string, turnCompletedAt: number | null) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;
    deleteSession: (sessionId: string) => void;
}

export interface MachinesDomainSlice {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    /**
     * Server-scoped machine lists used for multi-server group/picker contexts.
     * Active server machines still live in `machines` (record) for fast lookup.
     */
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean, options?: ApplyMachinesOptions) => void;
    replaceMachineDisplays: (machines: MachineDisplayRenderable[], options?: ApplyMachinesOptions) => void;
}

export interface MessagesDomainSlice {
    sessionMessages: Record<string, SessionMessages>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[]; hasReadyEvent: boolean };
    replaceSessionMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[]; hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    evictSessionMessages: (sessionId: string) => void;
    resetSessionMessages: (sessionId: string) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
}

export interface PendingDomainSlice {
    sessionPending: Record<string, SessionPending>;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingSnapshot: (sessionId: string, snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
    }>) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    pruneServerPendingMessages: (sessionId: string) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
}

export interface TranscriptLoadingDomainSlice {
    sessionCatchUpNewerInFlight: Record<string, number>;
    sessionTailContiguousFloorSeq: Record<string, number>;
    sessionTranscriptLoadIssues: Record<string, SessionTranscriptLoadIssue>;
    isSessionCatchingUpNewer: (sessionId: string) => boolean;
    beginSessionCatchUpNewer: (sessionId: string) => void;
    endSessionCatchUpNewer: (sessionId: string) => void;
    getSessionTailContiguousFloorSeq: (sessionId: string) => number | null;
    setSessionTailContiguousFloorSeq: (sessionId: string, floorSeq: number | null) => void;
    getSessionTranscriptLoadIssue: (sessionId: string) => SessionTranscriptLoadIssue | null;
    setSessionTranscriptLoadIssue: (sessionId: string, issue: SessionTranscriptLoadIssue | null) => void;
}

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
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
}

export interface AutomationsDomainSlice {
    automations: Record<string, AutomationDefinition>;
    automationRunsByAutomationId: Record<string, AutomationDefinitionRun[]>;
    automationRunNextCursorByAutomationId: Record<string, string | null>;
    applyAutomations: (automations: AutomationDefinition[]) => void;
    upsertAutomation: (automation: AutomationDefinition) => void;
    removeAutomation: (automationId: string) => void;
    setAutomationRuns: (automationId: string, runs: AutomationDefinitionRun[], nextCursor: string | null) => void;
    refreshAutomationRunsWindow: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    upsertAutomationRun: (run: AutomationDefinitionRun) => void;
}

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
    getProjects: () => import('../runtime/orchestration/projectManager').Project[];
    getProject: (projectId: string) => import('../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('../runtime/orchestration/projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];
    getProjectScmStatus: (projectId: string) => ScmStatus | null;
    getSessionProjectScmStatus: (sessionId: string) => ScmStatus | null;
    updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getProjectScmSnapshot: (projectId: string) => ScmWorkingSnapshot | null;
    getProjectScmSnapshotError: (projectId: string) => import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null;
    getSessionProjectScmSnapshot: (sessionId: string) => ScmWorkingSnapshot | null;
    getSessionProjectScmSnapshotError: (sessionId: string) => import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null;
    updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null) => void;
    updateSessionProjectScmSnapshotError: (
        sessionId: string,
        error: import('../runtime/orchestration/projectManager').ProjectScmSnapshotError | null
    ) => void;
    publishSessionProjectScmSnapshots: (
        publishes: ReadonlyArray<Readonly<{
            sessionId: string;
            snapshot: ScmWorkingSnapshot;
            status: ScmStatus | null;
        }>>,
    ) => void;
    getSessionProjectScmTouchedPaths: (sessionId: string) => string[];
    markSessionProjectScmTouchedPaths: (sessionId: string, paths: string[]) => void;
    pruneSessionProjectScmTouchedPaths: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectScmCommitSelectionPaths: (sessionId: string) => string[];
    markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => void;
    unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => void;
    clearSessionProjectScmCommitSelectionPaths: (sessionId: string) => void;
    pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectScmCommitSelectionPatches: (sessionId: string) => ScmCommitSelectionPatch[];
    upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch) => void;
    removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string) => void;
    clearSessionProjectScmCommitSelectionPatches: (sessionId: string) => void;
    pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectScmOperationLog: (sessionId: string) => import('../runtime/orchestration/projectManager').ScmProjectOperationLogEntry[];
    appendSessionProjectScmOperation: (
        sessionId: string,
        entry: Omit<import('../runtime/orchestration/projectManager').ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
    getSessionProjectScmInFlightOperation: (sessionId: string) => import('../runtime/orchestration/projectManager').ScmProjectInFlightOperation | null;
    beginSessionProjectScmOperation: (
        sessionId: string,
        operation: import('../runtime/orchestration/projectManager').ScmProjectOperationKind,
    ) => import('../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string) => boolean;

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
    & ProfileDomainSlice
    & SessionsDomainSlice
    & SessionOrganizationDomain
    & MachinesDomainSlice
    & MessagesDomainSlice
    & PendingDomainSlice
    & TranscriptLoadingDomainSlice
    & RealtimeDomainSlice
    & TodosDomainSlice
    & ArtifactsDomainSlice
    & AutomationsDomainSlice
    & PetsDomainSlice
    & ProjectDomainSlice
    & FriendsDomainSlice
    & FeedDomainSlice
    & BootstrapSlice;
