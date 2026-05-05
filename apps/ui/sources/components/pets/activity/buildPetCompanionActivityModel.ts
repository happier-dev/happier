import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import {
    PET_COMPANION_ACTIVITY_EXPIRY_MS,
    PET_COMPANION_ACTIVITY_PRIORITY,
} from './petCompanionActivityConstants';
import type {
    BuildPetCompanionActivityModelInput,
    PetCompanionActivityModel,
    PetCompanionActivityStatus,
    PetCompanionSessionSignals,
    PetCompanionTrayItem,
} from './petCompanionActivityTypes';

type SessionActivityCandidate = Readonly<{
    session: Session;
    status: Exclude<PetCompanionActivityStatus, 'idle'>;
    activityAtMs: number | null;
    expiresAtMs: number | null;
}>;

function normalizeDismissedKeys(input: BuildPetCompanionActivityModelInput): ReadonlySet<string> {
    const keys = input.dismissedTrayItemKeys;
    if (!keys) return new Set<string>();
    return keys instanceof Set ? keys : new Set(keys);
}

function isFiniteTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function latestTimestamp(values: readonly unknown[]): number | null {
    let latest: number | null = null;
    for (const value of values) {
        if (!isFiniteTimestamp(value)) continue;
        latest = latest === null ? value : Math.max(latest, value);
    }
    return latest;
}

function hasWaitingActivity(session: Session, signals: PetCompanionSessionSignals | undefined): boolean {
    return (
        (session.pendingPermissionRequestCount ?? 0) > 0
        || (session.pendingUserActionRequestCount ?? 0) > 0
        || (session.pendingCount ?? 0) > 0
        || (signals?.pendingMessageCount ?? 0) > 0
    );
}

function resolveCandidate(
    session: Session,
    signals: PetCompanionSessionSignals | undefined,
): SessionActivityCandidate | null {
    if (hasWaitingActivity(session, signals)) {
        const activityAtMs = latestTimestamp([
            signals?.latestMeaningfulActivityAtMs,
            session.updatedAt,
            session.activeAt,
            session.createdAt,
        ]);
        return {
            session,
            status: 'waiting',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.waiting,
        };
    }

    if (signals?.hasFailure) {
        const activityAtMs = latestTimestamp([
            signals.latestMeaningfulActivityAtMs,
            session.updatedAt,
            session.activeAt,
            session.createdAt,
        ]);
        return {
            session,
            status: 'failed',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.failed,
        };
    }

    if (signals?.hasUnreadMessages) {
        const activityAtMs = latestTimestamp([
            signals.latestMeaningfulActivityAtMs,
            session.updatedAt,
            session.activeAt,
            session.createdAt,
        ]);
        return {
            session,
            status: 'review',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.review,
        };
    }

    if (session.thinking || isFiniteTimestamp(signals?.latestThinkingActivityAtMs)) {
        const activityAtMs = session.thinking
            ? latestTimestamp([
                signals?.latestThinkingActivityAtMs,
                session.thinkingAt,
                session.updatedAt,
                session.activeAt,
                session.createdAt,
            ])
            : latestTimestamp([
                signals?.latestThinkingActivityAtMs,
                session.thinkingAt,
            ]);
        return {
            session,
            status: 'running',
            activityAtMs,
            expiresAtMs: session.thinking || activityAtMs === null
                ? null
                : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.running,
        };
    }

    return null;
}

function isExpired(candidate: SessionActivityCandidate, nowMs: number | undefined): boolean {
    if (!isFiniteTimestamp(nowMs)) return false;
    return candidate.expiresAtMs !== null && nowMs > candidate.expiresAtMs;
}

function createDismissKey(candidate: SessionActivityCandidate): string {
    return [
        candidate.status,
        candidate.session.id,
        candidate.activityAtMs === null ? 'live' : String(candidate.activityAtMs),
    ].join(':');
}

function createTrayItem(candidate: SessionActivityCandidate): PetCompanionTrayItem {
    const dismissKey = createDismissKey(candidate);
    return {
        id: dismissKey,
        dismissKey,
        sessionId: candidate.session.id,
        status: candidate.status,
        priority: PET_COMPANION_ACTIVITY_PRIORITY[candidate.status],
        title: getSessionName(candidate.session),
        subtitle: getSessionSubtitle(candidate.session),
        activityAtMs: candidate.activityAtMs,
        expiresAtMs: candidate.expiresAtMs,
        actions: {
            open: true,
            dismiss: true,
            quickReply: true,
        },
    };
}

function compareTrayItems(
    selectedSessionId: string,
    a: PetCompanionTrayItem,
    b: PetCompanionTrayItem,
): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.sessionId === selectedSessionId && b.sessionId !== selectedSessionId) return -1;
    if (b.sessionId === selectedSessionId && a.sessionId !== selectedSessionId) return 1;
    const aActivity = a.activityAtMs ?? Number.NEGATIVE_INFINITY;
    const bActivity = b.activityAtMs ?? Number.NEGATIVE_INFINITY;
    if (aActivity !== bActivity) return bActivity - aActivity;
    return a.sessionId.localeCompare(b.sessionId);
}

function selectFallbackSession(input: BuildPetCompanionActivityModelInput): Session | null {
    const selectedId = typeof input.selectedSessionId === 'string' ? input.selectedSessionId : '';
    if (selectedId) {
        const selected = input.sessions.find((session) => session.id === selectedId);
        if (selected) return selected;
    }
    return input.sessions.find((session) => session.active) ?? input.sessions[0] ?? null;
}

export function buildPetCompanionActivityModel(
    input: BuildPetCompanionActivityModelInput,
): PetCompanionActivityModel {
    const selectedSessionId = typeof input.selectedSessionId === 'string' ? input.selectedSessionId : '';
    const dismissedKeys = normalizeDismissedKeys(input);
    const trayItems = input.sessions
        .map((session) => resolveCandidate(session, input.signalsBySessionId?.[session.id]))
        .filter((candidate): candidate is SessionActivityCandidate => candidate !== null)
        .filter((candidate) => !isExpired(candidate, input.nowMs))
        .map(createTrayItem)
        .filter((item) => !dismissedKeys.has(item.dismissKey))
        .sort((a, b) => compareTrayItems(selectedSessionId, a, b));
    const primary = trayItems[0] ?? null;

    if (primary) {
        return {
            state: primary.status,
            reason: primary.status,
            sessionId: primary.sessionId,
            trayItems,
        };
    }

    const fallbackSession = selectFallbackSession(input);
    return {
        state: 'idle',
        reason: 'idle',
        sessionId: fallbackSession?.id ?? null,
        trayItems,
    };
}
