import { resolveSessionListSelectionRange } from './sessionListSelectionRange';
import type { SessionListSelectionKey, SessionListSelectionState } from './sessionListSelectionTypes';

export type CreateSessionListSelectionStateInput = Readonly<{
    scopeKey: string;
    visibleOrderedKeys: readonly SessionListSelectionKey[];
    eligibleKeys?: readonly SessionListSelectionKey[] | ReadonlySet<SessionListSelectionKey> | null;
}>;

export type SessionListSelectionReducerAction =
    | Readonly<{ type: 'enter'; key?: SessionListSelectionKey | null }>
    | Readonly<{ type: 'exit' }>
    | Readonly<{ type: 'clear' }>
    | Readonly<{ type: 'replace'; key: SessionListSelectionKey }>
    | Readonly<{ type: 'toggle'; key: SessionListSelectionKey }>
    | Readonly<{ type: 'selectRange'; targetKey: SessionListSelectionKey; add?: boolean }>
    | Readonly<{ type: 'selectAllVisible' }>
    | Readonly<{ type: 'setSelectedKeys'; keys: readonly SessionListSelectionKey[] }>
    | Readonly<{ type: 'setFocusedKey'; key: SessionListSelectionKey | null }>
    | Readonly<{
        type: 'setVisibleOrder';
        visibleOrderedKeys: readonly SessionListSelectionKey[];
        eligibleKeys?: readonly SessionListSelectionKey[] | ReadonlySet<SessionListSelectionKey> | null;
    }>
    | Readonly<{
        type: 'resetScope';
        scopeKey: string;
        visibleOrderedKeys: readonly SessionListSelectionKey[];
        eligibleKeys?: readonly SessionListSelectionKey[] | ReadonlySet<SessionListSelectionKey> | null;
    }>;

function normalizeKeys(keys: readonly SessionListSelectionKey[] | ReadonlySet<SessionListSelectionKey> | null | undefined): SessionListSelectionKey[] {
    return Array.from(keys ?? [])
        .map((key) => key.trim())
        .filter(Boolean);
}

function createEligibleKeys(
    visibleOrderedKeys: readonly SessionListSelectionKey[],
    eligibleKeys: readonly SessionListSelectionKey[] | ReadonlySet<SessionListSelectionKey> | null | undefined,
): ReadonlySet<SessionListSelectionKey> {
    if (!eligibleKeys) return new Set(normalizeKeys(visibleOrderedKeys));
    return new Set(normalizeKeys(eligibleKeys));
}

function setsEqual(left: ReadonlySet<SessionListSelectionKey>, right: ReadonlySet<SessionListSelectionKey>): boolean {
    if (left === right) return true;
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

function arraysEqual(left: readonly SessionListSelectionKey[], right: readonly SessionListSelectionKey[]): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function isEligible(state: SessionListSelectionState, key: SessionListSelectionKey | null): key is SessionListSelectionKey {
    return typeof key === 'string' && state.eligibleKeys.has(key);
}

function firstSelectedVisibleKey(
    selectedKeys: ReadonlySet<SessionListSelectionKey>,
    visibleOrderedKeys: readonly SessionListSelectionKey[],
): SessionListSelectionKey | null {
    for (const key of visibleOrderedKeys) {
        if (selectedKeys.has(key)) return key;
    }
    return null;
}

function pruneState(
    state: SessionListSelectionState,
    visibleOrderedKeys: readonly SessionListSelectionKey[],
    eligibleKeys: ReadonlySet<SessionListSelectionKey>,
): Pick<SessionListSelectionState, 'selectedKeys' | 'anchorKey' | 'focusedKey'> {
    const visible = new Set(visibleOrderedKeys);
    const selectedKeys = new Set<SessionListSelectionKey>();
    for (const key of state.selectedKeys) {
        if (eligibleKeys.has(key)) selectedKeys.add(key);
    }
    const anchorKey = state.anchorKey && selectedKeys.has(state.anchorKey) && eligibleKeys.has(state.anchorKey)
        ? state.anchorKey
        : firstSelectedVisibleKey(selectedKeys, visibleOrderedKeys);
    const focusedKey = state.focusedKey && visible.has(state.focusedKey) && eligibleKeys.has(state.focusedKey)
        ? state.focusedKey
        : firstSelectedVisibleKey(selectedKeys, visibleOrderedKeys);
    return { selectedKeys, anchorKey, focusedKey };
}

function commit(
    state: SessionListSelectionState,
    next: Omit<SessionListSelectionState, 'version'>,
): SessionListSelectionState {
    const same = state.isSelectionMode === next.isSelectionMode
        && state.scopeKey === next.scopeKey
        && state.anchorKey === next.anchorKey
        && state.focusedKey === next.focusedKey
        && arraysEqual(state.visibleOrderedKeys, next.visibleOrderedKeys)
        && setsEqual(state.eligibleKeys, next.eligibleKeys)
        && setsEqual(state.selectedKeys, next.selectedKeys);
    if (same) return state;
    return {
        ...next,
        version: state.version + 1,
    };
}

export function createInitialSessionListSelectionState(
    input: CreateSessionListSelectionStateInput,
): SessionListSelectionState {
    const visibleOrderedKeys = normalizeKeys(input.visibleOrderedKeys);
    return {
        isSelectionMode: false,
        selectedKeys: new Set(),
        anchorKey: null,
        focusedKey: null,
        visibleOrderedKeys,
        eligibleKeys: createEligibleKeys(visibleOrderedKeys, input.eligibleKeys),
        scopeKey: input.scopeKey,
        version: 0,
    };
}

export function reduceSessionListSelection(
    state: SessionListSelectionState,
    action: SessionListSelectionReducerAction,
): SessionListSelectionState {
    switch (action.type) {
        case 'enter': {
            const key = action.key ?? null;
            const selectedKeys = isEligible(state, key)
                ? new Set<SessionListSelectionKey>([key])
                : new Set<SessionListSelectionKey>();
            const anchorKey = selectedKeys.size > 0 ? key : null;
            return commit(state, {
                ...state,
                isSelectionMode: true,
                selectedKeys,
                anchorKey,
                focusedKey: anchorKey,
            });
        }
        case 'exit':
        case 'clear':
            return commit(state, {
                ...state,
                isSelectionMode: false,
                selectedKeys: new Set(),
                anchorKey: null,
                focusedKey: null,
            });
        case 'replace': {
            if (!isEligible(state, action.key)) return state;
            return commit(state, {
                ...state,
                isSelectionMode: true,
                selectedKeys: new Set([action.key]),
                anchorKey: action.key,
                focusedKey: action.key,
            });
        }
        case 'toggle': {
            if (!isEligible(state, action.key)) return state;
            const selectedKeys = new Set(state.selectedKeys);
            if (selectedKeys.has(action.key)) selectedKeys.delete(action.key);
            else selectedKeys.add(action.key);
            const nextAnchorKey = selectedKeys.size > 0 ? action.key : null;
            return commit(state, {
                ...state,
                isSelectionMode: selectedKeys.size > 0,
                selectedKeys,
                anchorKey: nextAnchorKey,
                focusedKey: nextAnchorKey,
            });
        }
        case 'selectRange': {
            const anchorKey = state.anchorKey
                && state.eligibleKeys.has(state.anchorKey)
                && state.visibleOrderedKeys.includes(state.anchorKey)
                ? state.anchorKey
                : null;
            const range = resolveSessionListSelectionRange({
                visibleOrderedKeys: state.visibleOrderedKeys,
                anchorKey,
                targetKey: action.targetKey,
                eligibleKeys: state.eligibleKeys,
            });
            if (range.length === 0) return state;
            const selectedKeys = action.add === true ? new Set(state.selectedKeys) : new Set<SessionListSelectionKey>();
            for (const key of range) selectedKeys.add(key);
            return commit(state, {
                ...state,
                isSelectionMode: true,
                selectedKeys,
                anchorKey: anchorKey ?? action.targetKey,
                focusedKey: action.targetKey,
            });
        }
        case 'selectAllVisible': {
            const selectedKeys = new Set<SessionListSelectionKey>();
            for (const key of state.visibleOrderedKeys) {
                if (state.eligibleKeys.has(key)) selectedKeys.add(key);
            }
            const firstKey = firstSelectedVisibleKey(selectedKeys, state.visibleOrderedKeys);
            return commit(state, {
                ...state,
                isSelectionMode: selectedKeys.size > 0,
                selectedKeys,
                anchorKey: firstKey,
                focusedKey: firstKey,
            });
        }
        case 'setSelectedKeys': {
            const requested = new Set(normalizeKeys(action.keys));
            const selectedKeys = new Set<SessionListSelectionKey>();
            for (const key of requested) {
                if (state.eligibleKeys.has(key)) selectedKeys.add(key);
            }
            const firstKey = firstSelectedVisibleKey(selectedKeys, state.visibleOrderedKeys);
            return commit(state, {
                ...state,
                isSelectionMode: selectedKeys.size > 0,
                selectedKeys,
                anchorKey: firstKey,
                focusedKey: firstKey,
            });
        }
        case 'setFocusedKey': {
            const focusedKey = isEligible(state, action.key) ? action.key : null;
            return commit(state, {
                ...state,
                focusedKey,
            });
        }
        case 'setVisibleOrder': {
            const visibleOrderedKeys = normalizeKeys(action.visibleOrderedKeys);
            const eligibleKeys = createEligibleKeys(visibleOrderedKeys, action.eligibleKeys);
            const pruned = pruneState(state, visibleOrderedKeys, eligibleKeys);
            return commit(state, {
                ...state,
                isSelectionMode: pruned.selectedKeys.size > 0,
                visibleOrderedKeys,
                eligibleKeys,
                ...pruned,
            });
        }
        case 'resetScope': {
            if (action.scopeKey === state.scopeKey) {
                return reduceSessionListSelection(state, {
                    type: 'setVisibleOrder',
                    visibleOrderedKeys: action.visibleOrderedKeys,
                    eligibleKeys: action.eligibleKeys,
                });
            }
            const visibleOrderedKeys = normalizeKeys(action.visibleOrderedKeys);
            const eligibleKeys = createEligibleKeys(visibleOrderedKeys, action.eligibleKeys);
            return commit(state, {
                isSelectionMode: false,
                selectedKeys: new Set(),
                anchorKey: null,
                focusedKey: null,
                visibleOrderedKeys,
                eligibleKeys,
                scopeKey: action.scopeKey,
            });
        }
        default:
            return state;
    }
}
