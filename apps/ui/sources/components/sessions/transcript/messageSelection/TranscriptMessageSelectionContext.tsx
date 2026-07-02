import * as React from 'react';

export type TranscriptMessageSelectionSnapshot = Readonly<{
    isSelectionMode: boolean;
    selectedIds: ReadonlySet<string>;
    selectionVersion: number;
    count: number;
}>;

export type TranscriptMessageSelectionActions = Readonly<{
    enter: (preselectMessageId?: string | null) => void;
    exit: () => void;
    toggle: (messageId: string) => void;
    selectAll: (allEligibleIds: ReadonlyArray<string>) => void;
    deselectAll: () => void;
    isSelected: (messageId: string) => boolean;
}>;

type TranscriptMessageSelectionStore = TranscriptMessageSelectionActions & Readonly<{
    getSnapshot: () => TranscriptMessageSelectionSnapshot;
    getRowSnapshot: (messageId: string) => string;
    subscribe: (listener: () => void) => () => void;
    updateEligibleIds: (eligibleMessageIdsInOrder: ReadonlyArray<string>) => void;
    resetForSession: (sessionId: string, eligibleMessageIdsInOrder: ReadonlyArray<string>) => void;
}>;

type MutableSelectionState = {
    sessionId: string;
    eligibleIds: ReadonlySet<string>;
    isSelectionMode: boolean;
    selectedIds: ReadonlySet<string>;
    selectionVersion: number;
    snapshot: TranscriptMessageSelectionSnapshot;
};

const TRANSCRIPT_MESSAGE_SELECTION_CONTEXT_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_MESSAGE_SELECTION_CONTEXT__';

type TranscriptMessageSelectionContextGlobal = typeof globalThis & {
    [TRANSCRIPT_MESSAGE_SELECTION_CONTEXT_GLOBAL_KEY]?: React.Context<TranscriptMessageSelectionStore | null>;
};

function resolveTranscriptMessageSelectionContext(): React.Context<TranscriptMessageSelectionStore | null> {
    const globalWithContext = globalThis as TranscriptMessageSelectionContextGlobal;
    const existingContext = globalWithContext[TRANSCRIPT_MESSAGE_SELECTION_CONTEXT_GLOBAL_KEY];
    if (existingContext) return existingContext;
    const context = React.createContext<TranscriptMessageSelectionStore | null>(null);
    globalWithContext[TRANSCRIPT_MESSAGE_SELECTION_CONTEXT_GLOBAL_KEY] = context;
    return context;
}

const TranscriptMessageSelectionContext = resolveTranscriptMessageSelectionContext();

const INERT_SELECTION_SNAPSHOT: TranscriptMessageSelectionSnapshot = Object.freeze({
    isSelectionMode: false,
    selectedIds: new Set<string>(),
    selectionVersion: 0,
    count: 0,
});

function subscribeInertSelection(): () => void {
    return () => undefined;
}

function getInertSelectionSnapshot(): TranscriptMessageSelectionSnapshot {
    return INERT_SELECTION_SNAPSHOT;
}

function getInertRowSnapshot(): string {
    return '0:0';
}

function noopSelectionAction(): void {
    // Intentionally empty: optional selection hooks are inert outside a provider.
}

const INERT_SELECTION_ACTIONS: TranscriptMessageSelectionActions = Object.freeze({
    enter: noopSelectionAction,
    exit: noopSelectionAction,
    toggle: noopSelectionAction,
    selectAll: noopSelectionAction,
    deselectAll: noopSelectionAction,
    isSelected: () => false,
});

function normalizeIds(ids: ReadonlyArray<string>): string[] {
    return ids.map((id) => id.trim()).filter((id) => id.length > 0);
}

function createSnapshot(state: Pick<MutableSelectionState, 'isSelectionMode' | 'selectedIds' | 'selectionVersion'>): TranscriptMessageSelectionSnapshot {
    return {
        isSelectionMode: state.isSelectionMode,
        selectedIds: state.selectedIds,
        selectionVersion: state.selectionVersion,
        count: state.selectedIds.size,
    };
}

function createSelectionStore(sessionId: string, eligibleMessageIdsInOrder: ReadonlyArray<string>): TranscriptMessageSelectionStore {
    const listeners = new Set<() => void>();
    const state: MutableSelectionState = {
        sessionId,
        eligibleIds: new Set(normalizeIds(eligibleMessageIdsInOrder)),
        isSelectionMode: false,
        selectedIds: new Set(),
        selectionVersion: 0,
        snapshot: createSnapshot({ isSelectionMode: false, selectedIds: new Set(), selectionVersion: 0 }),
    };

    const emit = () => {
        state.snapshot = createSnapshot(state);
        for (const listener of listeners) listener();
    };

    const commit = (next: Pick<MutableSelectionState, 'isSelectionMode' | 'selectedIds'>) => {
        const nextIsSelectionMode = next.isSelectionMode === true && next.selectedIds.size > 0;
        const sameMode = nextIsSelectionMode === state.isSelectionMode;
        const sameSelection = next.selectedIds.size === state.selectedIds.size
            && Array.from(next.selectedIds).every((id) => state.selectedIds.has(id));
        if (sameMode && sameSelection) return;
        state.isSelectionMode = nextIsSelectionMode;
        state.selectedIds = next.selectedIds;
        state.selectionVersion += 1;
        emit();
    };

    const filterEligible = (ids: Iterable<string>) => {
        const selected = new Set<string>();
        for (const id of ids) {
            if (state.eligibleIds.has(id)) selected.add(id);
        }
        return selected;
    };

    const store: TranscriptMessageSelectionStore = {
        getSnapshot: () => state.snapshot,
        getRowSnapshot: (messageId: string) => `${state.isSelectionMode ? '1' : '0'}:${state.selectedIds.has(messageId) ? '1' : '0'}`,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        updateEligibleIds: (eligibleMessageIdsInOrder: ReadonlyArray<string>) => {
            state.eligibleIds = new Set(normalizeIds(eligibleMessageIdsInOrder));
            const pruned = filterEligible(state.selectedIds);
            commit({ isSelectionMode: state.isSelectionMode, selectedIds: pruned });
        },
        resetForSession: (nextSessionId: string, eligibleMessageIdsInOrder: ReadonlyArray<string>) => {
            if (nextSessionId === state.sessionId) {
                store.updateEligibleIds(eligibleMessageIdsInOrder);
                return;
            }
            state.sessionId = nextSessionId;
            state.eligibleIds = new Set(normalizeIds(eligibleMessageIdsInOrder));
            commit({ isSelectionMode: false, selectedIds: new Set() });
        },
        enter: (preselectMessageId?: string | null) => {
            const selectedIds = preselectMessageId && state.eligibleIds.has(preselectMessageId)
                ? new Set([preselectMessageId])
                : new Set<string>();
            commit({ isSelectionMode: true, selectedIds });
        },
        exit: () => {
            commit({ isSelectionMode: false, selectedIds: new Set() });
        },
        toggle: (messageId: string) => {
            if (!state.eligibleIds.has(messageId)) return;
            const selectedIds = new Set(state.selectedIds);
            if (selectedIds.has(messageId)) {
                selectedIds.delete(messageId);
            } else {
                selectedIds.add(messageId);
            }
            commit({ isSelectionMode: true, selectedIds });
        },
        selectAll: (allEligibleIds: ReadonlyArray<string>) => {
            commit({ isSelectionMode: true, selectedIds: filterEligible(allEligibleIds) });
        },
        deselectAll: () => {
            commit({ isSelectionMode: false, selectedIds: new Set() });
        },
        isSelected: (messageId: string) => state.selectedIds.has(messageId),
    };

    return store;
}

export type TranscriptMessageSelectionProviderProps = React.PropsWithChildren<{
    sessionId: string;
    eligibleMessageIdsInOrder: ReadonlyArray<string>;
    enabled?: boolean;
}>;

export function TranscriptMessageSelectionProvider(props: TranscriptMessageSelectionProviderProps): React.ReactElement {
    const storeRef = React.useRef<TranscriptMessageSelectionStore | null>(null);
    if (!storeRef.current) {
        storeRef.current = createSelectionStore(
            props.sessionId,
            props.enabled === false ? [] : props.eligibleMessageIdsInOrder,
        );
    }

    React.useEffect(() => {
        const eligibleIds = props.enabled === false ? [] : props.eligibleMessageIdsInOrder;
        storeRef.current?.resetForSession(props.sessionId, eligibleIds);
        if (props.enabled === false) {
            storeRef.current?.exit();
        }
    }, [props.enabled, props.sessionId, props.eligibleMessageIdsInOrder]);

    return (
        <TranscriptMessageSelectionContext.Provider value={storeRef.current}>
            {props.children}
        </TranscriptMessageSelectionContext.Provider>
    );
}

export function TranscriptMessageSelectionBoundary(props: TranscriptMessageSelectionProviderProps): React.ReactElement {
    const parentStore = React.useContext(TranscriptMessageSelectionContext);
    if (parentStore) {
        return <>{props.children}</>;
    }
    return <TranscriptMessageSelectionProvider {...props} />;
}

function useTranscriptSelectionStore(): TranscriptMessageSelectionStore {
    const store = React.useContext(TranscriptMessageSelectionContext);
    if (!store) throw new Error('Transcript message selection hooks must be used inside TranscriptMessageSelectionProvider');
    return store;
}

export function useTranscriptSelectionState(): TranscriptMessageSelectionSnapshot {
    const store = useTranscriptSelectionStore();
    return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useOptionalTranscriptSelectionState(): TranscriptMessageSelectionSnapshot {
    const store = React.useContext(TranscriptMessageSelectionContext);
    return React.useSyncExternalStore(
        store?.subscribe ?? subscribeInertSelection,
        store?.getSnapshot ?? getInertSelectionSnapshot,
        store?.getSnapshot ?? getInertSelectionSnapshot,
    );
}

export function useTranscriptSelectionActions(): TranscriptMessageSelectionActions {
    return useTranscriptSelectionStore();
}

export function useOptionalTranscriptSelectionActions(): TranscriptMessageSelectionActions | null {
    return React.useContext(TranscriptMessageSelectionContext) ?? null;
}

export function useInertTranscriptSelectionActions(): TranscriptMessageSelectionActions {
    return INERT_SELECTION_ACTIONS;
}

function useTranscriptSelectionRowFromStore(
    messageId: string,
    store: TranscriptMessageSelectionStore | null,
): Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    toggle: () => void;
}> {
    const rowSnapshot = React.useSyncExternalStore(
        store?.subscribe ?? subscribeInertSelection,
        () => store?.getRowSnapshot(messageId) ?? getInertRowSnapshot(),
        () => store?.getRowSnapshot(messageId) ?? getInertRowSnapshot(),
    );
    const [modeFlag, selectedFlag] = rowSnapshot.split(':');
    return React.useMemo(() => ({
        isSelectionMode: modeFlag === '1',
        isSelected: selectedFlag === '1',
        toggle: store ? () => store.toggle(messageId) : noopSelectionAction,
    }), [messageId, modeFlag, selectedFlag, store]);
}

export function useTranscriptSelectionRow(messageId: string): Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    toggle: () => void;
}> {
    return useTranscriptSelectionRowFromStore(messageId, useTranscriptSelectionStore());
}

export function useOptionalTranscriptSelectionRow(messageId: string): Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    toggle: () => void;
}> {
    return useTranscriptSelectionRowFromStore(messageId, React.useContext(TranscriptMessageSelectionContext));
}
