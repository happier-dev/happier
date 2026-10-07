import { comparePendingRequestsByAge, type SessionPendingRequest } from '@happier-dev/session-core/pending';
import { isPendingRequestAnswerableV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { areSessionAddressesEqual, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { collectSourceSessions } from './buildActivityOverviewFromSource';

/** What the session waits on, from the same viewer attention that admits it (a permission wins over input). */
export type PendingNavigationWaitsFor = 'permission' | 'input';
export type PendingNavigationCandidate = Readonly<{ address: SessionAddress; session: Session; waitsFor: PendingNavigationWaitsFor }>;
export type PendingNavigationTarget = Readonly<{
    address: SessionAddress;
    requestId: string;
    requestKind: SessionPendingRequest['kind'];
    requestSource?: string;
    createdAt: number | null;
}>;

export function isPendingNavigationRequestAnswerable(session: Session, request: Pick<SessionPendingRequest, 'kind' | 'source'>): boolean {
    const interaction = deriveTranscriptInteractionFromSession(session);
    return isPendingRequestAnswerableV1(request, {
        canSubmitAgentInput: interaction.canSendMessages, canApprovePermissions: interaction.canApprovePermissions,
    });
}

/** Viewer admission and access stay with their existing owners, never the broad Inbox count. */
export function buildPendingNavigationFromSource(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    excluding?: SessionAddress | null;
    /** Invocation reports unavailable candidates; summary controls count answerable ones only. */
    includeUnavailable?: boolean;
}>): readonly PendingNavigationCandidate[] {
    return collectSourceSessions(params.source, false, true).flatMap(({ address, session }) => {
        if (areSessionAddressesEqual(address, params.excluding)) return [];
        // Explicit messages avoid borrowing an active Home's same-ID transcript. This
        // summary-only projection must never hydrate or scan messages just to count.
        const attention = resolveSessionPersonalAttentionForViewer(session, params.nowMs, []);
        const permission = attention.reasons.includes('permission_required') && isPendingNavigationRequestAnswerable(session, { kind: 'permission' });
        const input = attention.reasons.includes('user_action_required') && isPendingNavigationRequestAnswerable(session, { kind: 'user_action' });
        if (!permission && !input) return [];
        if (!params.includeUnavailable && attention.presentation === 'status_only') return [];
        return [{ address, session, waitsFor: permission ? 'permission' as const : 'input' as const }];
    });
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
