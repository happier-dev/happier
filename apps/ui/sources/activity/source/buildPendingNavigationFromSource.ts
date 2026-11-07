import { comparePendingRequestsByAge, type SessionPendingRequest } from '@happier-dev/session-core/pending';
import { areSessionAddressesEqual, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionPresentationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionPersonalAttentionExpirationsForViewer, resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { isTranscriptPendingRequestAnswerable as isPendingNavigationRequestAnswerable } from '@/utils/sessions/deriveTranscriptInteraction';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { collectSourceSessions } from './buildActivityOverviewFromSource';

/** What the session waits on, from the same viewer attention that admits it (a permission wins over input). */
export type PendingNavigationWaitsFor = 'permission' | 'input';
export type PendingNavigationCandidate = Readonly<{ address: SessionAddress; session: SessionPresentationRecord; waitsFor: PendingNavigationWaitsFor }>;
export type PendingNavigationTarget = Readonly<{
    address: SessionAddress;
    requestId: string;
    requestKind: SessionPendingRequest['kind'];
    requestSource?: string;
    createdAt: number | null;
}>;

export { isPendingNavigationRequestAnswerable };

/** Viewer admission and access stay with their existing owners, never the broad Inbox count. */
export function buildPendingNavigationFromSource(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    excluding?: SessionAddress | null;
}>): readonly PendingNavigationCandidate[] {
    return buildPendingNavigationOverviewFromSource(params).candidates;
}

export type PendingNavigationEntry = Readonly<{ candidate: PendingNavigationCandidate; nextAttentionBoundaryMs: number | null }>;

/** Each pending candidate among an exact address subset (all of them when omitted), by address key. */
export function classifyPendingNavigationCandidates(source: ActivityAttentionSource, nowMs: number,
    addresses?: readonly SessionAddress[]): ReadonlyMap<string, PendingNavigationEntry> {
    const entries = new Map<string, PendingNavigationEntry>();
    for (const { address, session, presentationSource } of collectSourceSessions(source, false, true, addresses)) {
        if (!isSessionContentReadable(readSessionContentAvailability(session))) continue;
        // Explicit messages avoid borrowing an active Home's same-ID transcript. This
        // summary-only projection must never hydrate or scan messages just to count.
        const attention = resolveSessionPersonalAttentionForViewer(session, nowMs, [], undefined, undefined, presentationSource);
        // The list producer suppresses inactive native prompts, retaining only
        // shared-metadata Action confirmations in its permission summary.
        const active = presentationSource?.lifecycle.active ?? session.active;
        const interaction = { active, access: session.access };
        const inactiveAction = active !== true
            && source.sessionListRowsByServerId[address.serverId]?.[address.sessionId]?.hasPendingPermissionRequests === true;
        const permission = attention.reasons.includes('permission_required') && isPendingNavigationRequestAnswerable(interaction, {
            kind: 'permission', ...(inactiveAction ? { source: 'happier_action' } : {}),
        });
        const input = attention.reasons.includes('user_action_required') && isPendingNavigationRequestAnswerable(interaction, { kind: 'user_action' });
        if (!permission && !input) continue;
        if (attention.presentation === 'status_only') continue;
        let nextAttentionBoundaryMs: number | null = null;
        for (const expiresAtMs of readSessionPersonalAttentionExpirationsForViewer(session, nowMs, [], presentationSource)) {
            if (expiresAtMs > nowMs && (nextAttentionBoundaryMs === null || expiresAtMs < nextAttentionBoundaryMs)) {
                nextAttentionBoundaryMs = expiresAtMs;
            }
        }
        entries.set(sessionAddressKey(address), {
            candidate: { address, session, waitsFor: permission ? 'permission' : 'input' },
            nextAttentionBoundaryMs,
        });
    }
    return entries;
}

export function buildPendingNavigationOverviewFromSource(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    excluding?: SessionAddress | null;
}>): Readonly<{ candidates: readonly PendingNavigationCandidate[]; nextAttentionBoundaryMs: number | null }> {
    let nextAttentionBoundaryMs: number | null = null;
    const candidates: PendingNavigationCandidate[] = [];
    for (const entry of classifyPendingNavigationCandidates(params.source, params.nowMs).values()) {
        if (areSessionAddressesEqual(entry.candidate.address, params.excluding)) continue;
        candidates.push(entry.candidate);
        if (entry.nextAttentionBoundaryMs !== null
            && (nextAttentionBoundaryMs === null || entry.nextAttentionBoundaryMs < nextAttentionBoundaryMs)) {
            nextAttentionBoundaryMs = entry.nextAttentionBoundaryMs;
        }
    }
    return { candidates, nextAttentionBoundaryMs };
}

export function selectPendingNavigationTarget(targets: readonly PendingNavigationTarget[]): PendingNavigationTarget | null {
    let oldest: PendingNavigationTarget | null = null;
    for (const target of targets) {
        if (oldest === null) {
            oldest = target;
            continue;
        }
        const age = comparePendingRequestsByAge(
            { id: target.requestId, createdAt: target.createdAt },
            { id: oldest.requestId, createdAt: oldest.createdAt },
        );
        if (age < 0 || (age === 0 && sessionAddressKey(target.address) < sessionAddressKey(oldest.address))) oldest = target;
    }
    return oldest;
}
