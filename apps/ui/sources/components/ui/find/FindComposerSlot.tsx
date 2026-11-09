import * as React from 'react';
import { View } from 'react-native';


/**
 * The composer's slot on a phone screen. While a surface's Find is open on a phone, its seated bar (and
 * note) takes this slot as one unit, in place of the composer; Done gives the slot back. The composer is
 * hidden, never unmounted, so its draft and focus state survive Find (Find lab F1p).
 */
type FindComposerSlotSeat = Readonly<{ node: React.ReactNode; leaving: boolean }>;
type FindComposerSlotStore = Readonly<{
    get(): FindComposerSlotSeat | null;
    set(seat: FindComposerSlotSeat | null): void;
    subscribe(listener: () => void): () => void;
}>;

function createFindComposerSlotStore(): FindComposerSlotStore {
    let current: FindComposerSlotSeat | null = null;
    const listeners = new Set<() => void>();
    return {
        get: () => current,
        set(seat) {
            if (seat === current || (seat && current && seat.node === current.node && seat.leaving === current.leaving)) return;
            current = seat;
            for (const listener of listeners) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

const FindComposerSlotContext = React.createContext<FindComposerSlotStore | null>(null);
const subscribeNone = () => () => {};
const readNone = () => null;
const readFalse = () => false;
const isReplacingComposer = (seat: FindComposerSlotSeat | null): seat is FindComposerSlotSeat & { leaving: false } => seat !== null && !seat.leaving;

/** Subscribe only to slot ownership, not to each frame published by the seated bar. */
export function useFindComposerSlotReplacing(): boolean {
    const store = React.useContext(FindComposerSlotContext);
    const readReplacing = React.useCallback(() => isReplacingComposer(store?.get() ?? null), [store]);
    return React.useSyncExternalStore(store?.subscribe ?? subscribeNone, readReplacing, readFalse);
}

export function FindComposerSlotProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [store] = React.useState(createFindComposerSlotStore);
    return <FindComposerSlotContext.Provider value={store}>{props.children}</FindComposerSlotContext.Provider>;
}

/**
 * Where the screen mounts its composer. An open seated Find bar shows here instead; while it leaves, the
 * composer is already back (visible, focusable) and the bar's last frame settles out over it.
 */
export function FindComposerSlotHost(props: Readonly<{ composer: React.ReactNode }>) {
    const store = React.useContext(FindComposerSlotContext);
    const seat = React.useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.get ?? readNone, readNone);
    const replacing = isReplacingComposer(seat);
    return <>
        {replacing ? <View testID="find-composer-slot">{seat.node}</View> : null}
        <View style={replacing ? { display: 'none' } : { position: 'relative' }}>
            {props.composer}
            {seat?.leaving ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0 }}>{seat.node}</View> : null}
        </View>
    </>;
}

/** Publishes `node` into the screen's composer slot while `active`; returns whether a slot took it. */
export function useFindComposerSlotSeat(node: React.ReactNode, active: boolean, leaving = false): boolean {
    const store = React.useContext(FindComposerSlotContext);
    const seated = Boolean(store) && active;
    // Every commit carries the bar's latest frame into the slot; the slot re-renders alone.
    React.useLayoutEffect(() => { if (store && seated) store.set({ node, leaving }); });
    React.useLayoutEffect(() => {
        if (!store || !seated) return;
        return () => store.set(null);
    }, [store, seated]);
    return seated;
}
