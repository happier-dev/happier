import * as React from 'react';

const TranscriptRowContentDemandContext = React.createContext(true);

export type TranscriptRendererContentDemand = Readonly<{
    isViewable: (key: string) => boolean;
    subscribe: (key: string, listener: () => void) => () => void;
    publish: (keys: readonly string[]) => void;
}>;

/** A renderer-local projection of its existing viewability publication, never a geometry reader. */
export function createTranscriptRendererContentDemand(): TranscriptRendererContentDemand {
    let viewableKeys: ReadonlySet<string> = new Set();
    const listenersByKey = new Map<string, Set<() => void>>();
    return {
        isViewable: (key: string) => viewableKeys.has(key),
        subscribe: (key: string, listener: () => void) => {
            const listeners = listenersByKey.get(key) ?? new Set();
            listeners.add(listener);
            listenersByKey.set(key, listeners);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) listenersByKey.delete(key);
            };
        },
        publish: (keys: readonly string[]) => {
            const next = new Set(keys);
            const changed = new Set([...viewableKeys, ...next]);
            const previous = viewableKeys;
            viewableKeys = next;
            for (const key of changed) {
                if (previous.has(key) === next.has(key)) continue;
                for (const listener of listenersByKey.get(key) ?? []) listener();
            }
        },
    };
}

const TranscriptRendererContentDemandContext = React.createContext<TranscriptRendererContentDemand | null>(null);
const NO_SUBSCRIPTION = () => () => undefined;

export function TranscriptRendererContentDemandProvider(props: Readonly<{
    demand: TranscriptRendererContentDemand;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <TranscriptRendererContentDemandContext.Provider value={props.demand}>
            {props.children}
        </TranscriptRendererContentDemandContext.Provider>
    );
}

/** Direct detail views demand content; virtualized rows publish their renderer visibility. */
export function useTranscriptRowContentDemand(): boolean {
    return React.useContext(TranscriptRowContentDemandContext);
}

export function TranscriptContentDemandProvider(props: Readonly<{
    enabled: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const parentEnabled = useTranscriptRowContentDemand();
    return (
        <TranscriptRowContentDemandContext.Provider value={parentEnabled && props.enabled}>
            {props.children}
        </TranscriptRowContentDemandContext.Provider>
    );
}

export function TranscriptRendererRowContentDemandProvider(props: Readonly<{
    itemKey: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const demand = React.useContext(TranscriptRendererContentDemandContext);
    const active = useTranscriptRowContentDemand();
    const subscribe = React.useCallback((listener: () => void) => (
        demand?.subscribe(props.itemKey, listener) ?? (() => undefined)
    ), [demand, props.itemKey]);
    const readVisible = React.useCallback(() => (
        active && demand?.isViewable(props.itemKey) === true
    ), [active, demand, props.itemKey]);
    const visible = React.useSyncExternalStore(active ? subscribe : NO_SUBSCRIPTION, readVisible, readVisible);
    return <TranscriptContentDemandProvider enabled={visible}>{props.children}</TranscriptContentDemandProvider>;
}
