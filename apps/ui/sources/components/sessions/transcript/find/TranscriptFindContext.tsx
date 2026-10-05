import * as React from 'react';
import type { TranscriptFindRowStore } from './transcriptFindRowStore';

const TranscriptFindContext = React.createContext<TranscriptFindRowStore | null>(null);
const subscribeInactive = () => () => {};
const readInactive = () => null;

export function useTranscriptFindActive() {
    return React.useContext(TranscriptFindContext) !== null;
}

export function TranscriptFindProvider(props: Readonly<{ store: TranscriptFindRowStore; enabled?: boolean; children: React.ReactNode }>) {
    return <TranscriptFindContext.Provider value={props.enabled === false ? null : props.store}>{props.children}</TranscriptFindContext.Provider>;
}

export function useTranscriptFindRow(messageId: string | undefined) {
    const store = React.useContext(TranscriptFindContext);
    const subscribe = React.useCallback((listener: () => void) => (
        store && messageId ? store.subscribe(messageId, listener) : subscribeInactive()
    ), [store, messageId]);
    const read = React.useCallback(() => store && messageId ? store.getSnapshot(messageId) : null, [store, messageId]);
    return React.useSyncExternalStore(store && messageId ? subscribe : subscribeInactive,
        store && messageId ? read : readInactive, readInactive);
}
