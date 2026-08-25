import * as React from 'react';

import {
    HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT,
    HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT,
    createHappierListMultiSelectionStore,
    parseHappierListMultiSelectionRowSnapshot,
} from '@happier-dev/plugin-ui/presentation';

import type { CreateSessionListSelectionStateInput } from './sessionListSelectionReducer';
import type {
    SessionListSelectionActions,
    SessionListSelectionKey,
    SessionListSelectionSnapshot,
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

const INERT_SELECTION_SNAPSHOT: SessionListSelectionSnapshot = HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT;

function subscribeInertSelection(): () => void {
    return () => undefined;
}

function getInertSelectionSnapshot(): SessionListSelectionSnapshot {
    return INERT_SELECTION_SNAPSHOT;
}

function getInertRowSnapshot(): string {
    return HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT;
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

/**
 * The sessions list's selection store IS the shared collection owner's store.
 *
 * `apps/ui` renders its own virtualized list rather than the shared `List`, so
 * it supplies the visible rows itself through `updateScope` — the non-collection
 * arm of the same contract a plugin list reaches through
 * `useListMultiSelectionController({ rows: 'collection' })`. Only the binding
 * differs; the snapshot shape, the per-row primitive and every selection rule
 * are the owner's.
 */
export const createSessionListSelectionStore: (
    input: CreateSessionListSelectionStateInput,
) => SessionListSelectionStore = createHappierListMultiSelectionStore;

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
    const { isSelectionMode, isSelected, isFocused } = parseHappierListMultiSelectionRowSnapshot(rowSnapshot);
    return React.useMemo(() => ({
        isSelectionMode,
        isSelected,
        isFocused,
        replace: store ? () => store.replaceWith(key) : noopSelectionAction,
        toggle: store ? () => store.toggle(key) : noopSelectionAction,
        selectRange: store ? () => store.selectRange(key) : noopSelectionAction,
        addRange: store ? () => store.addRange(key) : noopSelectionAction,
        setFocused: store ? () => store.setFocusedKey(key) : noopSelectionAction,
    }), [isFocused, isSelected, isSelectionMode, key, store]);
}

export function useSessionListSelectionRow(key: SessionListSelectionKey): ReturnType<typeof useSessionListSelectionRowFromStore> {
    return useSessionListSelectionRowFromStore(key, useSessionListSelectionStore());
}

export function useOptionalSessionListSelectionRow(key: SessionListSelectionKey): ReturnType<typeof useSessionListSelectionRowFromStore> {
    return useSessionListSelectionRowFromStore(key, React.useContext(SessionListSelectionContext));
}
