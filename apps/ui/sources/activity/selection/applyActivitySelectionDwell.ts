import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';

import type { ActivitySurfaceSelectionSpec } from './activitySurfaceSelectionTypes';
import {
    areSessionAddressesEqual,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

export type ActivitySelectionPreviousPrimary = Readonly<{
    address?: SessionAddress | null;
    activityInstanceKey?: string | null;
    changedAtMs?: number | null;
}>;

function normalizeString(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function normalizeNonNegativeNumber(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : null;
}

function candidateMatchesPrevious(
    candidate: SessionActivityAttention,
    previous: ActivitySelectionPreviousPrimary,
): boolean {
    const previousActivityInstanceKey = normalizeString(previous.activityInstanceKey);
    if (previousActivityInstanceKey) {
        return normalizeString(candidate.activityInstanceKey) === previousActivityInstanceKey;
    }

    if (previous.address) {
        return areSessionAddressesEqual(candidate.address, previous.address);
    }

    return false;
}

function isCandidateFresh(
    candidate: SessionActivityAttention,
    nowMs: number,
    staleAfterMs: number | null,
): boolean {
    if (staleAfterMs === null) {
        return true;
    }
    const observation = candidate.address ? sessionRuntimeObservations.read(candidate.address) : undefined;
    return nowMs - Math.max(candidate.presentationSource?.lifecycle.updatedAt ?? candidate.session.updatedAt, observation?.activeAt ?? 0) < staleAfterMs;
}

export function applyActivitySelectionDwell(params: Readonly<{
    eligibleSessions: readonly SessionActivityAttention[];
    selectedSessions: readonly SessionActivityAttention[];
    selection: Pick<ActivitySurfaceSelectionSpec, 'dwellMs' | 'staleAfterMs'>;
    previousPrimary: ActivitySelectionPreviousPrimary;
    nowMs?: number;
}>): readonly SessionActivityAttention[] {
    if (params.selectedSessions.length === 0 || params.eligibleSessions.length === 0) {
        return params.selectedSessions;
    }

    const dwellMs = normalizeNonNegativeNumber(params.selection.dwellMs);
    const changedAtMs = normalizeNonNegativeNumber(params.previousPrimary.changedAtMs);
    if (dwellMs === null || changedAtMs === null) {
        return params.selectedSessions;
    }

    const nowMs = params.nowMs ?? Date.now();
    if (nowMs - changedAtMs >= dwellMs) {
        return params.selectedSessions;
    }

    const previous = params.eligibleSessions.find((candidate) =>
        candidateMatchesPrevious(candidate, params.previousPrimary),
    );
    if (!previous || !isCandidateFresh(previous, nowMs, normalizeNonNegativeNumber(params.selection.staleAfterMs))) {
        return params.selectedSessions;
    }

    if (
        params.selectedSessions[0] === previous
        || areSessionAddressesEqual(params.selectedSessions[0]?.address, previous.address)
    ) {
        return params.selectedSessions;
    }

    return [
        previous,
        ...params.selectedSessions.filter((candidate) => (
            candidate !== previous
            && !areSessionAddressesEqual(candidate.address, previous.address)
        )),
    ].slice(0, params.selectedSessions.length);
}
