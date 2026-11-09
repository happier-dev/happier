import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { isSessionPersonallyTrackedForViewer } from '@/sync/domains/session/readState/sessionViewer';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { areSessionAddressesEqual, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import type { PendingNavigationDetailsResult } from '@/sync/ops/sessionPendingNavigationDetails';
import { buildPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { isPendingNavigationRequestAnswerable, type PendingNavigationTarget } from './buildPendingNavigationFromSource';
import { collectSourceSessions } from './buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { setPendingNavigationLanding, type PendingNavigationResult } from './pendingNavigationRuntime';

export type PendingNavigationRoutePlan =
    | Readonly<{ kind: 'route'; route: string; state: 'pending' | 'settled'; focusTarget: 'transcript' | 'prompt' }>
    | Readonly<{ kind: 'unavailable'; reason: 'details_unavailable' | 'target_unavailable' }>;

export function planPendingNavigationRoute(params: Readonly<{
    target: PendingNavigationTarget;
    details: PendingNavigationDetailsResult;
    nowMs: number;
}>): PendingNavigationRoutePlan {
    const { target, details } = params;
    if (details.kind !== 'available') return { kind: 'unavailable', reason: 'details_unavailable' };
    const { session } = details;
    if (!areSessionAddressesEqual(normalizeSessionAddress(session.serverId, session.id), target.address)
        || session.archivedAt != null
        || !isSessionPersonallyTrackedForViewer(session)) return { kind: 'unavailable', reason: 'target_unavailable' };

    const request = details.requests.find(candidate => candidate.id === target.requestId);
    if (!request) {
        if (!isPendingNavigationRequestAnswerable(session, { kind: target.requestKind, source: target.requestSource })) return { kind: 'unavailable', reason: 'target_unavailable' };
        return {
            kind: 'route', state: 'settled', focusTarget: 'prompt',
            route: buildPermissionToolCallRoute({ ...target.address, location: null }),
        };
    }
    const attention = resolveSessionPersonalAttentionForViewer(session, params.nowMs, details.messages);
    const reason = resolvePendingRequestAttentionReasonV1(request);
    if (attention.presentation === 'status_only' || !attention.reasons.includes(reason)
        || !isPendingNavigationRequestAnswerable(session, request)) return { kind: 'unavailable', reason: 'target_unavailable' };

    // The mounted Session owns transcript hydration and reveal. Next always
    // opens its full context, including requests without a transcript sequence.
    return {
        kind: 'route', state: 'pending', focusTarget: 'prompt',
        route: buildPermissionToolCallRoute({ ...target.address, location: null }),
    };
}

export async function navigateToPendingRequest(params: Readonly<{
    target: PendingNavigationTarget;
    details: Extract<PendingNavigationDetailsResult, { kind: 'available' }>;
    source: ActivityAttentionSource;
    nowMs: number;
    signal?: AbortSignal;
    openRoute: (route: string) => void;
}>): Promise<PendingNavigationResult> {
    if (params.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (!collectSourceSessions(params.source, false, true)
        .some(candidate => areSessionAddressesEqual(candidate.address, params.target.address))) return { status: 'unavailable', reason: 'target_unavailable' };
    const scope = params.source.audienceScopes?.get(params.target.address.serverId);
    if (params.source.audienceScopes && !scope) return { status: 'unavailable', reason: 'scope_changed' };
    // Selection already admitted these details; the mounted destination observes settlement.
    const plan = planPendingNavigationRoute(params);
    if (plan.kind === 'unavailable') return { status: 'unavailable', reason: plan.reason };
    params.openRoute(plan.route);
    setPendingNavigationLanding(params.target.address, params.target.requestId, plan.state, plan.focusTarget, params.target.requestSource);
    return { status: 'opened' };
}
