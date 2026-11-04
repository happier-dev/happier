import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { moveSessionMruEntryToFront } from './sessionNavigationOrder';

const EMPTY_ORDER: readonly string[] = [];
const orderKey = 'order';
const capturePickKey = 'last-capture-pick';
const focusedSessionKey = 'last-focused-session';

export type SessionRecentTarget = Readonly<{ sessionKey: string; timestamp: number }>;
type SessionRecentValue = readonly string[] | SessionRecentTarget;

function parseRecentValue(value: unknown): SessionRecentValue {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record.sessionKey === 'string' && record.sessionKey.trim()
            && typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
            return { sessionKey: record.sessionKey.trim(), timestamp: record.timestamp };
        }
    }
    return parseOrder(value);
}

function parseOrder(value: unknown): string[] {
    return Array.isArray(value) ? value
        .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
        .map(key => key.trim()) : [];
}

function admitOrder(value: unknown): string[] {
    if (!Array.isArray(value)) throw new TypeError('Expected stored Session navigation order');
    return parseOrder(value);
}

/** Navigation history belongs to this device, independently of preference publications. */
export const sessionMruState = createPersistentUiState<SessionRecentValue>('session-navigation-mru-v1', parseRecentValue);

export function readSessionMruOrder(): readonly string[] {
    const order = sessionMruState.read(orderKey);
    return Array.isArray(order) ? order : EMPTY_ORDER;
}

export function useSessionMruOrder(): readonly string[] {
    const order = usePersistentUiStateValue(sessionMruState, orderKey);
    return Array.isArray(order) ? order : EMPTY_ORDER;
}

function readRecentTarget(key: string): SessionRecentTarget | null {
    const value = sessionMruState.read(key);
    return value && 'sessionKey' in value ? value : null;
}

export function readLastCaptureSessionPick(): SessionRecentTarget | null {
    return readRecentTarget(capturePickKey);
}

export function readLastFocusedSessionVisit(): SessionRecentTarget | null {
    return readRecentTarget(focusedSessionKey);
}

function rememberRecentTarget(key: string, sessionKey: string): void {
    // Preserve event order even when two user intents share a millisecond.
    const timestamp = Math.max(Date.now(), (readLastCaptureSessionPick()?.timestamp ?? 0) + 1,
        (readLastFocusedSessionVisit()?.timestamp ?? 0) + 1);
    try { sessionMruState.set(key, { sessionKey, timestamp }); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[session-navigation] Recent target could not be persisted.');
    }
}

export function rememberCaptureSessionPick(sessionKey: string): void {
    rememberRecentTarget(capturePickKey, sessionKey);
}

export function rememberFocusedSessionVisit(sessionKey: string): void {
    if (readLastFocusedSessionVisit()?.sessionKey === sessionKey) return;
    rememberRecentTarget(focusedSessionKey, sessionKey);
}

export function rememberSessionVisit(sessionKey: string): void {
    const order = readSessionMruOrder();
    const next = moveSessionMruEntryToFront({ order, activeSessionKey: sessionKey });
    if (order.length === next.length && order.every((key, index) => key === next[index])) return;
    try { sessionMruState.set(orderKey, next); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[session-navigation] Recent visit could not be persisted.');
    }
}

/** The supported predecessor string-list carrier is an import seed, never an active writer. */
export function migrateSessionMruFromSettings(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'sessionMruOrderV1')) return input;
    const source = input as Record<string, unknown>;
    if (!Array.isArray(source.sessionMruOrderV1)) return input;
    if (sessionMruState.readStrict(orderKey, admitOrder) === undefined) sessionMruState.set(orderKey, parseOrder(source.sessionMruOrderV1));
    const { sessionMruOrderV1: _legacyOrder, ...retained } = source;
    return retained;
}
