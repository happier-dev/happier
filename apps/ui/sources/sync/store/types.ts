import type { TodoState } from '@/sync/domains/todos/todoOps';

import type { DecryptedArtifact } from '../domains/artifacts/artifactTypes';
import type { FeedItem } from '../domains/social/feedTypes';
import type { RelationshipUpdatedEvent, UserProfile } from '../domains/social/friendTypes';
import type { LocalSettings } from '../domains/settings/localSettings';
import type { PendingMessage, Session, Machine, GitStatus, GitWorkingSnapshot, DiscardedPendingMessage } from '../domains/state/storageTypes';
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
    sessionGitStatus: Record<string, GitStatus | null>;
    sessionLastViewed: Record<string, number>;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;
    deleteSession: (sessionId: string) => void;
}

export interface MachinesDomainSlice {
    machines: Record<string, Machine>;
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

export interface ProjectDomainSlice {
    getProjects: () => import('../runtime/orchestration/projectManager').Project[];
    getProject: (projectId: string) => import('../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('../runtime/orchestration/projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];
    getProjectGitStatus: (projectId: string) => GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => void;
    getProjectGitSnapshot: (projectId: string) => GitWorkingSnapshot | null;
    getSessionProjectGitSnapshot: (sessionId: string) => GitWorkingSnapshot | null;
    updateSessionProjectGitSnapshot: (sessionId: string, snapshot: GitWorkingSnapshot | null) => void;
    getSessionProjectGitTouchedPaths: (sessionId: string) => string[];
    markSessionProjectGitTouchedPaths: (sessionId: string, paths: string[]) => void;
    pruneSessionProjectGitTouchedPaths: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectGitOperationLog: (sessionId: string) => import('../runtime/orchestration/projectManager').GitProjectOperationLogEntry[];
    appendSessionProjectGitOperation: (
        sessionId: string,
        entry: Omit<import('../runtime/orchestration/projectManager').GitProjectOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
    getSessionProjectGitInFlightOperation: (sessionId: string) => import('../runtime/orchestration/projectManager').GitProjectInFlightOperation | null;
    beginSessionProjectGitOperation: (
        sessionId: string,
        operation: import('../runtime/orchestration/projectManager').GitProjectOperationKind,
    ) => import('../runtime/orchestration/projectManager').BeginGitProjectOperationResult;
    finishSessionProjectGitOperation: (sessionId: string, operationId: string) => boolean;
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
    & ProjectDomainSlice
    & FriendsDomainSlice
    & FeedDomainSlice
    & BootstrapSlice;
