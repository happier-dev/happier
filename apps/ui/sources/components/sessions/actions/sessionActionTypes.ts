import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionStopRecovery } from '@/sync/ops/sessionStopContract';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type SessionActionSurface =
    | 'rowMenu'
    /** A Bot's row in the Bots roster: only what you do with a bot from there. */
    | 'botsRoster'
    | 'nativeContextMenu'
    | 'sessionHeader'
    | 'sessionInfo'
    | 'selectionActionBar';

export type SessionActionId =
    | 'ui.session.follow'
    | 'ui.session.mark-read'
    | 'ui.session.mark-unread'
    | 'ui.session.rename'
    | 'ui.session.make-bot'
    | 'ui.session.make-regular'
    | 'ui.session.tool-calls.toggle'
    | 'ui.session.tool-calls.use-default'
    | 'ui.session.resume'
    | 'ui.session.stop'
    | 'ui.session.archive'
    | 'ui.session.unarchive'
    | 'ui.session.delete'
    | 'ui.session.pin'
    | 'ui.session.unpin'
    | 'ui.session.rail.pin'
    | 'ui.session.rail.unpin'
    | 'ui.session.work.open'
    | 'ui.session.talk'
    | 'ui.session.tags.edit'
    | 'ui.session.move-to-folder'
    | 'ui.session.set-attention-standing'
    | 'ui.session.clear-attention-standing'
    | 'ui.session.make-orchestrator'
    | 'ui.session.put-under';

/**
 * Whether this session can be kept in — or released from — Needs attention, and which way the
 * single toggle currently points. `none` covers every reason the instruction is unreachable
 * (no attention band configured, archived, view-only access), so a surface never has to
 * re-derive that rule to decide whether to draw the action.
 */
export type SessionAttentionStandingAction =
    | { kind: 'set-standing'; visible: true; targetStanding: true }
    | { kind: 'clear-standing'; visible: true; targetStanding: false }
    | { kind: 'none'; visible: false };

/**
 * Reminder writes are Account-private organization intent, not Session-record edits. Scheduling
 * requires a qualified readable active Session; an already stored reminder can still be cleared
 * after archival through the server's synchronized-Session organization path.
 */
export type SessionReminderActionAvailability = Readonly<{
    canSchedule: boolean;
    canClear: boolean;
}>;

export type SessionActionSession = Session | SessionListRenderableSession;

export type SessionActionTarget = Readonly<{
    session: SessionActionSession;
    sessionId: string;
    serverId: string | null;
    isActive: boolean;
    isArchived: boolean;
    isConnected: boolean;
    hasRecoverableTerminalHost: boolean;
    isPinned: boolean;
    isRailPinned: boolean;
    isOwnedByCurrentUser: boolean;
    canUnarchive: boolean;
    canStop: boolean;
    canArchive: boolean;
    canRename: boolean;
    /** Owner-private field edits require a readable same-Home owner projection. */
    canWriteOwnerMetadata: boolean;
    /** The Session's own Show tool calls choice from its owner metadata; `null`/absent follows the default. */
    toolCallsOverride?: boolean | null;
    canResume: boolean;
    canDelete: boolean;
    followEnabled?: boolean;
    readStateAction: SessionReadStateAction;
    attentionStandingAction: SessionAttentionStandingAction;
    reminderAction: SessionReminderActionAvailability;
}>;

export type SessionActionOperationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
    details?: unknown;
    recovery?: SessionStopRecovery;
}>;

export type SessionActionExecutionInput = Readonly<{
    title?: string;
    readState?: 'read' | 'unread';
    tags?: readonly string[];
    folderId?: string | null;
    /** The requested visibility, computed from the transcript owner's effective choice. */
    showToolCalls?: boolean;
}>;

export type SessionActionExecutionOperations = Readonly<{
    openFollowEditor?: (params: Readonly<{ address: SessionAddress; archived: boolean }>) => void;
    stopArchiveFlow?: (params: {
        address: SessionAddress;
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
    setSessionRole?: (sessionId: string, roleId: string, opts?: Readonly<{ serverId?: string | null }>) => Promise<Readonly<{ ok: boolean; error?: string }>>;
    openPutUnderPicker?: (params: Readonly<{ sessionId: string; serverId: string | null }>) => void;
    resumeSession?: (sessionId: string) => void | Promise<void>;
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
    setAttentionStanding?: (
        sessionId: string,
        standing: boolean,
        opts?: Readonly<{ serverId?: string | null }>,
    ) => void | SessionActionOperationResult | Promise<void | SessionActionOperationResult>;
    setManualReadState?: (
        sessionId: string,
        readState: 'read' | 'unread',
        opts?: Readonly<{ serverId?: string | null }>,
    ) => Promise<SessionActionOperationResult>;
    clearSessionVisibleWhenInactive?: (address: SessionAddress) => void;
}>;

export type SessionActionExecutionContext = Readonly<{
    hideInactiveSessions?: boolean;
    operations?: SessionActionExecutionOperations;
}>;
