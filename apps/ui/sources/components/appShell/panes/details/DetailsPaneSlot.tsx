import * as React from 'react';
import { PaneHeaderScrollScope } from '@/components/appShell/panes/paneHeaderScroll';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PluginUiDetailsPaneHost, PluginUiDetailsPanePresentation } from '@happier-dev/plugin-ui/advanced';

import { PaneHeader } from '../PaneHeader';
import { DetailsPaneHost, type DetailsPaneContent } from './DetailsPaneHost';
import { useDetailsPaneAvailable } from './detailsPaneAvailability';

/** What a plugin surface's `DetailsPane` (or a `Collection` opening an item) publishes: plugin-ui's contract. */
export type DetailsPaneSlotPresentation = PluginUiDetailsPanePresentation;

/** The binding a mounted plugin surface receives as its presentation host's `detailsPane`. */
export type DetailsPaneSlotBinding = PluginUiDetailsPaneHost;

/** The pane's frame: what docks or undocks the pane and titles it. Changes rarely. */
type DetailsPaneSlotFrame = Readonly<{
    title?: string;
    /** The facts line: one string, or separate facts the header wraps between (never inside one). */
    subtitle?: string | readonly string[];
    testID?: string;
    /** A host page's companion beside its own content (Logs, Session), not an item opened from a list. */
    companion?: true;
}>;

/** What the slot accepts: plugin-ui's publication, or a host page's companion through {@link DetailCompanionPane}. */
type DetailsPaneSlotPublication = DetailsPaneSlotPresentation & Readonly<{ companion?: true }>;

/**
 * The pane's body: changes whenever the detail re-renders, read only by the pane's own leaf. The header's marks
 * (identity beside the title, the mark leading the line) are elements a detail re-creates per render, so they
 * travel here rather than in the frame the page subscribes to.
 */
type DetailsPaneSlotBody = Readonly<{
    headingRef?: PluginUiDetailsPanePresentation['headingRef'];
    leading?: React.ReactNode;
    subtitleLeading?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
}>;

type DetailsPaneSlotStore = Readonly<{
    publish(owner: object, input: DetailsPaneSlotPublication): void;
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
    return left.title === right.title && sameSubtitle(left.subtitle, right.subtitle) && left.testID === right.testID
        && left.companion === right.companion;
}

/** A detail re-creates its facts array per render; equal facts must not republish the frame. */
function sameSubtitle(left: DetailsPaneSlotFrame['subtitle'], right: DetailsPaneSlotFrame['subtitle']): boolean {
    if (left === right) return true;
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    return left.length === right.length && left.every((fact, index) => fact === right[index]);
}

function subtitleSegments(subtitle: DetailsPaneSlotFrame['subtitle']): readonly string[] {
    return subtitle === undefined ? [] : typeof subtitle === 'string' ? (subtitle ? [subtitle] : []) : subtitle;
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
            && body.actions === next.actions && body.headingRef === next.headingRef
            && body.leading === next.leading && body.subtitleLeading === next.subtitleLeading)) return;
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
                ...(input.companion ? { companion: true as const } : {}),
            });
            setBody({
                actions: input.actions,
                children: input.children,
                headingRef: input.headingRef,
                leading: input.leading,
                subtitleLeading: input.subtitleLeading,
            });
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
function DetailsPanePublisher(props: Readonly<{ store: DetailsPaneSlotStore; input: DetailsPaneSlotPublication }>) {
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
            <PaneHeaderScrollScope>
            {props.frame.title ? (
                <PaneHeader
                    testID={`${testID}.header`}
                    // A detail is about one thing, so it opens on that thing's name at page-title size over its
                    // facts line (lab c7 detail), the same title its pushed form shows on a phone. A companion
                    // names a tool beside the page (Logs, Session), so it keeps the pane's own header size.
                    {...(props.frame.companion ? {} : { size: 'large' as const })}
                    // The name wraps rather than cuts off the words that tell two entries apart (lab c7).
                    titleNumberOfLines={2}
                    title={props.frame.title}
                    {...(body?.subtitleLeading === undefined && typeof props.frame.subtitle !== 'object'
                        ? { subtitle: props.frame.subtitle }
                        // Each fact is its own segment, so the line wraps between facts rather than inside an id.
                        : { line: { ...(body?.subtitleLeading === undefined ? {} : { leading: body.subtitleLeading }),
                            segments: subtitleSegments(props.frame.subtitle) } })}
                    leading={body?.leading}
                    mainRestoreChip
                    actions={body?.actions}
                    headingRef={body?.headingRef}
                    onClose={props.store.close}
                />
            ) : null}
            <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{body?.children}</View>
            </PaneHeaderScrollScope>
        </View>
    );
});

/** An item opened beside its list reads in the larger share until the person drags it (lab c7: 750 px at 1440). */
export const ITEM_DETAILS_PREFERRED_WIDTH_PX = 750;

/**
 * A page whose content may open an item beside it. The same slot feeds the default App details host or a
 * target's existing physical pane host; persisted width, dock/overlay, Escape and focus remain host-owned.
 */
export const DetailsPaneSlotHost = React.memo(function DetailsPaneSlotHost(props: Readonly<{
    children: React.ReactNode;
    mainColumn?: React.ComponentProps<typeof DetailsPaneHost>['mainColumn'];
    testID?: string;
    /** Reuse a target's existing physical pane host instead of the default App host. */
    renderHost?: (input: Readonly<{
        main: React.ReactNode;
        details: DetailsPaneContent | null;
        onCloseDetails: () => void;
    }>) => React.ReactNode;
}>) {
    const [store] = React.useState(createDetailsPaneSlotStore);
    const frame = React.useSyncExternalStore(store.subscribeFrame, store.getFrame, store.getFrame);
    const details = React.useMemo(() => frame === null ? null : {
        ...(frame.title === undefined ? {} : { accessibilityLabel: frame.title }),
        ...(frame.companion ? { companion: true as const } : {}),
        content: <DetailsPaneSlotBodyView store={store} frame={frame} />,
    }, [frame, store]);
    const main = React.useMemo(
        () => <DetailsPaneSlotContext.Provider value={store}>{props.children}</DetailsPaneSlotContext.Provider>,
        [props.children, store],
    );
    if (props.renderHost) return props.renderHost({ main, details, onCloseDetails: store.close });
    return (
        <DetailsPaneHost
            main={main}
            mainColumn={props.mainColumn}
            details={details}
            onCloseDetails={store.close}
            detailsPreferredWidthPx={ITEM_DETAILS_PREFERRED_WIDTH_PX}
            testID={frame?.testID ?? props.testID}
        />
    );
});

/**
 * The binding for a plugin surface mounted inside a {@link DetailsPaneSlotHost}; null elsewhere, so the surface's
 * `DetailsPane` pushes its detail inside the page instead. The binding retains the same phone push fallback.
 */
export function useDetailsPaneSlotBinding(): DetailsPaneSlotBinding | null {
    const store = React.useContext(DetailsPaneSlotContext);
    return React.useMemo(() => store === null ? null : {
        useAvailable: useDetailsPaneAvailable,
        renderDetailsPane: (input: DetailsPaneSlotPresentation) => <DetailsPanePublisher store={store} input={input} />,
    }, [store]);
}

/**
 * A host page's companion (an Environment's Logs or Session) in the page's own details pane: published into the
 * enclosing {@link DetailsPaneSlotHost} as a companion, so it docks beside the page it was opened from and the page
 * never steps aside for it. Where there is no pane beside the page (phones, side panes off, a page mounted outside a
 * slot host) it is pushed inside the page, over its content, with the header's close as the way back: the same rule
 * plugin-ui's `DetailsPane` follows. The caller owns which companion is open (its detail navigation's side column).
 */
export function DetailCompanionPane(props: Readonly<{
    open: boolean;
    title: string;
    subtitle?: string;
    actions?: React.ReactNode;
    onClose: () => void;
    children?: React.ReactNode;
    testID?: string;
}>): React.ReactElement | null {
    const store = React.useContext(DetailsPaneSlotContext);
    const beside = useDetailsPaneAvailable();
    if (store !== null && beside) {
        return <DetailsPanePublisher store={store} input={{ open: props.open, title: props.title, companion: true,
            ...(props.subtitle === undefined ? {} : { subtitle: props.subtitle }),
            ...(props.actions === undefined ? {} : { actions: props.actions }),
            ...(props.testID === undefined ? {} : { testID: props.testID }),
            onClose: props.onClose, children: props.children }} />;
    }
    if (!props.open) return null;
    const testID = props.testID ?? 'details-pane';
    return (
        <View testID={testID} style={styles.pushed}>
            <PaneHeaderScrollScope>
                <PaneHeader testID={`${testID}.header`} title={props.title} subtitle={props.subtitle}
                    actions={props.actions} onClose={props.onClose} />
                <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{props.children}</View>
            </PaneHeaderScrollScope>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Pushed over the page's content, on the page's ground.
    pushed: { ...StyleSheet.absoluteFillObject, zIndex: 1, backgroundColor: theme.colors.surface.base },
}));
