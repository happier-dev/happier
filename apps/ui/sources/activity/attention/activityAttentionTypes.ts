import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import type { SessionListAttentionState } from '@/sync/domains/session/listing/deriveSessionListActivity';

export type SessionActivityAttention = Readonly<{
    session: Session;
    sessionId: string;
    serverId?: string | null;
    serverUrl?: string | null;
    serverName?: string | null;
    route?: string;
    target?: string;
    activityName?: string | null;
    activityInstanceKey?: string | null;
    serverFacts?: Readonly<{
        isKnown: boolean;
        isSaved: boolean;
        isActiveLocal: boolean;
    }>;
    directActionCapability?: Readonly<{
        canExecute: boolean;
        reason: 'allowed' | 'missing_target' | 'server_not_saved' | 'server_not_active' | 'disabled';
    }>;
    surfaceTiming?: ActivitySurfaceTimingBySurface;
    title: string;
    subtitle: string;
    attentionState: SessionListAttentionState;
    hasAttention: boolean;
    priority: number;
    lastTurnCompletedAt: number | null;
    reasons: Readonly<{
        hasUnread: boolean;
        hasPendingPermissionRequests: boolean;
        hasPendingUserActionRequests: boolean;
        hasBlockedPendingDelivery: boolean;
        hasQueuedUserInput: boolean;
        isThinking: boolean;
    }>;
}>;

export type ActivitySurfaceTimingFacts = Readonly<{
    staleAfterMs: number;
    dwellMs: number;
}>;

export type ActivitySurfaceTimingBySurface = Readonly<{
    desktopOverlay: ActivitySurfaceTimingFacts;
    liveActivity: ActivitySurfaceTimingFacts;
    homeWidget: ActivitySurfaceTimingFacts;
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
    fingerprint?: string;
}>;

export type BuildActivityOverviewSnapshotParams = Readonly<{
    sessions: readonly Session[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>;
