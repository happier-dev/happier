import { normalizeSessionMessagePinLabel } from './sessionMessagePinDisplay';
import { parseStableSessionMessageRouteId } from '../messageRouteIds';
import {
    buildSessionMessagePinFallbackIdentity,
    buildSessionMessagePinIdentity,
    normalizeSessionMessagePinRouteMessageId,
    normalizeSessionMessagePinRole,
    normalizeSessionMessagePinSeq,
    normalizeSessionMessagePinSessionId,
    normalizeSessionMessagePinTranscriptBlockIndex,
    sessionMessagePinFallbackIdentityKey,
    sessionMessagePinIdentityKey,
    sessionMessagePinRowsMatch,
    type SessionMessagePinIdentity,
    type SessionMessagePinRole,
} from './sessionMessagePinIdentity';

export type PersistedSessionMessagePinV1 = Readonly<{
    version: 1;
    sessionId: string;
    seq: number;
    transcriptBlockIndex: number | null;
    routeMessageId: string | null;
    role: SessionMessagePinRole;
    pinnedAtMs: number;
    label: string | null;
}>;

export type SessionMessagePinRouteHydrationFact = Readonly<{
    seq: number | null | undefined;
    transcriptBlockIndex: number | null | undefined;
    routeMessageId: string | null | undefined;
    previousRouteMessageIds?: readonly string[];
    role: SessionMessagePinRole | string | null | undefined;
}>;

function readFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function routeRank(routeMessageId: string | null): number {
    const parsed = parseStableSessionMessageRouteId(routeMessageId);
    if (parsed?.kind === 'server') return 3;
    if (parsed?.kind === 'tool') return 2;
    if (parsed?.kind === 'local') return 1;
    return 0;
}

function comparePinsForOrder(a: PersistedSessionMessagePinV1, b: PersistedSessionMessagePinV1): number {
    if (a.seq !== b.seq) return a.seq - b.seq;
    const aBlock = a.transcriptBlockIndex ?? Number.MAX_SAFE_INTEGER;
    const bBlock = b.transcriptBlockIndex ?? Number.MAX_SAFE_INTEGER;
    if (aBlock !== bBlock) return aBlock - bBlock;
    if (a.pinnedAtMs !== b.pinnedAtMs) return a.pinnedAtMs - b.pinnedAtMs;
    const aIdentity = buildSessionMessagePinIdentity(a);
    const bIdentity = buildSessionMessagePinIdentity(b);
    return (aIdentity ? sessionMessagePinIdentityKey(aIdentity) : '').localeCompare(
        bIdentity ? sessionMessagePinIdentityKey(bIdentity) : '',
    );
}

function pinsAreSameTarget(a: PersistedSessionMessagePinV1, b: PersistedSessionMessagePinV1): boolean {
    return sessionMessagePinRowsMatch(a, b);
}

function pinMatchesIdentity(pin: PersistedSessionMessagePinV1, identity: SessionMessagePinIdentity): boolean {
    const pinIdentity = buildSessionMessagePinIdentity(pin);
    if (pinIdentity && sessionMessagePinIdentityKey(pinIdentity) === sessionMessagePinIdentityKey(identity)) {
        return true;
    }
    if (identity.kind !== 'fallback') return false;
    const fallback = buildSessionMessagePinFallbackIdentity(pin);
    return Boolean(fallback && sessionMessagePinFallbackIdentityKey(fallback) === sessionMessagePinFallbackIdentityKey(identity));
}

function mergePinMetadata(
    existing: PersistedSessionMessagePinV1,
    incoming: PersistedSessionMessagePinV1,
): PersistedSessionMessagePinV1 {
    const existingRouteRank = routeRank(existing.routeMessageId);
    const incomingRouteRank = routeRank(incoming.routeMessageId);
    const nextRouteMessageId = incomingRouteRank > existingRouteRank
        ? incoming.routeMessageId
        : existing.routeMessageId;
    const nextTranscriptBlockIndex = existing.transcriptBlockIndex ?? incoming.transcriptBlockIndex;
    const nextRole = existing.role === 'unknown' && incoming.role !== 'unknown' ? incoming.role : existing.role;

    if (
        nextRouteMessageId === existing.routeMessageId
        && nextTranscriptBlockIndex === existing.transcriptBlockIndex
        && nextRole === existing.role
    ) {
        return existing;
    }

    return {
        ...existing,
        routeMessageId: nextRouteMessageId,
        transcriptBlockIndex: nextTranscriptBlockIndex,
        role: nextRole,
    };
}

function persistedPinsEqual(a: PersistedSessionMessagePinV1, b: PersistedSessionMessagePinV1): boolean {
    return a.version === b.version
        && a.sessionId === b.sessionId
        && a.seq === b.seq
        && a.transcriptBlockIndex === b.transcriptBlockIndex
        && a.routeMessageId === b.routeMessageId
        && a.role === b.role
        && a.pinnedAtMs === b.pinnedAtMs
        && a.label === b.label;
}

type SessionMessagePinHydrationMatchKind = 'identity' | 'previous-route';

function getHydrationFactPinMatchKind(
    pin: PersistedSessionMessagePinV1,
    fact: SessionMessagePinRouteHydrationFact,
): SessionMessagePinHydrationMatchKind | null {
    if (sessionMessagePinRowsMatch(pin, {
        sessionId: pin.sessionId,
        seq: fact.seq,
        transcriptBlockIndex: fact.transcriptBlockIndex,
        routeMessageId: fact.routeMessageId,
        role: fact.role,
    })) {
        return 'identity';
    }

    const pinRouteMessageId = normalizeSessionMessagePinRouteMessageId(pin.routeMessageId);
    if (!pinRouteMessageId || !fact.previousRouteMessageIds?.length) return null;
    const matchesPreviousRoute = fact.previousRouteMessageIds
        .some((routeMessageId) => normalizeSessionMessagePinRouteMessageId(routeMessageId) === pinRouteMessageId);
    if (!matchesPreviousRoute) return null;

    const factBlockIndex = normalizeSessionMessagePinTranscriptBlockIndex(fact.transcriptBlockIndex);
    const factRole = normalizeSessionMessagePinRole(fact.role);
    return pin.transcriptBlockIndex === factBlockIndex && pin.role === factRole ? 'previous-route' : null;
}

export function sanitizeSessionMessagePin(input: unknown): PersistedSessionMessagePinV1 | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    if (record.version !== 1) return null;
    const sessionId = normalizeSessionMessagePinSessionId(typeof record.sessionId === 'string' ? record.sessionId : null);
    const seq = normalizeSessionMessagePinSeq(typeof record.seq === 'number' ? record.seq : null);
    const pinnedAtMs = readFiniteNonNegativeNumber(record.pinnedAtMs);
    if (!sessionId || seq === null || pinnedAtMs === null) return null;
    return {
        version: 1,
        sessionId,
        seq,
        transcriptBlockIndex: normalizeSessionMessagePinTranscriptBlockIndex(
            typeof record.transcriptBlockIndex === 'number' ? record.transcriptBlockIndex : null,
        ),
        routeMessageId: normalizeSessionMessagePinRouteMessageId(
            typeof record.routeMessageId === 'string' ? record.routeMessageId : null,
        ),
        role: normalizeSessionMessagePinRole(typeof record.role === 'string' ? record.role : null),
        pinnedAtMs,
        label: normalizeSessionMessagePinLabel(record.label),
    };
}

export function addSessionMessagePin(
    pins: readonly PersistedSessionMessagePinV1[],
    pin: PersistedSessionMessagePinV1,
): readonly PersistedSessionMessagePinV1[] {
    const sanitizedPin = sanitizeSessionMessagePin(pin);
    if (!sanitizedPin) return pins;
    const incomingIdentity = buildSessionMessagePinIdentity(sanitizedPin);
    if (!incomingIdentity) return pins;

    const existingIndex = pins.findIndex((existingPin) => pinsAreSameTarget(existingPin, sanitizedPin));

    if (existingIndex >= 0) {
        const sanitizedExisting = sanitizeSessionMessagePin(pins[existingIndex]);
        if (!sanitizedExisting) {
            const next = pins.slice();
            next.splice(existingIndex, 1, sanitizedPin);
            return next.sort(comparePinsForOrder);
        }
        const merged = mergePinMetadata(sanitizedExisting, sanitizedPin);
        if (merged === sanitizedExisting) return pins;
        const next = pins.slice();
        next[existingIndex] = merged;
        return next.sort(comparePinsForOrder);
    }

    return [...pins, sanitizedPin].sort(comparePinsForOrder);
}

export function removeSessionMessagePin(
    pins: readonly PersistedSessionMessagePinV1[],
    identity: SessionMessagePinIdentity,
): readonly PersistedSessionMessagePinV1[] {
    const next = pins.filter((pin) => !pinMatchesIdentity(pin, identity));
    return next.length === pins.length ? pins : next;
}

export function toggleSessionMessagePin(
    pins: readonly PersistedSessionMessagePinV1[],
    pin: PersistedSessionMessagePinV1,
): readonly PersistedSessionMessagePinV1[] {
    const sanitizedPin = sanitizeSessionMessagePin(pin);
    if (!sanitizedPin) return pins;
    const identity = buildSessionMessagePinIdentity(sanitizedPin);
    if (!identity) return pins;
    const hasExistingTarget = pins.some((existing) => pinsAreSameTarget(existing, sanitizedPin));
    return hasExistingTarget
        ? pins.filter((existing) => !pinsAreSameTarget(existing, sanitizedPin))
        : addSessionMessagePin(pins, sanitizedPin);
}

export function reconcileSessionMessagePinRouteId(
    pin: PersistedSessionMessagePinV1,
    hydratedRouteMessageId: string | null | undefined,
): PersistedSessionMessagePinV1 {
    const routeMessageId = normalizeSessionMessagePinRouteMessageId(hydratedRouteMessageId);
    if (!routeMessageId || routeRank(routeMessageId) <= routeRank(pin.routeMessageId)) return pin;
    const sanitizedPin = sanitizeSessionMessagePin(pin);
    if (!sanitizedPin) return pin;
    return {
        ...sanitizedPin,
        routeMessageId,
    };
}

function reconcileSessionMessagePinRouteFact(
    pin: PersistedSessionMessagePinV1,
    fact: SessionMessagePinRouteHydrationFact,
    matchKind: SessionMessagePinHydrationMatchKind,
): PersistedSessionMessagePinV1 {
    const routeMessageId = normalizeSessionMessagePinRouteMessageId(fact.routeMessageId);
    if (!routeMessageId || routeRank(routeMessageId) <= routeRank(pin.routeMessageId)) return pin;
    const sanitizedPin = sanitizeSessionMessagePin(pin);
    if (!sanitizedPin) return pin;
    const correctedSeq = matchKind === 'previous-route' ? normalizeSessionMessagePinSeq(fact.seq) : null;
    return {
        ...sanitizedPin,
        seq: correctedSeq ?? sanitizedPin.seq,
        routeMessageId,
    };
}

export function reconcileSessionMessagePinRouteIds(
    pins: readonly PersistedSessionMessagePinV1[],
    hydrationFacts: readonly SessionMessagePinRouteHydrationFact[],
): readonly PersistedSessionMessagePinV1[] {
    if (pins.length === 0 || hydrationFacts.length === 0) return pins;

    let changed = false;
    let nextPins = [] as readonly PersistedSessionMessagePinV1[];

    for (const rawPin of pins) {
        const sanitizedPin = sanitizeSessionMessagePin(rawPin);
        if (!sanitizedPin) {
            changed = true;
            continue;
        }

        let nextPin = sanitizedPin;
        for (const fact of hydrationFacts) {
            const matchKind = getHydrationFactPinMatchKind(nextPin, fact);
            if (!matchKind) {
                continue;
            }
            nextPin = reconcileSessionMessagePinRouteFact(nextPin, fact, matchKind);
        }

        if (!persistedPinsEqual(rawPin, sanitizedPin) || !persistedPinsEqual(sanitizedPin, nextPin)) {
            changed = true;
        }
        const before = nextPins;
        nextPins = addSessionMessagePin(nextPins, nextPin);
        if (nextPins !== before && nextPins.length <= before.length) {
            changed = true;
        }
    }

    if (!changed && nextPins.length === pins.length) return pins;
    return nextPins;
}
