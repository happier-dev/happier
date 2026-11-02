import * as React from 'react';
import type { PaneHeaderContentLineSegment } from '@happier-dev/plugin-ui';

import type { IconName } from '@/components/ui/icons/Icon';
import { PaneHeaderScrollChannelsProvider, PaneHeaderScrollKey } from '@/components/appShell/panes/paneHeaderScroll';
import type { ItemAction } from '@/components/ui/lists/itemActions';

/**
 * One fact on a pane header's live line: plain text, or the one noun the line is about (a branch)
 * drawn with emphasis.
 */
export type PaneHeaderLineSegment =
    | string
    | Readonly<{ text: string; emphasis: true }>
    /** A line count of a change (`+4`, `−2`): the one place colour means added or removed. */
    | Readonly<{ text: string; tone: 'added' | 'removed' }>
    /** The one fact that needs the person ("1 waiting for you"): drawn in the attention colour. */
    | Readonly<{ text: string; attention: true }>
    /**
     * Something that failed ("3 problems"): drawn in the failure colour. With `onPress` it leads to
     * where the failures are listed.
     */
    | Readonly<{ text: string; failure: true; onPress?: () => void; accessibilityLabel?: string; testID?: string }>
    /**
     * A fact led by its glyph (the task a conversation hangs off, "Invited only" behind a lock). With
     * `onPress` it is a way back to that thing: a link that keeps the line's quiet tone until pointed at.
     */
    | Readonly<{ text: string; icon: IconName; onPress?: () => void; accessibilityLabel?: string; testID?: string }>;

/**
 * The pane header's live line: what this pane is about right now, in real nouns joined by " · "
 * ("v0.3 · 14 changed · 2 to push", "2 running on MacBook Pro"). `leading` is one small mark before
 * it (a branch glyph, a machine glyph, a running dot).
 */
export type PaneHeaderLine = Readonly<{
    leading?: React.ReactNode;
    /**
     * The leading leaf is words (a folder crumb, an author) that the line joins to its facts with its own
     * " · "; without it the facts follow the leading mark directly, as they follow a glyph.
     */
    leadingSeparated?: boolean;
    segments: readonly PaneHeaderLineSegment[];
}>;

/**
 * What a tab tells its pane header: the live line, the one trailing action (the likeliest next step)
 * and its rare operations. The header folds those into its single ⋯, after the action, with the
 * pane's own operations, so a band never carries two ⋯.
 */
export type PaneHeaderSlotContent = Readonly<{
    line?: PaneHeaderLine | null;
    action?: React.ReactNode;
    menuActions?: readonly ItemAction[];
}>;

type PaneHeaderSlotStore = Readonly<{
    publish(key: string, owner: object, content: PaneHeaderSlotContent): void;
    retract(key: string, owner: object): void;
    get(key: string): PaneHeaderSlotContent | null;
    subscribe(key: string, listener: () => void): () => void;
}>;

function sameSegment(left: PaneHeaderLineSegment, right: PaneHeaderLineSegment): boolean {
    if (typeof left === 'string' || typeof right === 'string') return left === right;
    const leftTone = 'tone' in left ? left.tone : 'attention' in left ? 'attention' : null;
    const rightTone = 'tone' in right ? right.tone : 'attention' in right ? 'attention' : null;
    return left.text === right.text && leftTone === rightTone;
}

function sameLine(left: PaneHeaderLine | null | undefined, right: PaneHeaderLine | null | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    if (left.leading !== right.leading || left.leadingSeparated !== right.leadingSeparated || left.segments.length !== right.segments.length) return false;
    return left.segments.every((segment, index) => sameSegment(segment, right.segments[index]!));
}

function sameContent(left: PaneHeaderSlotContent | null, right: PaneHeaderSlotContent | null): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.action === right.action && left.menuActions === right.menuActions && sameLine(left.line, right.line);
}

function createPaneHeaderSlotStore(): PaneHeaderSlotStore {
    const entries = new Map<string, { owner: object; content: PaneHeaderSlotContent }>();
    const listeners = new Map<string, Set<() => void>>();
    const notify = (key: string) => listeners.get(key)?.forEach((listener) => listener());
    return {
        publish(key, owner, content) {
            const previous = entries.get(key);
            if (previous?.owner === owner && sameContent(previous.content, content)) return;
            entries.set(key, { owner, content });
            notify(key);
        },
        retract(key, owner) {
            if (entries.get(key)?.owner !== owner) return;
            entries.delete(key);
            notify(key);
        },
        get: (key) => entries.get(key)?.content ?? null,
        subscribe(key, listener) {
            let set = listeners.get(key);
            if (!set) {
                set = new Set();
                listeners.set(key, set);
            }
            set.add(listener);
            return () => { set?.delete(listener); };
        },
    };
}

const PaneHeaderSlotStoreContext = React.createContext<PaneHeaderSlotStore | null>(null);
const PaneHeaderSlotKeyContext = React.createContext<string | null>(null);

/**
 * The pane that owns a header (the right sidebar, the phone cockpit screen): its tabs publish their
 * live line and trailing action here, and the one `PaneHeader` reads the active tab's entry. A tab's
 * re-render updates only the header, never the pane. Each tab also keeps its own scroll-shade channel,
 * which the header binds with `PaneHeaderScrollKey` under the same key (the continuous value never
 * passes through this store).
 */
export function PaneHeaderSlotProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [store] = React.useState(createPaneHeaderSlotStore);
    return <PaneHeaderSlotStoreContext.Provider value={store}>
        <PaneHeaderScrollChannelsProvider>{props.children}</PaneHeaderScrollChannelsProvider>
    </PaneHeaderSlotStoreContext.Provider>;
}

/** Names the tab whose content is rendered below it, so what it publishes (and its scroll) lands on that tab's header. */
export function PaneHeaderSlotScope(props: Readonly<{ slotKey: string; children: React.ReactNode }>) {
    return <PaneHeaderSlotKeyContext.Provider value={props.slotKey}>
        <PaneHeaderScrollKey scrollKey={props.slotKey}>{props.children}</PaneHeaderScrollKey>
    </PaneHeaderSlotKeyContext.Provider>;
}

/**
 * A tab declares its header content from wherever its data lives. Outside a header-owning pane (a
 * tab rendered on its own) it does nothing, so tabs never draw a second header of their own.
 */
export function usePaneHeaderSlotContent(content: PaneHeaderSlotContent): void {
    const store = React.useContext(PaneHeaderSlotStoreContext);
    const key = React.useContext(PaneHeaderSlotKeyContext);
    const [owner] = React.useState(() => ({}));
    React.useLayoutEffect(() => {
        if (store && key !== null) store.publish(key, owner, content);
    });
    React.useLayoutEffect(() => () => {
        if (store && key !== null) store.retract(key, owner);
    }, [key, owner, store]);
}

/**
 * A plugin tab's content for its pane header (`PaneHeaderContent` in `@happier-dev/plugin-ui`): its live
 * facts and trailing actions. Structurally the plugin-ui presentation host's pane header input.
 */
export type PluginPaneHeaderSlotInput = Readonly<{
    line: readonly PaneHeaderContentLineSegment[] | null;
    actions: React.ReactNode | null;
    /** A widget frame's source line in place of the plugin's name; a tab's pane header has no such slot. */
    caption?: string | null;
    /** A widget frame's footer link to the page `caption` names; a tab's pane header has no footer. */
    open?: (() => void) | null;
}>;

function PluginPaneHeaderPublisher(props: Readonly<{ input: PluginPaneHeaderSlotInput }>) {
    const { line, actions } = props.input;
    const content = React.useMemo<PaneHeaderSlotContent>(() => ({
        line: line === null || line.length === 0 ? null : { segments: line },
        action: actions ?? undefined,
    }), [actions, line]);
    usePaneHeaderSlotContent(content);
    return null;
}

/**
 * The binding a mounted plugin surface receives when it fills a tab whose pane owns a header (the
 * session sidebar, a phone surface): what it publishes lands on that tab's header exactly as a built-in
 * tab's `usePaneHeaderSlotContent` does. `null` outside a header-owning pane, so the plugin draws none.
 */
export function usePaneHeaderSlotBinding(): Readonly<{
    renderPaneHeader(input: PluginPaneHeaderSlotInput): React.ReactNode;
}> | null {
    const store = React.useContext(PaneHeaderSlotStoreContext);
    const key = React.useContext(PaneHeaderSlotKeyContext);
    return React.useMemo(() => (store === null || key === null ? null : {
        renderPaneHeader: (input: PluginPaneHeaderSlotInput) => <PluginPaneHeaderPublisher input={input} />,
    }), [key, store]);
}

const NO_SUBSCRIPTION = () => () => {};
const NO_CONTENT = () => null;

/** The header's read of one tab's published content; `null` when the tab has published nothing. */
export function usePublishedPaneHeaderContent(slotKey: string | null): PaneHeaderSlotContent | null {
    const store = React.useContext(PaneHeaderSlotStoreContext);
    const subscribe = React.useCallback(
        (listener: () => void) => (store && slotKey !== null ? store.subscribe(slotKey, listener) : NO_SUBSCRIPTION()),
        [slotKey, store],
    );
    const get = React.useCallback(() => (store && slotKey !== null ? store.get(slotKey) : null), [slotKey, store]);
    return React.useSyncExternalStore(subscribe, store ? get : NO_CONTENT, store ? get : NO_CONTENT);
}
