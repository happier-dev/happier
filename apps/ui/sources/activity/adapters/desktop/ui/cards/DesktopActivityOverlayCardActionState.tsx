import * as React from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { DesktopActivityOverlayActionDescriptor } from '../shared/desktopActivityOverlayUiModel';

type CardActionState = Readonly<{
    answer: string | null;
    failure: Readonly<{ action: DesktopActivityOverlayActionDescriptor; label: string; errorCode?: string }> | null;
    freeAnswerOpen: boolean;
    freeAnswer: string;
}>;
const EMPTY: CardActionState = { answer: null, failure: null, freeAnswerOpen: false, freeAnswer: '' };
type InventoryState = Readonly<Record<string, CardActionState>>;
const CardActionStateContext = React.createContext<StoreApi<InventoryState> | null>(null);

/** Interactive state lives as long as its card inventory, independently of recycled rows. */
export function DesktopActivityOverlayCardActionStateProvider(props: React.PropsWithChildren<Readonly<{
    cards: readonly Readonly<{ id: string }>[];
}>>): React.ReactElement {
    const [store] = React.useState(() => createStore<InventoryState>(() => ({})));
    React.useEffect(() => {
        const ids = new Set(props.cards.map(card => card.id));
        const state = store.getState();
        const entries = Object.entries(state).filter(([id]) => ids.has(id));
        if (entries.length !== Object.keys(state).length) store.setState(Object.fromEntries(entries), true);
    }, [props.cards, store]);
    return <CardActionStateContext.Provider value={store}>{props.children}</CardActionStateContext.Provider>;
}

export function useDesktopActivityOverlayCardActionState(cardId: string) {
    const store = React.useContext(CardActionStateContext);
    if (!store) throw new Error('Card actions require their overlay inventory');
    const state = useStore(store, values => values[cardId] ?? EMPTY);
    const update = React.useCallback((patch: Partial<CardActionState>) => {
        store.setState(values => ({ [cardId]: { ...(values[cardId] ?? EMPTY), ...patch } }));
    }, [cardId, store]);
    return { state, update };
}
