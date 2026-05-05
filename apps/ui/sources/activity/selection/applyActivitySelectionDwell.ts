import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';

import type { ActivitySurfaceSelectionSpec } from './activitySurfaceSelectionTypes';

export type ActivitySelectionPreviousPrimary = Readonly<{
    sessionId?: string | null;
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

    const previousSessionId = normalizeString(previous.sessionId);
    return previousSessionId !== null && candidate.sessionId === previousSessionId;
}

function isCandidateFresh(
    candidate: SessionActivityAttention,
    nowMs: number,
    staleAfterMs: number | null,
): boolean {
    if (staleAfterMs === null) {
        return true;
    }
    return nowMs - candidate.session.updatedAt < staleAfterMs;
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

    if (params.selectedSessions[0]?.sessionId === previous.sessionId) {
        return params.selectedSessions;
    }

    return [
        previous,
        ...params.selectedSessions.filter((candidate) => candidate.sessionId !== previous.sessionId),
    ].slice(0, params.selectedSessions.length);
}
