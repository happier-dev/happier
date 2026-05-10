import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS } from '@/utils/sessions/sessionUtils';

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

function isPositiveTimestamp(value: unknown): value is number {
    return isFiniteTimestamp(value) && value > 0;
}

function latestTimestamp(values: readonly unknown[]): number | null {
    let latest: number | null = null;
    for (const value of values) {
        if (!isPositiveTimestamp(value)) continue;
        latest = latest === null ? value : Math.max(latest, value);
    }
    return latest;
}

function hasWaitingActivity(session: Session, signals: PetCompanionSessionSignals | undefined): boolean {
    const isSessionActive = session.active === true;
    return (
        isSessionActive
        && (
            (session.pendingPermissionRequestCount ?? 0) > 0
            || (session.pendingUserActionRequestCount ?? 0) > 0
            || signals?.hasPendingPermissionRequests === true
            || signals?.hasPendingUserActionRequests === true
        )
    );
}

function latestConversationActivityTimestamp(
    session: Session,
    signals: PetCompanionSessionSignals | undefined,
): number | null {
    return latestTimestamp([
        signals?.latestMeaningfulActivityAtMs,
        signals?.latestThinkingActivityAtMs,
        session.thinkingAt,
        session.optimisticThinkingAt,
        session.createdAt,
    ]);
}

function getOptimisticThinkingExpiryAtMs(session: Session, nowMs: number | undefined): number | null {
    const optimisticThinkingAt = session.optimisticThinkingAt ?? null;
    if (!isPositiveTimestamp(optimisticThinkingAt)) return null;
    const expiresAtMs = optimisticThinkingAt + OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS;
    if (isFiniteTimestamp(nowMs) && nowMs >= expiresAtMs) return null;
    return expiresAtMs;
}

function resolveCandidate(
    session: Session,
    signals: PetCompanionSessionSignals | undefined,
    nowMs: number | undefined,
): SessionActivityCandidate | null {
    if (hasWaitingActivity(session, signals)) {
        const activityAtMs = latestConversationActivityTimestamp(session, signals);
        return {
            session,
            status: 'waiting',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.waiting,
        };
    }

    if (signals?.hasFailure) {
        const activityAtMs = latestConversationActivityTimestamp(session, signals);
        return {
            session,
            status: 'failed',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.failed,
        };
    }

    if (signals?.hasUnreadMessages) {
        const activityAtMs = latestConversationActivityTimestamp(session, signals);
        return {
            session,
            status: 'waiting',
            activityAtMs,
            expiresAtMs: null,
        };
    }

    const isInThinkingGrace =
        isPositiveTimestamp(session.thinkingGraceUntil)
        && (!isFiniteTimestamp(nowMs) || session.thinkingGraceUntil > nowMs);
    const optimisticThinkingExpiryAtMs = getOptimisticThinkingExpiryAtMs(session, nowMs);
    const isOptimisticThinking = optimisticThinkingExpiryAtMs !== null;

    if (session.thinking || isInThinkingGrace || isOptimisticThinking) {
        const activityAtMs = session.thinking
            ? latestTimestamp([
                signals?.latestThinkingActivityAtMs,
                session.thinkingAt,
                session.optimisticThinkingAt,
                session.createdAt,
            ])
            : latestTimestamp([
                signals?.latestThinkingActivityAtMs,
                session.thinkingAt,
                session.optimisticThinkingAt,
                session.createdAt,
            ]);
        const runningExpiresAtMs = session.thinking
            ? null
            : isInThinkingGrace
                ? session.thinkingGraceUntil ?? null
                : optimisticThinkingExpiryAtMs;
        return {
            session,
            status: 'running',
            activityAtMs,
            expiresAtMs: runningExpiresAtMs,
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

function createTrayItem(
    candidate: SessionActivityCandidate,
    signals: PetCompanionSessionSignals | undefined,
): PetCompanionTrayItem {
    const dismissKey = createDismissKey(candidate);
    return {
        id: dismissKey,
        dismissKey,
        sessionId: candidate.session.id,
        status: candidate.status,
        priority: PET_COMPANION_ACTIVITY_PRIORITY[candidate.status],
        title: getSessionName(candidate.session),
        subtitle: signals?.lastMessageSubtitle ?? null,
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
        .map((session) => {
            const signals = input.signalsBySessionId?.[session.id];
            const candidate = resolveCandidate(session, signals, input.nowMs);
            return candidate ? { candidate, signals } : null;
        })
        .filter((entry): entry is Readonly<{
            candidate: SessionActivityCandidate;
            signals: PetCompanionSessionSignals | undefined;
        }> => entry !== null)
        .filter(({ candidate }) => !isExpired(candidate, input.nowMs))
        .map(({ candidate, signals }) => createTrayItem(candidate, signals))
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
