import { getActiveViewingSessionActivationId, getActiveViewingSessionId } from '../activeViewingSession';

export type SessionManualUnreadHold = Readonly<{
    sessionId: string;
    heldAtSeq: number;
    activationId: number;
}>;

let nextActivationId = 1;
const activeActivationsBySessionId = new Map<string, Set<number>>();
const holdsByKey = new Map<string, SessionManualUnreadHold>();

function activationKey(sessionId: string, activationId: number): string {
    return `${sessionId}:${activationId}`;
}

function normalizeActivationId(activationId: number | null | undefined): number | null {
    return typeof activationId === 'number' && Number.isFinite(activationId)
        ? Math.trunc(activationId)
        : null;
}

function isActivationActive(sessionId: string, activationId: number): boolean {
    return activeActivationsBySessionId.get(sessionId)?.has(activationId) === true;
}

function garbageCollectInactiveHolds(sessionId: string): void {
    for (const [key, hold] of holdsByKey) {
        if (hold.sessionId !== sessionId) continue;
        if (!isActivationActive(sessionId, hold.activationId)) {
            holdsByKey.delete(key);
        }
    }
}

export function beginSessionViewingActivation(sessionId: string): number {
    const activationId = nextActivationId++;
    const activeForSession = activeActivationsBySessionId.get(sessionId) ?? new Set<number>();
    activeForSession.add(activationId);
    activeActivationsBySessionId.set(sessionId, activeForSession);
    garbageCollectInactiveHolds(sessionId);
    return activationId;
}

export function endSessionViewingActivation(sessionId: string, activationId: number): void {
    const activeForSession = activeActivationsBySessionId.get(sessionId);
    activeForSession?.delete(activationId);
    if (activeForSession?.size === 0) {
        activeActivationsBySessionId.delete(sessionId);
    }
    holdsByKey.delete(activationKey(sessionId, activationId));
}

export function holdManualUnreadForActivation(params: {
    sessionId: string;
    sessionSeq: number;
    activationId: number | null;
}): void {
    const activationId = normalizeActivationId(params.activationId);
    if (activationId === null || !isActivationActive(params.sessionId, activationId)) {
        return;
    }
    holdsByKey.set(activationKey(params.sessionId, activationId), {
        sessionId: params.sessionId,
        heldAtSeq: Math.max(0, Math.trunc(params.sessionSeq)),
        activationId,
    });
}

export function shouldSuppressAutomaticMarkViewed(params: {
    sessionId: string;
    sessionSeq: number;
    activationId: number | null;
}): boolean {
    const activationId = normalizeActivationId(params.activationId);
    if (activationId === null) return false;
    const hold = holdsByKey.get(activationKey(params.sessionId, activationId));
    if (!hold) return false;
    return Math.max(0, Math.trunc(params.sessionSeq)) >= hold.heldAtSeq;
}

export function clearManualUnreadHold(params: {
    sessionId: string;
    activationId?: number | null;
}): void {
    if (!Object.prototype.hasOwnProperty.call(params, 'activationId')) {
        if (getActiveViewingSessionId() !== params.sessionId) {
            return;
        }
        const activeActivationId = normalizeActivationId(getActiveViewingSessionActivationId());
        if (activeActivationId === null) {
            return;
        }
        holdsByKey.delete(activationKey(params.sessionId, activeActivationId));
        return;
    }

    const activationId = normalizeActivationId(params.activationId);
    if (activationId === null) {
        for (const [key, hold] of holdsByKey) {
            if (hold.sessionId === params.sessionId) {
                holdsByKey.delete(key);
            }
        }
        return;
    }
    holdsByKey.delete(activationKey(params.sessionId, activationId));
}

export function resetSessionManualUnreadHoldsForTests(): void {
    nextActivationId = 1;
    activeActivationsBySessionId.clear();
    holdsByKey.clear();
}
