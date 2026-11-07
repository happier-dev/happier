import type {
    SessionAwarenessProjectionV1} from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type {
    SessionPersonalAttentionProjectionV1,
} from '@happier-dev/protocol/sessions/personal/attention';
import type { SessionPresentationRecord, SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import type { SessionAwarenessPresentationStateV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionContextPresentation } from '@/sync/domains/session/presentation/sessionContextPresentation';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionFollowPersonRulePendingState } from '@/components/sessions/follow/sessionFollowSourcePresentation';

export type SessionActivityAttention = Readonly<{
    session: SessionPresentationRecord;
    presentationSource?: SessionListPresentationSource;
    meaningfulActivityAt?: number;
    awareness: SessionAwarenessProjectionV1;
    sessionId: string;
    address?: SessionAddress | null;
    context?: SessionContextPresentation | null;
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
    attentionState: SessionAwarenessPresentationStateV1;
    workStatus: WorkStatusPresentation;
    /** Canonical viewer-facing reasons; downstream surfaces classify, never re-derive them. */
    personalAttention: SessionPersonalAttentionProjectionV1;
    /** Private rule matches admitted by the existing source evaluator, never viewer mutations. */
    followRulePolicies?: readonly FollowPolicyV1[];
    /** Known receiver-side rule work; presentation never turns it into personal attention. */
    followRuleEvaluationState?: SessionFollowPersonRulePendingState;
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
    thinking: number;
    totalAttention: number;
}>;

export type ActivityOverviewSnapshot = Readonly<{
    counts: ActivityOverviewCounts;
    candidates: readonly SessionActivityAttention[];
    fingerprint?: string;
}>;

export type BuildActivityOverviewSnapshotParams = Readonly<{
    sessions: readonly SessionPresentationRecord[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>;
