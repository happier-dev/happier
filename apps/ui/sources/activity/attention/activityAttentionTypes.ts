import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import type { SessionListAttentionState } from '@/sync/domains/session/listing/deriveSessionListActivity';

export type SessionActivityAttention = Readonly<{
    session: Session;
    sessionId: string;
    title: string;
    subtitle: string;
    attentionState: SessionListAttentionState;
    hasAttention: boolean;
    priority: number;
    reasons: Readonly<{
        hasUnread: boolean;
        hasPendingPermissionRequests: boolean;
        hasPendingUserActionRequests: boolean;
        hasQueuedUserInput: boolean;
        isThinking: boolean;
    }>;
}>;

export type ActivityOverviewCounts = Readonly<{
    unread: number;
    permissionRequired: number;
    actionRequired: number;
    queuedInput: number;
    thinking: number;
    totalAttention: number;
}>;

export type ActivityOverviewSnapshot = Readonly<{
    counts: ActivityOverviewCounts;
    candidates: readonly SessionActivityAttention[];
}>;

export type BuildActivityOverviewSnapshotParams = Readonly<{
    sessions: readonly Session[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>;
