import * as React from 'react';
import { View } from 'react-native';
import type { PluginUiDetailsPaneHost, PluginUiDetailsPanePresentation } from '@happier-dev/plugin-ui/advanced';

import { PaneHeader } from '../PaneHeader';
import { DetailsPaneHost } from './DetailsPaneHost';
import { useDetailsPaneAvailable } from './detailsPaneAvailability';

/** What a plugin surface's `DetailsPane` (or a `Collection` opening an item) publishes: plugin-ui's contract. */
export type DetailsPaneSlotPresentation = PluginUiDetailsPanePresentation;

/** The binding a mounted plugin surface receives as its presentation host's `detailsPane`. */
export type DetailsPaneSlotBinding = PluginUiDetailsPaneHost;

/** The pane's frame: what docks or undocks the pane and titles it. Changes rarely. */
type DetailsPaneSlotFrame = Readonly<{
    title?: string;
    subtitle?: string;
    testID?: string;
}>;

/** The pane's body: changes whenever the detail re-renders, read only by the pane's own leaf. */
type DetailsPaneSlotBody = Readonly<{
    headingRef?: PluginUiDetailsPanePresentation['headingRef'];
    actions?: React.ReactNode;
    children?: React.ReactNode;
}>;

type DetailsPaneSlotStore = Readonly<{
    publish(owner: object, input: DetailsPaneSlotPresentation): void;
    retract(owner: object): void;
    close(): void;
    getFrame(): DetailsPaneSlotFrame | null;
    getBody(): DetailsPaneSlotBody | null;
    subscribeFrame(listener: () => void): () => void;
    subscribeBody(listener: () => void): () => void;
}>;

function sameFrame(left: DetailsPaneSlotFrame | null, right: DetailsPaneSlotFrame | null): boolean {
    if (left === right) return true;
    if (left === null || right === null) return false;
    return left.title === right.title && left.subtitle === right.subtitle && left.testID === right.testID;
}

/**
 * One page's details pane content, published from wherever the plugin declares it. The page subscribes only to the
 * frame (open, title), so a detail re-rendering never re-renders the page; the pane's leaf subscribes to the body.
 */
function createDetailsPaneSlotStore(): DetailsPaneSlotStore {
    let owner: object | null = null;
    let frame: DetailsPaneSlotFrame | null = null;
    let body: DetailsPaneSlotBody | null = null;
    let onClose: (() => void) | null = null;
    const frameListeners = new Set<() => void>();
    const bodyListeners = new Set<() => void>();
    const setFrame = (next: DetailsPaneSlotFrame | null) => {
        if (sameFrame(frame, next)) return;
        frame = next;
        frameListeners.forEach((listener) => listener());
    };
    const setBody = (next: DetailsPaneSlotBody | null) => {
        if (body === next || (body !== null && next !== null && body.children === next.children
            && body.actions === next.actions && body.headingRef === next.headingRef)) return;
        body = next;
        bodyListeners.forEach((listener) => listener());
    };
    return {
        publish(nextOwner, input) {
            if (!input.open) {
                if (owner === nextOwner) this.retract(nextOwner);
                return;
            }
            owner = nextOwner;
            onClose = input.onClose;
            setFrame({
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
                ...(input.testID === undefined ? {} : { testID: input.testID }),
            });
            setBody({ actions: input.actions, children: input.children, headingRef: input.headingRef });
        },
        retract(retiring) {
            if (owner !== retiring) return;
            owner = null;
            onClose = null;
            setFrame(null);
            setBody(null);
        },
        close() {
            onClose?.();
        },
        getFrame: () => frame,
        getBody: () => body,
        subscribeFrame(listener) {
            frameListeners.add(listener);
            return () => { frameListeners.delete(listener); };
        },
        subscribeBody(listener) {
            bodyListeners.add(listener);
            return () => { bodyListeners.delete(listener); };
        },
    };
}

const DetailsPaneSlotContext = React.createContext<DetailsPaneSlotStore | null>(null);

/** Publishes from where the detail is declared; renders nothing in place. */
function DetailsPanePublisher(props: Readonly<{ store: DetailsPaneSlotStore; input: DetailsPaneSlotPresentation }>) {
    const [owner] = React.useState(() => ({}));
    const { store, input } = props;
    React.useLayoutEffect(() => {
        store.publish(owner, input);
    });
    React.useLayoutEffect(() => () => store.retract(owner), [owner, store]);
    return null;
}

/** The pane's header band and the detail, read from the slot. */
const DetailsPaneSlotBodyView = React.memo(function DetailsPaneSlotBodyView(props: Readonly<{
    store: DetailsPaneSlotStore;
    frame: DetailsPaneSlotFrame;
}>) {
    const body = React.useSyncExternalStore(props.store.subscribeBody, props.store.getBody, props.store.getBody);
    const testID = props.frame.testID ?? 'details-pane';
    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {props.frame.title ? (
                <PaneHeader
                    testID={`${testID}.header`}
                    title={props.frame.title}
                    subtitle={props.frame.subtitle}
                    actions={body?.actions}
                    headingRef={body?.headingRef}
                    onClose={props.store.close}
                />
            ) : null}
            <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{body?.children}</View>
        </View>
    );
});

/**
 * A page whose content (a plugin page) may open an item beside it: the page's app details pane — the one
 * `DetailsPaneHost` every destination uses (persisted width, docked or overlay by the pane budget, Escape and focus
 * return) — fed by whatever surface inside the page declares a `DetailsPane`.
 */
export const DetailsPaneSlotHost = React.memo(function DetailsPaneSlotHost(props: Readonly<{
    children: React.ReactNode;
    testID?: string;
}>) {
    const [store] = React.useState(createDetailsPaneSlotStore);
    const frame = React.useSyncExternalStore(store.subscribeFrame, store.getFrame, store.getFrame);
    const details = React.useMemo(() => frame === null ? null : {
        ...(frame.title === undefined ? {} : { accessibilityLabel: frame.title }),
        content: <DetailsPaneSlotBodyView store={store} frame={frame} />,
    }, [frame, store]);
    const main = React.useMemo(
        () => <DetailsPaneSlotContext.Provider value={store}>{props.children}</DetailsPaneSlotContext.Provider>,
        [props.children, store],
    );
    return (
        <DetailsPaneHost
            main={main}
            details={details}
            onCloseDetails={store.close}
            testID={frame?.testID ?? props.testID}
        />
    );
});

/**
 * The binding for a plugin surface mounted inside a {@link DetailsPaneSlotHost}; null elsewhere, so the surface's
 * `DetailsPane` pushes its detail inside the page instead.
 */
export function useDetailsPaneSlotBinding(): DetailsPaneSlotBinding | null {
    const store = React.useContext(DetailsPaneSlotContext);
    return React.useMemo(() => store === null ? null : {
        useAvailable: useDetailsPaneAvailable,
        renderDetailsPane: (input: DetailsPaneSlotPresentation) => <DetailsPanePublisher store={store} input={input} />,
    }, [store]);
}
