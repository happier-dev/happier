import type { FeatureDecision } from '@happier-dev/protocol';

export const SESSION_BULK_ACTION_IDS = {
    stop: 'ui.session.stop',
    archive: 'ui.session.archive',
    unarchive: 'ui.session.unarchive',
    markRead: 'ui.session.mark-read',
    markUnread: 'ui.session.mark-unread',
    pin: 'ui.session.pin',
    unpin: 'ui.session.unpin',
    tagsAdd: 'ui.session.tags.add',
    tagsRemove: 'ui.session.tags.remove',
    tagsSet: 'ui.session.tags.set',
    moveToFolder: 'ui.session.move-to-folder',
} as const;

export type SessionBulkActionId = typeof SESSION_BULK_ACTION_IDS[keyof typeof SESSION_BULK_ACTION_IDS];

export type SessionBulkTagActionId =
    | typeof SESSION_BULK_ACTION_IDS.tagsAdd
    | typeof SESSION_BULK_ACTION_IDS.tagsRemove
    | typeof SESSION_BULK_ACTION_IDS.tagsSet;

export type SessionBulkActionRequest =
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.stop }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.archive }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.unarchive }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.markRead }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.markUnread }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.pin }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.unpin }>
    | Readonly<{ id: SessionBulkTagActionId; tags: readonly string[] }>
    | Readonly<{ id: typeof SESSION_BULK_ACTION_IDS.moveToFolder; folderId: string | null }>;

export type SessionBulkReadState = 'read' | 'unread';

export type SessionBulkActionTarget = Readonly<{
    key: string;
    sessionId: string;
    serverId?: string | null;
    active?: boolean;
    archived?: boolean;
    pinned?: boolean;
    hasAdminAccess?: boolean;
    canStop?: boolean;
    canArchive?: boolean;
    tags?: readonly string[];
    readState?: SessionBulkReadState;
}>;

export type SessionBulkMutationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
}>;

export type SessionBulkOperation<T = SessionBulkMutationResult> = (
    target: SessionBulkActionTarget,
) => Promise<T>;

export type SessionBulkReadStateOperation = (
    target: SessionBulkActionTarget,
    readState: SessionBulkReadState,
) => Promise<SessionBulkMutationResult>;

export type SessionBulkFolderAssignmentOperation = (
    params: Readonly<{
        target: SessionBulkActionTarget;
        folderId: string | null;
    }>,
) => Promise<void>;

export type SessionBulkStopAndArchiveOperation = (
    params: Readonly<{
        target: SessionBulkActionTarget;
        sessionId: string;
        hideInactiveSessions: boolean;
        isPinned: boolean;
        archiveAfterStop: 'always';
        stopSession: () => Promise<SessionBulkMutationResult>;
        archiveSession: () => Promise<SessionBulkMutationResult>;
        stopErrorMessage: string;
        archiveErrorMessage: string;
    }>,
) => Promise<void>;

export type SessionBulkActionCancelSignal = Readonly<{
    isCancelled: () => boolean;
}>;

export type SessionBulkActionProgressSnapshot = Readonly<{
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cancelled: number;
    completed: number;
    status: 'idle' | 'running' | 'complete' | 'cancelled';
}>;

export type SessionBulkActionProgressListener = (snapshot: SessionBulkActionProgressSnapshot) => void;

export type SessionBulkActionExecutionContext = Readonly<{
    concurrencyLimit?: number;
    cancelSignal?: SessionBulkActionCancelSignal;
    onProgress?: SessionBulkActionProgressListener;

    pinnedSessionKeysV1?: readonly string[] | null;
    setPinnedSessionKeysV1?: (next: string[]) => void | Promise<void>;

    sessionTagsV1?: Readonly<Record<string, readonly string[]>> | null;
    setSessionTagsV1?: (next: Record<string, string[]>) => void | Promise<void>;

    hideInactiveSessions?: boolean;
    stopSession?: SessionBulkOperation;
    archiveSession?: SessionBulkOperation;
    unarchiveSession?: SessionBulkOperation;
    setManualReadState?: SessionBulkReadStateOperation;
    stopSessionAndMaybeArchive?: SessionBulkStopAndArchiveOperation;

    foldersFeatureDecision?: Pick<FeatureDecision, 'state'> | null;
    setSessionFolderAssignment?: SessionBulkFolderAssignmentOperation;

    stopErrorMessage?: string;
    archiveErrorMessage?: string;
}>;

export type SessionBulkActionResultStatus = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export type SessionBulkActionTargetResult = Readonly<{
    target: SessionBulkActionTarget;
    status: SessionBulkActionResultStatus;
    reasonCode?: string;
    reason?: string;
}>;

export type SessionBulkActionExecutionResult = Readonly<{
    actionId: SessionBulkActionId;
    targetCount: number;
    results: readonly SessionBulkActionTargetResult[];
    succeeded: readonly SessionBulkActionTargetResult[];
    failed: readonly SessionBulkActionTargetResult[];
    skipped: readonly SessionBulkActionTargetResult[];
    cancelled: readonly SessionBulkActionTargetResult[];
    remainingSelectedKeys: readonly string[];
    progress: SessionBulkActionProgressSnapshot;
}>;

export type SessionBulkServerGroup = Readonly<{
    serverId: string | null;
    targets: readonly SessionBulkActionTarget[];
}>;
