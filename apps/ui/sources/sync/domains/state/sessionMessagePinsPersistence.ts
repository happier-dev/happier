import { getPersistenceStorage } from './persistenceStorage';
import { scopedSessionLocalStateKey } from './sessionLocalStateKeys';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    addSessionMessagePin,
    reconcileSessionMessagePinRouteIds,
    sanitizeSessionMessagePin,
    type PersistedSessionMessagePinV1,
    type SessionMessagePinRouteHydrationFact,
} from '@/sync/domains/messages/pins/sessionMessagePins';

export const SESSION_MESSAGE_PINS_STORAGE_BASE_KEY = 'session-message-pins-v1';

export type PersistedSessionMessagePinsBySessionId = Record<string, readonly PersistedSessionMessagePinV1[]>;

type PersistedSessionMessagePinsPayloadV1 = Readonly<{
    version: 1;
    sessions: PersistedSessionMessagePinsBySessionId;
}>;

type SessionMessagePinsChangeListener = () => void;

const sessionMessagePinsChangeListeners = new Set<SessionMessagePinsChangeListener>();
let sessionMessagePinsRevision = 0;

function emitSessionMessagePinsChange(): void {
    sessionMessagePinsRevision += 1;
    for (const listener of sessionMessagePinsChangeListeners) {
        listener();
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePinsForSession(
    sessionId: string,
    pins: unknown,
): readonly PersistedSessionMessagePinV1[] {
    if (!Array.isArray(pins)) return [];
    let sanitizedPins = [] as readonly PersistedSessionMessagePinV1[];
    for (const rawPin of pins) {
        const pin = sanitizeSessionMessagePin(rawPin);
        if (!pin || pin.sessionId !== sessionId) continue;
        sanitizedPins = addSessionMessagePin(sanitizedPins, pin);
    }
    return sanitizedPins;
}

function sanitizeSessions(input: unknown): PersistedSessionMessagePinsBySessionId {
    if (!isRecord(input)) return {};
    const output: PersistedSessionMessagePinsBySessionId = {};
    for (const [sessionId, rawPins] of Object.entries(input)) {
        const trimmedSessionId = sessionId.trim();
        if (!trimmedSessionId) continue;
        const pins = sanitizePinsForSession(trimmedSessionId, rawPins);
        if (pins.length > 0) {
            output[trimmedSessionId] = pins;
        }
    }
    return output;
}

function readPayload(input: unknown): PersistedSessionMessagePinsBySessionId {
    if (!isRecord(input) || input.version !== 1) return {};
    return sanitizeSessions(input.sessions);
}

function buildPayload(sessions: PersistedSessionMessagePinsBySessionId): PersistedSessionMessagePinsPayloadV1 {
    return {
        version: 1,
        sessions,
    };
}

function pruneEmptySessions(
    sessions: PersistedSessionMessagePinsBySessionId,
): PersistedSessionMessagePinsBySessionId {
    const output: PersistedSessionMessagePinsBySessionId = {};
    for (const [sessionId, pins] of Object.entries(sessions)) {
        if (pins.length > 0) {
            output[sessionId] = pins;
        }
    }
    return output;
}

function saveAll(
    sessions: PersistedSessionMessagePinsBySessionId,
    scope?: ServerAccountScope | null,
): void {
    const pruned = pruneEmptySessions(sessions);
    const key = sessionMessagePinsStorageKey(scope);
    const storage = getPersistenceStorage();
    if (Object.keys(pruned).length === 0) {
        if (storage.getString(key) === undefined) return;
        storage.delete(key);
        emitSessionMessagePinsChange();
        return;
    }
    const nextRaw = JSON.stringify(buildPayload(pruned));
    if (storage.getString(key) === nextRaw) return;
    storage.set(key, nextRaw);
    emitSessionMessagePinsChange();
}

export function sessionMessagePinsStorageKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey(SESSION_MESSAGE_PINS_STORAGE_BASE_KEY, scope);
}

export function readSessionMessagePinsRevision(): number {
    return sessionMessagePinsRevision;
}

export function subscribeSessionMessagePinsChanges(listener: SessionMessagePinsChangeListener): () => void {
    sessionMessagePinsChangeListeners.add(listener);
    return () => {
        sessionMessagePinsChangeListeners.delete(listener);
    };
}

export function loadPersistedSessionMessagePins(
    scope?: ServerAccountScope | null,
): PersistedSessionMessagePinsBySessionId {
    const raw = getPersistenceStorage().getString(sessionMessagePinsStorageKey(scope));
    if (!raw) return {};
    try {
        return readPayload(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function readPersistedSessionMessagePins(
    sessionId: string,
    scope?: ServerAccountScope | null,
): readonly PersistedSessionMessagePinV1[] {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return [];
    return loadPersistedSessionMessagePins(scope)[trimmedSessionId] ?? [];
}

export function savePersistedSessionMessagePins(
    sessionId: string,
    pins: readonly PersistedSessionMessagePinV1[],
    scope?: ServerAccountScope | null,
): void {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const sessions = loadPersistedSessionMessagePins(scope);
    const sanitizedPins = sanitizePinsForSession(trimmedSessionId, pins);
    saveAll({
        ...sessions,
        [trimmedSessionId]: sanitizedPins,
    }, scope);
}

export function reconcilePersistedSessionMessagePinRouteIds(
    sessionId: string,
    hydrationFacts: readonly SessionMessagePinRouteHydrationFact[],
    scope?: ServerAccountScope | null,
): boolean {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId || hydrationFacts.length === 0) return false;
    const sessions = loadPersistedSessionMessagePins(scope);
    const pins = sessions[trimmedSessionId] ?? [];
    if (pins.length === 0) return false;

    const nextPins = reconcileSessionMessagePinRouteIds(pins, hydrationFacts);
    if (nextPins === pins) return false;

    saveAll({
        ...sessions,
        [trimmedSessionId]: sanitizePinsForSession(trimmedSessionId, nextPins),
    }, scope);
    return true;
}

export function clearPersistedSessionMessagePins(
    sessionId: string,
    scope?: ServerAccountScope | null,
): void {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const sessions = loadPersistedSessionMessagePins(scope);
    if (!(trimmedSessionId in sessions)) return;
    const next = { ...sessions };
    delete next[trimmedSessionId];
    saveAll(next, scope);
}

export function clearPersistedSessionMessagePinsStorage(scope?: ServerAccountScope | null): void {
    const key = sessionMessagePinsStorageKey(scope);
    const storage = getPersistenceStorage();
    if (storage.getString(key) === undefined) return;
    storage.delete(key);
    emitSessionMessagePinsChange();
}
