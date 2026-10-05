import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { buildPendingNavigationFromSource, isPendingNavigationRequestAnswerable, selectPendingNavigationTarget, type PendingNavigationTarget } from './buildPendingNavigationFromSource';
import { areSessionAddressesEqual, normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readPendingNavigationDetails, type PendingNavigationDetailsResult } from '@/sync/ops/sessionPendingNavigationDetails';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { isSessionPersonallyTrackedForViewer } from '@/sync/domains/session/readState/sessionViewer';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol';

export type NextPendingRequestResult =
    | Readonly<{ kind: 'target'; unavailableCount: number;
        details: Extract<PendingNavigationDetailsResult, { kind: 'available' }> } & PendingNavigationTarget>
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'unavailable'; reason: 'not_ready' | 'cancelled' | 'details_unavailable' }>;

export async function nextPendingRequest(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    excluding?: SessionAddress | null;
    signal?: AbortSignal;
}>): Promise<NextPendingRequestResult> {
    if (params.signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    if (!params.source.isDataReady) return { kind: 'unavailable', reason: 'not_ready' };
    const candidates = buildPendingNavigationFromSource({ ...params, includeUnavailable: true });
    const details = await Promise.all(candidates.map(async candidate => {
        const scope = params.source.audienceScopes?.get(candidate.address.serverId);
        // A mounted Home binding may still be resolving or already retired. It
        // must not be replaced by whichever Account now owns those credentials.
        if (params.source.audienceScopes && !scope) return { candidate, result: null };
        return { candidate, result: await readPendingNavigationDetails(candidate.address, scope, { signal: params.signal }) };
    }));
    if (params.signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    let unavailableCount = 0;
    const targets: PendingNavigationTarget[] = [];
    for (const { candidate, result } of details) {
        if (!result || result.kind !== 'available') {
            unavailableCount++;
            continue;
        }
        const { session } = result;
        if (!areSessionAddressesEqual(normalizeSessionAddress(session.serverId, session.id), candidate.address)) {
            unavailableCount++;
            continue;
        }
        if (session.archivedAt != null || !isSessionPersonallyTrackedForViewer(session)) continue;
        const attention = resolveSessionPersonalAttentionForViewer(session, params.nowMs, result.messages);
        if (attention.presentation === 'status_only') {
            unavailableCount++;
            continue;
        }
        for (const request of result.requests) {
            const reason = resolvePendingRequestAttentionReasonV1(request);
            if (attention.reasons.includes(reason) && isPendingNavigationRequestAnswerable(session, request)) {
                targets.push({ address: candidate.address, requestId: request.id, requestKind: request.kind,
                    ...(request.source ? { requestSource: request.source } : {}), createdAt: request.createdAt });
            }
        }
    }
    const target = selectPendingNavigationTarget(targets);
    const selectedDetails = target ? details.find(({ candidate }) => areSessionAddressesEqual(candidate.address, target.address))?.result : null;
    return target && selectedDetails?.kind === 'available' ? { kind: 'target', ...target, unavailableCount, details: selectedDetails }
        : unavailableCount > 0 ? { kind: 'unavailable', reason: 'details_unavailable' } : { kind: 'none' };
}
