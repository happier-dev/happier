import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { moveSessionMruEntryToFront } from './sessionNavigationOrder';

const EMPTY_ORDER: readonly string[] = [];
const orderKey = 'order';
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
export const sessionMruState = createPersistentUiState<readonly string[]>('session-navigation-mru-v1', parseOrder);

export function readSessionMruOrder(): readonly string[] {
    const order = sessionMruState.read(orderKey);
    return Array.isArray(order) ? order : EMPTY_ORDER;
}

export function useSessionMruOrder(): readonly string[] {
    const order = usePersistentUiStateValue(sessionMruState, orderKey);
    return Array.isArray(order) ? order : EMPTY_ORDER;
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
