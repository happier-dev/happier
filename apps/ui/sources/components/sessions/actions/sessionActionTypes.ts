import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

export type SessionActionSurface =
    | 'rowMenu'
    | 'nativeContextMenu'
    | 'sessionHeader'
    | 'sessionInfo'
    | 'selectionActionBar';

export type SessionActionId =
    | 'ui.session.mark-read'
    | 'ui.session.mark-unread'
    | 'ui.session.rename'
    | 'ui.session.stop'
    | 'ui.session.archive'
    | 'ui.session.unarchive'
    | 'ui.session.delete'
    | 'ui.session.pin'
    | 'ui.session.unpin'
    | 'ui.session.tags.edit'
    | 'ui.session.move-to-folder';

export type SessionActionSession = Session | SessionListRenderableSession;

export type SessionActionTarget = Readonly<{
    session: SessionActionSession;
    sessionId: string;
    serverId: string | null;
    isActive: boolean;
    isArchived: boolean;
    isConnected: boolean;
    isPinned: boolean;
    isOwnedByCurrentUser: boolean;
    hasAdminAccess: boolean;
    canStop: boolean;
    canArchive: boolean;
    canRename: boolean;
    canDelete: boolean;
    readStateAction: SessionReadStateAction;
}>;

export type SessionActionOperationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
}>;

export type SessionActionExecutionInput = Readonly<{
    title?: string;
    readState?: 'read' | 'unread';
    tags?: readonly string[];
    folderId?: string | null;
}>;

export type SessionActionExecutionOperations = Readonly<{
    stopArchiveFlow?: (params: {
        sessionId: string;
        hideInactiveSessions: boolean;
        isPinned: boolean;
        archiveAfterStop: 'always' | 'never';
        stopSession: () => Promise<SessionActionOperationResult>;
        archiveSession: () => Promise<SessionActionOperationResult>;
        stopErrorMessage: string;
        archiveErrorMessage: string;
    }) => Promise<void>;
    stopSession?: (sessionId: string, opts?: Readonly<{ serverId?: string | null }>) => Promise<SessionActionOperationResult>;
    archiveSession?: (sessionId: string, opts?: Readonly<{ serverId?: string | null }>) => Promise<SessionActionOperationResult>;
    unarchiveSession?: (sessionId: string, opts?: Readonly<{ serverId?: string | null }>) => Promise<SessionActionOperationResult>;
    renameSession?: (sessionId: string, title: string, opts?: Readonly<{ serverId?: string | null }>) => Promise<SessionActionOperationResult>;
    deleteSession?: (sessionId: string, opts?: Readonly<{ serverId?: string | null }>) => Promise<SessionActionOperationResult>;
    setPinned?: (
        sessionId: string,
        pinned: boolean,
        opts?: Readonly<{ serverId?: string | null }>,
    ) => void | SessionActionOperationResult | Promise<void | SessionActionOperationResult>;
    setTags?: (
        sessionId: string,
        tags: readonly string[],
        opts?: Readonly<{ serverId?: string | null }>,
    ) => void | SessionActionOperationResult | Promise<void | SessionActionOperationResult>;
    moveToFolder?: (
        target: SessionActionTarget,
        input?: Readonly<{ folderId?: string | null }>,
    ) => void | SessionActionOperationResult | Promise<void | SessionActionOperationResult>;
    setManualReadState?: (
        sessionId: string,
        readState: 'read' | 'unread',
        opts?: Readonly<{ serverId?: string | null }>,
    ) => Promise<SessionActionOperationResult>;
    clearSessionVisibleWhenInactive?: (sessionId: string) => void;
}>;

export type SessionActionExecutionContext = Readonly<{
    hideInactiveSessions?: boolean;
    operations?: SessionActionExecutionOperations;
}>;
