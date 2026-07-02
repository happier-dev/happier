import * as React from 'react';

import {
    createInitialSessionListSelectionState,
    reduceSessionListSelection,
    type CreateSessionListSelectionStateInput,
} from './sessionListSelectionReducer';
import type {
    SessionListSelectionActions,
    SessionListSelectionKey,
    SessionListSelectionSnapshot,
    SessionListSelectionState,
    SessionListSelectionStore,
} from './sessionListSelectionTypes';

const SESSION_LIST_SELECTION_CONTEXT_GLOBAL_KEY = '__HAPPIER_SESSION_LIST_SELECTION_CONTEXT__';

type SessionListSelectionContextGlobal = typeof globalThis & {
    [SESSION_LIST_SELECTION_CONTEXT_GLOBAL_KEY]?: React.Context<SessionListSelectionStore | null>;
};

function resolveSessionListSelectionContext(): React.Context<SessionListSelectionStore | null> {
    const globalWithContext = globalThis as SessionListSelectionContextGlobal;
    const existingContext = globalWithContext[SESSION_LIST_SELECTION_CONTEXT_GLOBAL_KEY];
    if (existingContext) return existingContext;
    const context = React.createContext<SessionListSelectionStore | null>(null);
    globalWithContext[SESSION_LIST_SELECTION_CONTEXT_GLOBAL_KEY] = context;
    return context;
}

const SessionListSelectionContext = resolveSessionListSelectionContext();

const INERT_SELECTION_SNAPSHOT: SessionListSelectionSnapshot = Object.freeze({
    isSelectionMode: false,
    selectedKeys: new Set<SessionListSelectionKey>(),
    anchorKey: null,
    focusedKey: null,
    visibleOrderedKeys: [],
    eligibleKeys: new Set<SessionListSelectionKey>(),
    scopeKey: '',
    version: 0,
    count: 0,
});

function subscribeInertSelection(): () => void {
    return () => undefined;
}

function getInertSelectionSnapshot(): SessionListSelectionSnapshot {
    return INERT_SELECTION_SNAPSHOT;
}

function getInertRowSnapshot(): string {
    return '0:0:0';
}

function noopSelectionAction(): void {
    // Optional hooks are intentionally inert outside a provider.
}

const INERT_SELECTION_ACTIONS: SessionListSelectionActions = Object.freeze({
    enter: noopSelectionAction,
    exit: noopSelectionAction,
    clear: noopSelectionAction,
    replaceWith: noopSelectionAction,
    toggle: noopSelectionAction,
    selectRange: noopSelectionAction,
    addRange: noopSelectionAction,
    selectAllVisible: noopSelectionAction,
    setSelectedKeys: noopSelectionAction,
    setFocusedKey: noopSelectionAction,
    isSelected: () => false,
});

function createSnapshot(state: SessionListSelectionState): SessionListSelectionSnapshot {
    return {
        isSelectionMode: state.isSelectionMode,
        selectedKeys: state.selectedKeys,
        anchorKey: state.anchorKey,
        focusedKey: state.focusedKey,
        visibleOrderedKeys: state.visibleOrderedKeys,
        eligibleKeys: state.eligibleKeys,
        scopeKey: state.scopeKey,
        version: state.version,
        count: state.selectedKeys.size,
    };
}

export function createSessionListSelectionStore(
    input: CreateSessionListSelectionStateInput,
): SessionListSelectionStore {
    const listeners = new Set<() => void>();
    let state = createInitialSessionListSelectionState(input);
    let snapshot = createSnapshot(state);

    const emitIfChanged = (nextState: SessionListSelectionState) => {
        if (nextState === state) return;
        state = nextState;
        snapshot = createSnapshot(state);
        for (const listener of listeners) listener();
    };

    const dispatch = (action: Parameters<typeof reduceSessionListSelection>[1]) => {
        emitIfChanged(reduceSessionListSelection(state, action));
    };

    const store: SessionListSelectionStore = {
        getSnapshot: () => snapshot,
        getRowSnapshot: (key: SessionListSelectionKey) => [
            state.isSelectionMode ? '1' : '0',
            state.selectedKeys.has(key) ? '1' : '0',
            state.focusedKey === key ? '1' : '0',
        ].join(':'),
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        updateScope: (params) => {
            dispatch({
                type: 'resetScope',
                scopeKey: params.scopeKey,
                visibleOrderedKeys: params.visibleOrderedKeys,
                eligibleKeys: params.eligibleKeys,
            });
        },
        enter: (preselectKey?: SessionListSelectionKey | null) => dispatch({ type: 'enter', key: preselectKey }),
        exit: () => dispatch({ type: 'exit' }),
        clear: () => dispatch({ type: 'clear' }),
        replaceWith: (key: SessionListSelectionKey) => dispatch({ type: 'replace', key }),
        toggle: (key: SessionListSelectionKey) => dispatch({ type: 'toggle', key }),
        selectRange: (targetKey: SessionListSelectionKey) => dispatch({ type: 'selectRange', targetKey }),
        addRange: (targetKey: SessionListSelectionKey) => dispatch({ type: 'selectRange', targetKey, add: true }),
        selectAllVisible: () => dispatch({ type: 'selectAllVisible' }),
        setSelectedKeys: (keys: readonly SessionListSelectionKey[]) => dispatch({ type: 'setSelectedKeys', keys }),
        setFocusedKey: (key: SessionListSelectionKey | null) => dispatch({ type: 'setFocusedKey', key }),
        isSelected: (key: SessionListSelectionKey) => state.selectedKeys.has(key),
    };

    return store;
}

export type UseSessionListSelectionControllerInput = CreateSessionListSelectionStateInput & Readonly<{
    enabled?: boolean;
}>;

export function useSessionListSelectionController(
    input: UseSessionListSelectionControllerInput,
): SessionListSelectionStore {
    const storeRef = React.useRef<SessionListSelectionStore | null>(null);
    if (!storeRef.current) {
        storeRef.current = createSessionListSelectionStore({
            scopeKey: input.scopeKey,
            visibleOrderedKeys: input.enabled === false ? [] : input.visibleOrderedKeys,
            eligibleKeys: input.enabled === false ? [] : input.eligibleKeys,
        });
    }

    React.useEffect(() => {
        storeRef.current?.updateScope({
            scopeKey: input.scopeKey,
            visibleOrderedKeys: input.enabled === false ? [] : input.visibleOrderedKeys,
            eligibleKeys: input.enabled === false ? [] : input.eligibleKeys,
        });
        if (input.enabled === false) {
            storeRef.current?.exit();
        }
    }, [input.enabled, input.eligibleKeys, input.scopeKey, input.visibleOrderedKeys]);

    return storeRef.current;
}

export type SessionListSelectionProviderProps = React.PropsWithChildren<UseSessionListSelectionControllerInput & Readonly<{
    store?: SessionListSelectionStore | null;
}>>;

export function SessionListSelectionProvider(props: SessionListSelectionProviderProps): React.ReactElement {
    const internalStore = useSessionListSelectionController(props);
    const store = props.store ?? internalStore;

    return (
        <SessionListSelectionContext.Provider value={store}>
            {props.children}
        </SessionListSelectionContext.Provider>
    );
}

export function SessionListSelectionStoreProvider(props: React.PropsWithChildren<Readonly<{
    store: SessionListSelectionStore;
}>>): React.ReactElement {
    return (
        <SessionListSelectionContext.Provider value={props.store}>
            {props.children}
        </SessionListSelectionContext.Provider>
    );
}

export function SessionListSelectionBoundary(props: SessionListSelectionProviderProps): React.ReactElement {
    const parentStore = React.useContext(SessionListSelectionContext);
    if (parentStore) return <>{props.children}</>;
    return <SessionListSelectionProvider {...props} />;
}

function useSessionListSelectionStore(): SessionListSelectionStore {
    const store = React.useContext(SessionListSelectionContext);
    if (!store) throw new Error('Session list selection hooks must be used inside SessionListSelectionProvider');
    return store;
}

export function useSessionListSelectionState(): SessionListSelectionSnapshot {
    const store = useSessionListSelectionStore();
    return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useOptionalSessionListSelectionState(): SessionListSelectionSnapshot {
    const store = React.useContext(SessionListSelectionContext);
    return React.useSyncExternalStore(
        store?.subscribe ?? subscribeInertSelection,
        store?.getSnapshot ?? getInertSelectionSnapshot,
        store?.getSnapshot ?? getInertSelectionSnapshot,
    );
}

export function useSessionListSelectionActions(): SessionListSelectionActions {
    return useSessionListSelectionStore();
}

export function useOptionalSessionListSelectionActions(): SessionListSelectionActions | null {
    return React.useContext(SessionListSelectionContext);
}

export function useInertSessionListSelectionActions(): SessionListSelectionActions {
    return INERT_SELECTION_ACTIONS;
}

function useSessionListSelectionRowFromStore(
    key: SessionListSelectionKey,
    store: SessionListSelectionStore | null,
): Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    isFocused: boolean;
    replace: () => void;
    toggle: () => void;
    selectRange: () => void;
    addRange: () => void;
    setFocused: () => void;
}> {
    const rowSnapshot = React.useSyncExternalStore(
        store?.subscribe ?? subscribeInertSelection,
        () => store?.getRowSnapshot(key) ?? getInertRowSnapshot(),
        () => store?.getRowSnapshot(key) ?? getInertRowSnapshot(),
    );
    const [modeFlag, selectedFlag, focusedFlag] = rowSnapshot.split(':');
    return React.useMemo(() => ({
        isSelectionMode: modeFlag === '1',
        isSelected: selectedFlag === '1',
        isFocused: focusedFlag === '1',
        replace: store ? () => store.replaceWith(key) : noopSelectionAction,
        toggle: store ? () => store.toggle(key) : noopSelectionAction,
        selectRange: store ? () => store.selectRange(key) : noopSelectionAction,
        addRange: store ? () => store.addRange(key) : noopSelectionAction,
        setFocused: store ? () => store.setFocusedKey(key) : noopSelectionAction,
    }), [focusedFlag, key, modeFlag, selectedFlag, store]);
}

export function useSessionListSelectionRow(key: SessionListSelectionKey): ReturnType<typeof useSessionListSelectionRowFromStore> {
    return useSessionListSelectionRowFromStore(key, useSessionListSelectionStore());
}

export function useOptionalSessionListSelectionRow(key: SessionListSelectionKey): ReturnType<typeof useSessionListSelectionRowFromStore> {
    return useSessionListSelectionRowFromStore(key, React.useContext(SessionListSelectionContext));
}
