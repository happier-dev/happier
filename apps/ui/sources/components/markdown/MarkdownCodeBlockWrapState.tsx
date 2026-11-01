import * as React from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { useSetting } from '@/sync/domains/state/storage';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

function createWrapStore() {
    // Keep explicit false choices too, so changing the account default only affects untouched blocks.
    return createStore<ReadonlyMap<string, boolean>>(() => new Map());
}

const WrapStoreContext = React.createContext<ReturnType<typeof createWrapStore> | null>(null);
const WrapKeyContext = React.createContext<string | null>(null);

export const MarkdownCodeBlockWrapKeyProvider = WrapKeyContext.Provider;

export function MarkdownCodeBlockWrapStateProvider({ children }: Readonly<{ children: React.ReactNode }>) {
    // The transcript owns the lifetime so recycling an individual row does not erase its choices.
    const [store] = React.useState(createWrapStore);
    return <WrapStoreContext.Provider value={store}>{children}</WrapStoreContext.Provider>;
}

export function useMarkdownCodeBlockWrapKey(): string | null {
    return React.useContext(WrapKeyContext);
}

export function useMarkdownCodeBlockWrap(): readonly [boolean, (wrapped: boolean) => void] {
    const retainedStore = React.useContext(WrapStoreContext);
    const key = useMarkdownCodeBlockWrapKey();
    const defaultWrapped = useSetting('wrapChatCodeBlocks') === true;
    // Standalone Markdown also supports wrapping, without sharing anonymous blocks' state.
    const [localStore] = React.useState(() => key && retainedStore ? retainedStore : createWrapStore());
    const store = key && retainedStore ? retainedStore : localStore;
    const blockKey = key ?? '';
    const wrapped = useStore(store, state => state.get(blockKey) ?? defaultWrapped);
    const notifyLayoutMutation = useTranscriptRowLayoutMutation();
    const setWrapped = React.useCallback((next: boolean) => {
        if (store.getState().get(blockKey) === next) return;
        notifyLayoutMutation({ reason: next ? 'expand' : 'collapse', sourceId: blockKey });
        store.setState((previous) => {
            const updated = new Map(previous);
            updated.set(blockKey, next);
            return updated;
        }, true);
    }, [blockKey, notifyLayoutMutation, store]);
    return [wrapped, setWrapped];
}
