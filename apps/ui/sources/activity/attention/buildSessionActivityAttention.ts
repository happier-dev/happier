import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import type { Message } from "@happier-dev/session-core/messages";
import { readSessionListPresentationDisplay, type SessionPresentationRecord, type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { isUnreadContentAttentionReason } from '@/sync/domains/session/readState/sessionViewer';
import { getSessionName, getSessionSubtitle, presentSessionAwarenessV1, readLockedSessionName } from '@/utils/sessions/sessionUtils';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionAwarenessPresentationRankV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { sessionWorkStatusFactsFromStatus } from '@/components/work/status/sessionWorkStatusFacts';

import { readSessionTurnCompletedAt } from '@/sync/domains/session/sessionLifecycleProjection';

import type { SessionActivityAttention } from './activityAttentionTypes';
import { isSessionAdmittedToPersonalActivity } from './isSessionAdmittedToPersonalActivity';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

export function buildSessionActivityAttention<T extends SessionPresentationRecord>(params: Readonly<{
    session: T;
    presentationSource?: SessionListPresentationSource;
    sessionMessages?: readonly Message[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
    /** Count/status consumers use the same facts without private display details. */
    presentation?: 'detail' | 'summary';
    followRulePolicies?: readonly FollowPolicyV1[];
}>): SessionActivityAttention & Readonly<{ session: T }> {
    const nowMs = params.nowMs ?? Date.now();
    const source = params.presentationSource ? { ...params.presentationSource, messages: params.sessionMessages } : undefined;
    const lifecycle = source?.lifecycle ?? params.session;
    const display = source ? readSessionListPresentationDisplay(source) : params.session;
    const followRulePolicies = params.followRulePolicies;
    const personal = resolveSessionPersonalAttentionForViewer(params.session, nowMs, params.sessionMessages, followRulePolicies, source);
    const personalReasons = personal.reasons.filter((reason) => {
        if (reason === 'unread' || reason === 'unread_discussion' || reason === 'ready_after_read') return params.sessionOptions?.showUnread !== false;
        if (reason === 'permission_required') return params.sessionOptions?.showPendingPermissionRequests !== false;
        if (reason === 'user_action_required') return params.sessionOptions?.showPendingUserActionRequests !== false;
        return true;
    });
    const includeDisplayDetails = params.presentation !== 'summary';
    const awareness = projectUiSessionAwareness(params.session, nowMs, {
        presentationSource: source,
        includeTitle: includeDisplayDetails,
        includeWorkspace: includeDisplayDetails,
    });
    // In-app rows name what this device opened. The viewer's `status_only` is the Home's
    // notification-preview ceiling (it sees no recipient envelope, so it cannot vouch); off-app
    // surfaces apply it themselves (`buildActivitySurfaceViewModel`).
    const mayShowPrivateContent = isSessionAwarenessContentReadableV1(awareness.encryption);
    const admitted = isSessionAdmittedToPersonalActivity(params.session, followRulePolicies);
    const operational = admitted ? awareness.operational.primary : 'none';
    const personalAttention = personalReasons.length === personal.reasons.length ? personal : {
        ...personal, reasons: personalReasons, needsAttention: personal.needsAttention && personalReasons.length > 0,
        primary: personalReasons[0] ?? null,
    };
    const presented = presentSessionAwarenessV1({ ...awareness, viewer: { attention: personalAttention } });
    const facts = sessionWorkStatusFactsFromStatus(params.session, {
        awareness, state: presented.state, statusText: includeDisplayDetails ? presented.statusText : '',
    }, { nowMs, personalAttention, presentationSource: source });
    const workStatus = resolveWorkStatusTone({ kind: 'session', facts });
    const attentionState = presented.state;
    const address = normalizeSessionAddress(source?.serverId ?? params.session.serverId, params.session.id);
    return {
        session: params.session,
        ...(source ? { presentationSource: source } : {}),
        meaningfulActivityAt: resolveSessionListRenderableMeaningfulActivityAt({ ...lifecycle, createdAt: params.session.createdAt }),
        awareness,
        sessionId: params.session.id,
        ...(address ? { address, serverId: address.serverId } : null),
        title: !includeDisplayDetails ? '' : mayShowPrivateContent ? getSessionName(display) : readLockedSessionName(),
        subtitle: includeDisplayDetails && mayShowPrivateContent ? getSessionSubtitle(display) : '',
        attentionState,
        workStatus,
        personalAttention,
        ...(followRulePolicies?.length ? { followRulePolicies } : {}),
        hasAttention: personal.needsAttention && personalReasons.length > 0,
        priority: readSessionAwarenessPresentationRankV1(attentionState),
        lastTurnCompletedAt: readSessionTurnCompletedAt(lifecycle),
        reasons: {
            hasUnread: personalReasons.some(isUnreadContentAttentionReason),
            hasPendingPermissionRequests: personalReasons.includes('permission_required'),
            hasPendingUserActionRequests: personalReasons.includes('user_action_required'),
            hasBlockedPendingDelivery: personalReasons.includes('pending_blocked'),
            hasQueuedUserInput: admitted && (lifecycle.pendingCount ?? 0) > 0,
            isThinking: operational === 'working',
        },
    };
}
