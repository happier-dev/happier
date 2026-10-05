import { buildMessageRouteId } from '@happier-dev/session-core/messages';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol';
import { isSessionPersonallyTrackedForViewer } from '@/sync/domains/session/readState/sessionViewer';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { areSessionAddressesEqual, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { readPendingNavigationDetails, type PendingNavigationDetailsResult } from '@/sync/ops/sessionPendingNavigationDetails';
import { resolvePermissionToolCallLocations } from '@/utils/sessions/permissions/resolvePermissionToolCallLocations';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { isPendingNavigationRequestAnswerable, type PendingNavigationTarget } from './buildPendingNavigationFromSource';
import { collectSourceSessions } from './buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { setPendingNavigationLanding, type PendingNavigationResult } from './pendingNavigationRuntime';

export type PendingNavigationRoutePlan =
    | Readonly<{ kind: 'route'; route: string; state: 'pending' | 'settled'; focusTarget: 'transcript' | 'prompt' }>
    | Readonly<{ kind: 'unavailable' }>;

export function planPendingNavigationRoute(params: Readonly<{
    target: PendingNavigationTarget;
    details: PendingNavigationDetailsResult;
    nowMs: number;
}>): PendingNavigationRoutePlan {
    const { target, details } = params;
    if (details.kind !== 'available') return { kind: 'unavailable' };
    const { session } = details;
    if (!areSessionAddressesEqual(normalizeSessionAddress(session.serverId, session.id), target.address)
        || session.archivedAt != null
        || !isSessionPersonallyTrackedForViewer(session)) return { kind: 'unavailable' };

    const request = details.requests.find(candidate => candidate.id === target.requestId);
    if (!request) {
        if (!isPendingNavigationRequestAnswerable(session, { kind: target.requestKind, source: target.requestSource })) return { kind: 'unavailable' };
        return {
            kind: 'route', state: 'settled', focusTarget: 'prompt',
            route: buildPermissionToolCallRoute({ ...target.address, location: null }),
        };
    }
    const attention = resolveSessionPersonalAttentionForViewer(session, params.nowMs, details.messages);
    const reason = resolvePendingRequestAttentionReasonV1(request);
    if (attention.presentation === 'status_only' || !attention.reasons.includes(reason)
        || !isPendingNavigationRequestAnswerable(session, request)) return { kind: 'unavailable' };

    const messagesById = Object.fromEntries(details.messages.map(message => [message.id, message]));
    const location = resolvePermissionToolCallLocations({
        permissionIds: [request.id],
        messageIdsOldestFirst: details.messages.map(message => message.id),
        messagesById,
        resolveRouteMessageId: (_id, message) => message ? buildMessageRouteId(message) : null,
    }).get(request.id) ?? null;
    if (location && !canOpenPermissionToolCallRoute(location)) return { kind: 'unavailable' };
    return {
        kind: 'route', state: 'pending', focusTarget: location ? 'transcript' : 'prompt',
        route: buildPermissionToolCallRoute({ ...target.address, location }),
    };
}

export async function navigateToPendingRequest(params: Readonly<{
    target: PendingNavigationTarget;
    details?: Extract<PendingNavigationDetailsResult, { kind: 'available' }>;
    source: ActivityAttentionSource;
    nowMs: number;
    signal?: AbortSignal;
    openRoute: (route: string) => void;
}>): Promise<PendingNavigationResult> {
    if (params.signal?.aborted || !collectSourceSessions(params.source, false, true)
        .some(candidate => areSessionAddressesEqual(candidate.address, params.target.address))) return { status: 'unavailable' };
    const scope = params.source.audienceScopes?.get(params.target.address.serverId);
    if (params.source.audienceScopes && !scope) return { status: 'unavailable' };
    const details = await readPendingNavigationDetails(params.target.address, scope, {
        signal: params.signal, reuse: params.details, locateRequestId: params.target.requestId,
    });
    if (params.signal?.aborted) return { status: 'unavailable' };
    const plan = planPendingNavigationRoute({ ...params, details });
    if (plan.kind === 'unavailable') return { status: 'unavailable' };
    params.openRoute(plan.route);
    setPendingNavigationLanding(params.target.address, params.target.requestId, plan.state, plan.focusTarget);
    return { status: 'opened' };
}
