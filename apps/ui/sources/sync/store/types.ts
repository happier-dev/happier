import type { TodoState } from '@/sync/domains/todos/todoOps';

import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import type { Automation, AutomationRun } from '../domains/automations/automationTypes';
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
import type { Settings } from '../domains/settings/settings';
import type { SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { CustomerInfo } from '../domains/purchases/types';
import type { SessionMessages } from './domains/messages';
import type { SessionPending } from './domains/pending';
import type { NativeUpdateStatus, RealtimeMode, RealtimeStatus, SocketStatus, SyncError } from './domains/realtime';

export type KnownEntitlements = 'voice' | 'pro';
export type SessionListItem = string | Session;
export type SessionModelMode = NonNullable<Session['modelMode']>;

export interface SettingsDomainSlice {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    applySettings: (settings: Settings, version: number) => void;
    replaceSettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
}

export interface ProfileDomainSlice {
    profile: Profile;
    purchases: Purchases;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
}

export interface LegacySessionsSlice {
    sessionsData: SessionListItem[] | null;
}

export interface SessionsDomainSlice {
    sessions: Record<string, Session>;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    reviewCommentsDraftsBySessionId: Record<string, ReviewCommentDraft[]>;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    applyScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getActiveSessions: () => Session[];
    getSessionRepositoryTreeExpandedPaths: (sessionId: string) => string[];
    setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => void;
    clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => void;
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    upsertSessionReviewCommentDraft: (sessionId: string, draft: ReviewCommentDraft) => void;
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;
    deleteSession: (sessionId: string) => void;
}

export interface MachinesDomainSlice {
    machines: Record<string, Machine>;
    /**
     * Server-scoped machine lists used for multi-server group/picker contexts.
     * Active server machines still live in `machines` (record) for fast lookup.
     */
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
}

export interface MessagesDomainSlice {
    sessionMessages: Record<string, SessionMessages>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[]; hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
}

export interface PendingDomainSlice {
    sessionPending: Record<string, SessionPending>;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
}

export interface RealtimeDomainSlice {
    realtimeStatus: RealtimeStatus;
    realtimeMode: RealtimeMode;
    socketStatus: SocketStatus;
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    socketLastError: string | null;
    socketLastErrorAt: number | null;
    syncError: SyncError;
    lastSyncAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: NativeUpdateStatus;
    setRealtimeStatus: (status: RealtimeStatus) => void;
    setRealtimeMode: (mode: RealtimeMode, immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    setSocketStatus: (status: SocketStatus) => void;
    setSocketError: (message: string | null) => void;
    setSyncError: (error: SyncError) => void;
    clearSyncError: () => void;
    setLastSyncAt: (ts: number) => void;
    applyNativeUpdateStatus: (status: NativeUpdateStatus) => void;
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
    automations: Record<string, Automation>;
    automationRunsByAutomationId: Record<string, AutomationRun[]>;
    applyAutomations: (automations: Automation[]) => void;
    upsertAutomation: (automation: Automation) => void;
    removeAutomation: (automationId: string) => void;
    setAutomationRuns: (automationId: string, runs: AutomationRun[]) => void;
    upsertAutomationRun: (run: AutomationRun) => void;
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
    applyLoaded: () => void;
    applyReady: () => void;
}

export type StorageState = SettingsDomainSlice
    & ProfileDomainSlice
    & LegacySessionsSlice
    & SessionsDomainSlice
    & MachinesDomainSlice
    & MessagesDomainSlice
    & PendingDomainSlice
    & RealtimeDomainSlice
    & TodosDomainSlice
    & ArtifactsDomainSlice
    & AutomationsDomainSlice
    & ProjectDomainSlice
    & FriendsDomainSlice
    & FeedDomainSlice
    & BootstrapSlice;
