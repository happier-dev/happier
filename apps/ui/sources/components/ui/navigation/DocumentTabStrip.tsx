import * as React from 'react';
import { I18nManager, Image, Platform, Pressable, ScrollView, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Typography } from '@/constants/Typography';
import { PinIcon } from '@/components/sessions/shell/sessionPinIcons';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HAPPIER_FOCUS_RING_V1, happierFocusRingStyle, isHappierFocusVisible, resolveHappierTabKeySelection, useHappierHitArea, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE, HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import type { EntityDragItemV1, EntityDragKindV1, EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { measureWindowBounds, readWindowBounds, useEntityDragSource, useEntityDropTarget, useEntityDropTargetState, type EntityDragDropRuntime, type EntityDragInput, type WindowBounds } from '@/components/ui/treeDragDrop';
import { isSecondaryEntityRowControl, useEntityDragDomBinding, useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { TreeDropIndicatorLine } from '@/components/ui/treeDragDrop/ui/TreeDropIndicatorLine';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { createEntityDragGestureAdapter, ENTITY_DRAG_ACTIVATION_DISTANCE_PX } from '@/components/ui/treeDragDrop/entityDragGestureAdapter';
import { resolveTreeDropAutoscrollTarget } from '@/components/ui/treeDragDrop/autoscroll/useTreeDropAutoscroll';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { resolveHorizontalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';

export type DocumentTabEntityDragSource = Readonly<{
    runtime: EntityDragDropRuntime;
    id: string;
    scope: EntityDragScopeV1;
    getItem: (tabKey: string) => EntityDragItemV1 | null;
    isCurrent?: () => boolean;
    /** Phone rails keep horizontal scrolling while a vertical pan carries the shown entity. */
    nativeDragAxis?: 'vertical';
}>;
export type DocumentTabEntityDragDrop = DocumentTabEntityDragSource & Readonly<{
    acceptedKinds: readonly EntityDragKindV1[];
    resolve: (input: Readonly<{ item: EntityDragItemV1; beforeTabId: string | null; input: EntityDragInput }>) => EntityDropAdmissionV1;
    execute: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
}>;

type ScrollPropagationEvent = Readonly<{ stopPropagation?: () => void }>;
type DocumentTabWebPressableProps = React.ComponentPropsWithRef<typeof Pressable> & Readonly<{
    onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
    onAuxClick?: React.MouseEventHandler<HTMLElement>;
}>;

const DocumentTabWebPressable = Pressable as unknown as React.ComponentType<DocumentTabWebPressableProps>;

export type DocumentTabStripTestIds = Readonly<{
    tab?: (tabKey: string) => string | null | undefined;
    tabPin?: (tabKey: string) => string | null | undefined;
    tabUnpin?: (tabKey: string) => string | null | undefined;
    tabClose?: (tabKey: string) => string | null | undefined;
    tabFavicon?: (tabKey: string) => string | null | undefined;
    tabSpinner?: (tabKey: string) => string | null | undefined;
    tabUnsaved?: (tabKey: string) => string | null | undefined;
    tabStatus?: (tabKey: string) => string | null | undefined;
}>;

/**
 * Generic, kind-agnostic per-tab leading-glyph presentation. A consumer surface (e.g. the browser
 * `browser-view` tab) supplies a live favicon URL and/or loading flag per tab; the canonical strip
 * renders a spinner while loading, then the favicon, falling back to the per-kind icon. This is the
 * single home for tab leading chrome — the browser no longer ships a bespoke tab strip.
 */
export type DocumentTabPresentation = Readonly<{
    faviconUrl?: string | null;
    isLoading?: boolean;
    /**
     * Live status in the tab chrome. Close takes the bar/rail slot on the active tab and on hover;
     * pinned marks keep a small status overlay. The label is read with the tab's name.
     */
    status?: DocumentTabStatus | null;
    /** The instance's own identity mark (a Bot's face), drawn in place of the destination glyph. */
    mark?: React.ReactNode;
}>;

/**
 * The dot a tab status draws: live tones (running, needs you) carry a soft halo, settled ones do not
 * (terminal lab B1). Lists that show the same statuses use this too, so a tab and its row agree.
 */
export function resolveDocumentTabStatusDot(
    theme: Readonly<{ colors: Readonly<{ state: Readonly<{ success: Readonly<{ foreground: string; background: string }>; warning: Readonly<{ foreground: string; background: string }> }>; status: Readonly<{ error: string }>; text: Readonly<{ tertiary: string }> }> }>,
    tone: DocumentTabStatus['tone'],
): Readonly<{ color: string; halo?: string }> {
    switch (tone) {
        case 'running': return { color: theme.colors.state.success.foreground, halo: theme.colors.state.success.background };
        case 'attention': return { color: theme.colors.state.warning.foreground, halo: theme.colors.state.warning.background };
        case 'ended': return { color: theme.colors.text.tertiary };
        case 'working':
        case 'offline': return { color: theme.colors.text.tertiary };
        case 'failed': return { color: theme.colors.status.error };
    }
}

export type DocumentTabStatus = Readonly<{
    tone: 'running' | 'working' | 'attention' | 'ended' | 'offline' | 'failed';
    /** Already translated: "Running", "Needs you". */
    label: string;
}>;

/** A label projection owned by the destination; each mounted tab subscribes to its own source. */
export type DocumentTabTitleSource = Readonly<{
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => string | null;
}>;

export type DocumentTabItem = Readonly<{
    key: string;
    title: string;
    titleSource?: DocumentTabTitleSource;
    subtitle?: string | null;
    isPreview: boolean;
    isPinned: boolean;
    canPin?: boolean;
    /** Still open, but this device cannot show it: the tab stays, quiet, and says so when opened. */
    isUnavailable?: boolean;
}>;

export type DocumentTabStripProps<T extends DocumentTabItem> = Readonly<{
    tabs: readonly T[];
    activeTabKey: string | null;
    accessibilityLabel: string;
    onActivate: (key: string) => void;
    onPin: (key: string) => void;
    onUnpin: (key: string) => void;
    onClose: (key: string) => void;
    renderLeadingIcon: (tab: T, active: boolean) => React.ReactNode;
    /** A destination owner may add its row gestures around the shared tab anatomy. */
    wrapTab?: (tab: T, content: React.ReactNode) => React.ReactNode;
    resolveTabPresentation?: ((tab: T) => DocumentTabPresentation | null | undefined) | null;
    tabNativeId: (key: string) => string;
    panelNativeId?: (key: string) => string;
    unsavedTabKeys?: ReadonlySet<string>;
    testIds?: DocumentTabStripTestIds;
    /**
     * `strip` (default): the Details strip — tabs scroll, each shows its pin and close.
     * `bar`: the workspace bar (workspace lab T) — pinned marks stay fixed, while every other tab
     * shrinks to its minimum width and then scrolls. Close appears on hover and on the open tab
     * in one always-reserved trailing slot. Pinning lives in the tab's menu.
     * `rail`: the phone's open-tabs rail (phone-nav lab R) — the bar's anatomy as pills that scroll
     * sideways: each tab rests on a hairline, the open one takes the selection fill and its close,
     * and `subtitle` reads as a quiet count after the title (a split's panes).
     */
    variant?: 'strip' | 'bar' | 'rail';
    /** `rail` only: what follows the last tab inside the scroll (the "Synced" note). */
    railTrailing?: React.ReactNode;
    /**
     * `bar` only. `focused` (the default): the open tab takes the full soft ink fill — the focused
     * pane's tab, the one focus signal. `unfocused`: the open tab of a pane that is not focused takes
     * half that fill and secondary ink.
     */
    activeEmphasis?: 'focused' | 'unfocused';
    /** `bar` and `rail`: a tab's menu, from a right click or a long press. */
    onTabMenu?: (key: string, event: unknown) => void;
    /** Retire an open press menu when this tab becomes the carried source. */
    onDismissTabMenu?: (key: string) => void;
    /** `bar` only: the tablist's own height (30 in the title strip, 28 in a pane's own strip). */
    barTabHeightPx?: number;
    entityDragDrop?: DocumentTabEntityDragDrop;
    /** A tab may carry its entity without advertising this strip as a drop destination. */
    entityDragSource?: DocumentTabEntityDragSource;
    /**
     * `bar` only, while an item is carried (DnD lab C2): `dropSlot` shows the place a kept tab will
     * land at the end of the strip; `dropRingTabKey` rings the tab an already-open item will go to.
     */
    dropSlot?: boolean;
    dropRingTabKey?: string | null;
    /** `bar` only: the surface under the strip, which its edge fades blend into. */
    barFadeColor?: string;
}>;

/** The bar variant's measures (workspace lab T: 30 tall in the title strip, 28 in a pane strip). */
export const DOCUMENT_TAB_BAR_METRICS = Object.freeze({
    tabHeightPx: 30,
    tabRadiusPx: 9,
    tabPaddingStartPx: 10,
    tabPaddingEndPx: 5,
    tabGapPx: 7,
    tabMinWidthPx: 144,
    tabMaxWidthPx: 212,
    glyphBoxPx: 16,
    trailingSlotPx: 18,
    trailingRadiusPx: 5,
    stripGapPx: 2,
});
const B = DOCUMENT_TAB_BAR_METRICS;
/**
 * The bar close takes back from its own tab only what the 24 px pointer floor needs past the tab's end
 * padding (WCAG 2.5.8): one pixel at these metrics, never the neighbour's side of the strip gap.
 */
const BAR_CLOSE_LEADING_REACH_PX = Math.max(0, HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE - B.trailingSlotPx - B.tabPaddingEndPx);
/**
 * The phone rail is touched, never pointed at: every tab is at least a finger wide (a pinned mark sits
 * centred in that slot), and the scroll viewport keeps room above and below the 30 pt pill so the tab's
 * hit area reaches the full finger height without leaving the clip. Neighbours never share a slot: the
 * reach is vertical only, the width is the tab's own.
 */
const RAIL_TOUCH_PX = HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE;
const RAIL_TAB_REACH_PX = (RAIL_TOUCH_PX - B.tabHeightPx) / 2;
/** The open rail tab's close takes a finger's width from its own tab (already open, so nothing is lost). */
const RAIL_CLOSE_LEADING_REACH_PX = Math.max(0, RAIL_TOUCH_PX - B.trailingSlotPx - B.tabPaddingEndPx);
/**
 * Room above and below the bar's tabs, inside its scroll clip, for a tab's keyboard focus ring (drawn
 * outside the tab at the shared ring's width and gap). The open tab is a flat fill, so nothing else
 * paints past a tab's box.
 */
const BAR_SCROLL_BLEED_PX = HAPPIER_FOCUS_RING_V1.widthPx + HAPPIER_FOCUS_RING_V1.gapPx;
/** Web only: a closed tab's hover fill eases in and out; the open tab's fill applies at once. */
const BAR_TAB_HOVER_PAINT = Platform.OS === 'web' ? {
    transitionProperty: 'background-color',
    transitionDuration: `${motionTokens.durationMs.hover}ms`,
    transitionTimingFunction: motionTokens.easingCss.standard,
// react-native-web transition style keys; React Native's ViewStyle does not declare them.
} as unknown as ViewStyle : null;

// Details lab 2 (`dl-strip`): tabs sit borderless on the strip; the open one takes the selection
// fill, a preview tab reads in italics, a pinned tab shows its pin and an edited one its dot.
const stylesheet = StyleSheet.create((theme) => ({
    tabsScroll: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    tabsContent: {
        alignItems: 'center',
        gap: M.tabGapPx,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: M.tabRadiusPx,
        maxWidth: M.tabMaxWidthPx,
        flexShrink: 0,
    },
    tabContent: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingLeft: M.tabPaddingStartPx,
        paddingRight: theme.space.s2,
        minHeight: M.tabHeightPx,
    },
    tabActive: {
        backgroundColor: theme.colors.surface.elevated,
    },
    tabLabel: {
        flexShrink: 1,
        ...M.tabLabel,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    tabLabelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    tabLabelPreview: {
        fontStyle: 'italic',
    },
    tabCopy: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s6,
    },
    tabSubtitle: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
        // The subtitle gives way first: a narrow tab keeps its title readable ("Checkout UI…")
        // rather than shrinking both to "C…" and "R…".
        flexShrink: 1000,
        minWidth: 0,
    },
    tabActions: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: M.tabPaddingEndPx,
    },
    unsavedDot: {
        width: M.tabUnsavedDotPx,
        height: M.tabUnsavedDotPx,
        borderRadius: M.tabUnsavedDotPx / 2,
        backgroundColor: theme.colors.text.secondary,
    },
    favicon: {
        width: M.tabGlyphPx,
        height: M.tabGlyphPx,
        borderRadius: 3,
    },
    bar: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.stripGapPx,
    },
    /** The scrolling part of the bar: as wide as its tabs, never wider than the room it has. */
    barViewport: {
        flexShrink: 1,
        minWidth: 0,
        marginVertical: -BAR_SCROLL_BLEED_PX,
    },
    barScroll: {
        flexGrow: 0,
        flexShrink: 1,
    },
    barContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.stripGapPx,
        // Room inside the clip for a tab's focus ring and, at either end, the insertion mark
        // (DnD lab C2), so the strip never reflows when a carry starts.
        paddingVertical: BAR_SCROLL_BLEED_PX,
        paddingHorizontal: B.stripGapPx,
        // Tabs shrink to fit the visible strip before it scrolls (web resolves this against the
        // scroller's own width).
        maxWidth: '100%',
    },
    barFrame: {
        flexShrink: 1,
        minWidth: B.tabMinWidthPx,
        maxWidth: B.tabMaxWidthPx,
    },
    /** The open tab keeps its whole name while its neighbours shrink. */
    barFrameOpen: {
        flexShrink: 0,
    },
    barTab: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: B.tabRadiusPx,
        // Tabs shrink toward their minimum only when crowded; the consumer moves the rest behind
        // "+N" before that, so a short title keeps its natural width (workspace lab V).
        minWidth: 0,
        maxWidth: B.tabMaxWidthPx,
        flexShrink: 1,
    },
    barTabPinned: {
        minWidth: 0,
        flexShrink: 0,
    },
    barTabOpen: {
        flexShrink: 0,
    },
    // Hover takes the strip's own control hover (the same fill as the back/forward buttons beside
    // them). The open tab is a soft ink fill one step above it, with no edge or lift (calm-shell
    // `cstabs.T1`); in a pane that is not focused it takes half that fill and secondary ink, so focus
    // between split panes still reads ("that is the whole focus indicator", workspace lab T).
    barTabHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    barTabOpenUnfocused: {
        backgroundColor: theme.colors.surface.selectedUnfocused,
    },
    barTabOpenFocused: {
        backgroundColor: theme.colors.surface.selectedFocused,
    },
    entityTab: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** A pinned mark keeps its whole box: its drag wrapper must not be crushed under a crowded strip. */
    entityTabFixed: {
        flexShrink: 0,
    },
    /** The carried item lands before this tab: a mark in the gap, so no tab moves under the pointer. */
    entityTabInsertion: {
        position: 'absolute',
        top: 4,
        bottom: 4,
        width: 2,
        flexDirection: 'row',
    },
    /** The tab an already-open item goes to (lab C2s "Already open somewhere"). */
    barTabGoToRing: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        borderRadius: B.tabRadiusPx,
        borderWidth: 2,
        borderColor: theme.colors.state.active.foreground,
    },
    barTabPress: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.tabGapPx,
        paddingLeft: B.tabPaddingStartPx,
    },
    barTabPressPinned: {
        paddingLeft: 0,
        justifyContent: 'center',
    },
    barGlyph: {
        width: B.glyphBoxPx,
        height: B.glyphBoxPx,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    /** Pinned tabs (marks alone) lead; a short hairline separates them from the rest. */
    barPinSeparator: {
        width: StyleSheet.hairlineWidth,
        height: 16,
        marginHorizontal: theme.space.s4,
        backgroundColor: theme.colors.border.strong,
        flexShrink: 0,
    },
    barTrailing: {
        paddingRight: B.tabPaddingEndPx,
        paddingLeft: theme.space.s2,
    },
    railViewport: {
        position: 'relative',
    },
    railContent: {
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s12,
        paddingVertical: RAIL_TAB_REACH_PX,
    },
    railTab: {
        borderRadius: B.tabHeightPx / 2,
        borderColor: theme.colors.border.default,
        minWidth: RAIL_TOUCH_PX,
        maxWidth: 168,
        flexShrink: 0,
    },
    railTabOpen: {
        borderColor: 'transparent',
        backgroundColor: theme.colors.surface.selected,
    },
    railCount: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    tabLabelUnavailable: {
        color: theme.colors.text.tertiary,
    },
    barTrailingSlot: {
        width: B.trailingSlotPx,
        height: B.trailingSlotPx,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pinnedStatus: {
        position: 'absolute',
        right: -2,
        bottom: -1,
    },
}));


type DocumentTabRowProps<T extends DocumentTabItem> = Readonly<{
    tab: T;
    first: boolean;
    active: boolean;
    unsaved: boolean;
    faviconUrl: string | null;
    mark: React.ReactNode;
    isLoading: boolean;
    statusTone: DocumentTabStatus['tone'] | null;
    statusLabel: string;
    tabTestID?: string;
    pinTestID?: string;
    unpinTestID?: string;
    closeTestID?: string;
    faviconTestID?: string;
    spinnerTestID?: string;
    unsavedTestID?: string;
    statusTestID?: string;
    tabNativeID: string;
    panelNativeID?: string;
    renderLeadingIcon: DocumentTabStripProps<T>['renderLeadingIcon'];
    wrapTab: DocumentTabStripProps<T>['wrapTab'];
    onActivate: (key: string) => void;
    onPin: (key: string) => void;
    onUnpin: (key: string) => void;
    onClose: (key: string) => void;
    onTabMenu: DocumentTabStripProps<T>['onTabMenu'];
    onDismissTabMenu: DocumentTabStripProps<T>['onDismissTabMenu'];
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentKey: string) => void;
    registerFocusTarget: (key: string, target: { focus?: () => void } | null) => void;
    entitySource: DocumentTabEntityDragSource | undefined;
    entityDrop: DocumentTabEntityDragDrop | undefined;
    dragEnabled: boolean;
}>;

const subscribeStaticTabTitle = () => () => {};

function useDocumentTabItem<T extends DocumentTabItem>(tab: T): T {
    const readStaticTitle = React.useCallback(() => tab.title, [tab.title]);
    const read = tab.titleSource?.getSnapshot ?? readStaticTitle;
    const title = React.useSyncExternalStore(tab.titleSource?.subscribe ?? subscribeStaticTabTitle, read, read) ?? tab.title;
    return title === tab.title ? tab : { ...tab, title };
}

/**
 * Registrations already own current callbacks. Keep their binding identity tied
 * to the same runtime and exact Home/Account, not to inline event closures.
 */
function useDocumentTabEntityBindings(source: DocumentTabEntityDragSource | undefined, drop: DocumentTabEntityDragDrop | undefined) {
    const current = React.useRef({ source, drop });
    current.current = { source, drop };
    const runtime = source?.runtime;
    const id = source?.id;
    const serverId = source?.scope.serverId;
    const accountId = source?.scope.accountId;
    const nativeDragAxis = source?.nativeDragAxis;
    const hasDrop = drop !== undefined;
    return React.useMemo(() => {
        if (!runtime || id === undefined || serverId === undefined || accountId === undefined) {
            return { source: undefined, drop: undefined };
        }
        const read = () => {
            const candidate = current.current.source;
            return candidate?.runtime === runtime && candidate.id === id
                && candidate.scope.serverId === serverId && candidate.scope.accountId === accountId
                && candidate.nativeDragAxis === nativeDragAxis ? candidate : null;
        };
        const readDrop = () => {
            const candidate = current.current.drop;
            return candidate && candidate === read() ? candidate : null;
        };
        const binding: DocumentTabEntityDragSource = {
            runtime, id, scope: { serverId, accountId }, nativeDragAxis,
            getItem: key => read()?.getItem(key) ?? null,
            isCurrent: () => {
                const candidate = read();
                return candidate !== null && candidate.isCurrent?.() !== false;
            },
        };
        const dropBinding: DocumentTabEntityDragDrop | undefined = hasDrop ? {
            ...binding,
            get acceptedKinds() { return readDrop()?.acceptedKinds ?? []; },
            resolve: input => readDrop()?.resolve(input)
                ?? { status: 'refused', reason: { code: 'target-missing', message: 'target-missing' } },
            execute: async effect => readDrop()?.execute(effect)
                ?? { status: 'refused', reason: { code: 'target-missing', message: 'target-missing' } },
        } : undefined;
        return { source: dropBinding ?? binding, drop: dropBinding };
    }, [runtime, id, serverId, accountId, nativeDragAxis, hasDrop]);
}

export function DocumentTabStrip<T extends DocumentTabItem>(props: DocumentTabStripProps<T>) {
    // Keep theme-driven container styles live as well as each row's material.
    useUnistyles();
    // Order is shared by bar projection and keyboard events, not a changing render prop on every row.
    const tabIndexes = React.useMemo(() => new Map(props.tabs.map((tab, index) => [tab.key, index])), [props.tabs]);
    const bindings = useDocumentTabEntityBindings(props.entityDragDrop ?? props.entityDragSource, props.entityDragDrop);
    const refreshDropMeasurements = React.useCallback(() => {
        void props.entityDragDrop?.runtime.refreshMeasurements();
    }, [props.entityDragDrop?.runtime]);
    const tabFocusTargetsRef = React.useRef(new Map<string, { focus?: () => void }>());
    // A tab the bar has not mounted yet (Home/End across a long strip) takes focus as it mounts.
    const pendingFocusKeyRef = React.useRef<string | null>(null);
    const registerFocusTarget = React.useCallback((key: string, target: { focus?: () => void } | null) => {
        if (target) {
            tabFocusTargetsRef.current.set(key, target);
            if (pendingFocusKeyRef.current === key) {
                pendingFocusKeyRef.current = null;
                target.focus?.();
            }
        } else tabFocusTargetsRef.current.delete(key);
    }, []);
    const onActivate = useEventCallback(props.onActivate);
    const onPin = useEventCallback(props.onPin);
    const onUnpin = useEventCallback(props.onUnpin);
    const onClose = useEventCallback(props.onClose);
    const onTabMenu = useEventCallback((key: string, event: unknown) => props.onTabMenu?.(key, event));
    const onDismissTabMenu = useEventCallback((key: string) => props.onDismissTabMenu?.(key));
    const handleKeyDown = useEventCallback((event: React.KeyboardEvent<HTMLElement>, currentKey: string) => {
        const currentIndex = tabIndexes.get(currentKey);
        if (currentIndex === undefined) return;
        const nextIndex = resolveHappierTabKeySelection({
            tabs: props.tabs, key: event.key, currentIndex, rtl: I18nManager.isRTL,
        });
        if (nextIndex === null) return;
        event.preventDefault();
        const nextTab = props.tabs[nextIndex];
        if (!nextTab) return;
        props.onActivate(nextTab.key);
        if (nextIndex === currentIndex) return;
        const nextTarget = tabFocusTargetsRef.current.get(nextTab.key);
        if (nextTarget) nextTarget.focus?.();
        else pendingFocusKeyRef.current = nextTab.key;
    });
    // Project render facts here; event-only closures never invalidate every row.
    // Icon/wrapper renderers remain real visual inputs rather than latest refs.
    const rowProps = (tab: T, index: number): DocumentTabRowProps<T> => {
        const safeKey = toTestIdSafeValue(tab.key);
        const presentation = props.resolveTabPresentation?.(tab);
        return {
            tab, first: index === 0, active: props.activeTabKey ? tab.key === props.activeTabKey : false,
            unsaved: props.unsavedTabKeys?.has(tab.key) === true,
            faviconUrl: presentation?.faviconUrl ?? null, mark: presentation?.mark ?? null, isLoading: presentation?.isLoading === true,
            statusTone: presentation?.status?.tone ?? null, statusLabel: presentation?.status?.label ?? '',
            tabTestID: props.testIds?.tab?.(safeKey) ?? undefined,
            pinTestID: props.testIds?.tabPin?.(safeKey) ?? undefined,
            unpinTestID: props.testIds?.tabUnpin?.(safeKey) ?? undefined,
            closeTestID: props.testIds?.tabClose?.(safeKey) ?? undefined,
            faviconTestID: props.testIds?.tabFavicon?.(safeKey) ?? undefined,
            spinnerTestID: props.testIds?.tabSpinner?.(safeKey) ?? undefined,
            unsavedTestID: props.testIds?.tabUnsaved?.(safeKey) ?? undefined,
            statusTestID: props.testIds?.tabStatus?.(safeKey) ?? undefined,
            tabNativeID: props.tabNativeId(tab.key), panelNativeID: props.panelNativeId?.(tab.key),
            renderLeadingIcon: props.renderLeadingIcon, wrapTab: props.wrapTab,
            onActivate, onPin, onUnpin, onClose,
            onTabMenu: props.onTabMenu ? onTabMenu : undefined,
            onDismissTabMenu: props.onDismissTabMenu ? onDismissTabMenu : undefined,
            onKeyDown: handleKeyDown, registerFocusTarget,
            entitySource: bindings.source, entityDrop: bindings.drop,
            dragEnabled: bindings.source?.isCurrent?.() !== false && bindings.source?.getItem(tab.key) != null,
        };
    };
    if (props.variant === 'rail') return <DocumentRail strip={props} rowProps={rowProps} />;
    if (props.variant === 'bar') return <DocumentBar strip={props} rowProps={rowProps} tabIndexes={tabIndexes} />;
    return (
        <ScrollView horizontal style={stylesheet.tabsScroll} contentContainerStyle={stylesheet.tabsContent}
            showsHorizontalScrollIndicator={false} accessibilityRole="tablist" role={Platform.OS === 'web' ? 'presentation' : undefined}
            accessibilityLabel={Platform.OS === 'web' ? undefined : props.accessibilityLabel}
            onLayout={refreshDropMeasurements} onScroll={refreshDropMeasurements}>
            <DocumentTabAccessibilityList label={props.accessibilityLabel} tabIds={props.tabs.map(tab => props.tabNativeId(tab.key))} />
            {props.tabs.map((tab, index) => <DocumentDetailsTab key={tab.key} {...rowProps(tab, index)} />)}
        </ScrollView>
    );
}

/** Close and Pin are separate controls, so only the tabs belong to the web tablist. */
function DocumentTabAccessibilityList(props: Readonly<{ label: string; tabIds: readonly string[] }>) {
    return Platform.OS === 'web' ? <View role="tablist" accessibilityLabel={props.label}
        aria-owns={props.tabIds.join(' ')} pointerEvents="none" style={{ position: 'absolute', inset: 0 }} /> : null;
}

/**
 * The Details tab's pin and close sit flush after the tab's own press area and after each other (gap 0), and
 * the close ends at the tab's end padding. A control reaches nothing into a facing neighbour, so a finger
 * on one never lands on the other or on the tab.
 */
const DETAILS_TAB_PIN_EDGES_PX = { leading: 0, trailing: 0 } as const;
const DETAILS_TAB_CLOSE_EDGES_PX = { leading: 0, trailing: M.tabPaddingEndPx } as const;

function DocumentDetailsTabRow<T extends DocumentTabItem>(props: DocumentTabRowProps<T>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const styles = { ...stylesheet, tabActive: [stylesheet.tabActive, { backgroundColor: materialColor(theme.colors.surface.elevated) }] };
    const tab = useDocumentTabItem(props.tab);
    const { active: isActive, unsaved: isUnsaved } = props;
    // The tab keeps its designed height under every pointer; a finger reaches past it through the hit area.
    const tabHitArea = useHappierHitArea({ restingStyle: () => stylesheet.tabContent, hitReach: { left: 0, right: 0 } });
    const presentation = { isLoading: props.isLoading, faviconUrl: props.faviconUrl, mark: props.mark,
        status: props.statusTone ? { tone: props.statusTone, label: props.statusLabel } : null };
    const content = (
        <View
            key={tab.key}
            style={[styles.tab, isActive ? styles.tabActive : null]}
        >
            <DocumentTabWebPressable
                ref={(target) => props.registerFocusTarget(tab.key, target)}
                onPress={() => props.onActivate(tab.key)}
                onAuxClick={Platform.OS === 'web' ? (event) => closeTabOnMiddleClick(event, tab.key, props.onClose) : undefined}
                onKeyDown={Platform.OS === 'web'
                    ? (event) => props.onKeyDown(event, tab.key)
                    : undefined}
                testID={props.tabTestID}
                hitSlop={tabHitArea.hitSlop}
                onLayout={tabHitArea.onLayout}
                style={styles.tabContent}
                accessibilityRole="tab"
                accessibilityLabel={presentation?.status
                    ? `${t('session.detailsPanel.openTabA11y', { title: tab.title })}, ${presentation.status.label}`
                    : t('session.detailsPanel.openTabA11y', { title: tab.title })}
                accessibilityState={{ selected: isActive }}
                aria-selected={isActive}
                nativeID={props.tabNativeID}
                aria-controls={props.panelNativeID}
                tabIndex={isActive ? 0 : -1}
            >
                {tabHitArea.frame}
                {presentation?.isLoading ? (
                    <ActivitySpinner
                        size={M.tabGlyphPx - 3}
                        color={theme.colors.text.secondary}
                        testID={props.spinnerTestID}
                    />
                ) : presentation?.faviconUrl ? (
                    <Image
                        source={{ uri: presentation.faviconUrl }}
                        style={styles.favicon}
                        testID={props.faviconTestID}
                    />
                ) : presentation?.mark ?? props.renderLeadingIcon(tab, isActive)}
                <View style={styles.tabCopy}>
                    <Text
                        style={[
                            styles.tabLabel,
                            isActive ? styles.tabLabelActive : null,
                            tab.isPreview ? styles.tabLabelPreview : null,
                        ]}
                        numberOfLines={1}
                    >
                        {tab.title}
                    </Text>
                    {typeof tab.subtitle === 'string' && tab.subtitle.trim().length > 0 ? (
                        <Text style={styles.tabSubtitle} numberOfLines={1}>
                            {tab.subtitle}
                        </Text>
                    ) : null}
                </View>
            </DocumentTabWebPressable>
            <View style={styles.tabActions}>
                {presentation?.status && (tab.isPinned || !isActive) ? (
                    <DocumentTabStatusMark
                        status={presentation.status}
                        compact={tab.isPinned}
                        testID={props.statusTestID}
                        spinnerTestID={props.spinnerTestID}
                    />
                ) : null}
                {tab.isPreview || tab.canPin ? (
                    <IconButton
                        onPress={(event: unknown) => {
                            if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                (event as ScrollPropagationEvent).stopPropagation?.();
                            }
                            props.onPin(tab.key);
                        }}
                        testID={props.pinTestID}
                        accessibilityLabel={`${t('session.detailsPanel.pinTabA11y')}: ${tab.title}`}
                        tooltip={`${t('session.detailsPanel.pinTabA11y')}: ${tab.title}`}
                        variant="plain"
                        size={M.tabActionTargetPx}
                        interactiveTargetEdgesPx={DETAILS_TAB_PIN_EDGES_PX}
                        iconSize={12}
                        icon={<PinIcon size={12} color={theme.colors.text.tertiary} />}
                    />
                ) : tab.isPinned ? (
                    <IconButton
                        onPress={(event: unknown) => {
                            if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                (event as ScrollPropagationEvent).stopPropagation?.();
                            }
                            props.onUnpin(tab.key);
                        }}
                        testID={props.unpinTestID}
                        accessibilityLabel={`${t('session.detailsPanel.unpinTabA11y')}: ${tab.title}`}
                        tooltip={`${t('session.detailsPanel.unpinTabA11y')}: ${tab.title}`}
                        variant="plain"
                        size={M.tabActionTargetPx}
                        interactiveTargetEdgesPx={DETAILS_TAB_PIN_EDGES_PX}
                        iconSize={12}
                        icon={<PinIcon size={12} color={theme.colors.text.secondary} />}
                    />
                ) : null}
                <IconButton
                    onPress={(event: unknown) => {
                        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                            (event as ScrollPropagationEvent).stopPropagation?.();
                        }
                        props.onClose(tab.key);
                    }}
                    testID={props.closeTestID}
                    accessibilityLabel={`${isUnsaved
                        ? t('detailsSurface.chrome.closeUnsavedTabA11y')
                        : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`}
                    tooltip={`${isUnsaved
                        ? t('detailsSurface.chrome.closeUnsavedTabA11y')
                        : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`}
                    variant="plain"
                    size={M.tabActionTargetPx}
                    interactiveTargetEdgesPx={DETAILS_TAB_CLOSE_EDGES_PX}
                    iconSize={M.tabCloseGlyphPx}
                    icon={isUnsaved ? (
                        <View
                            testID={props.unsavedTestID}
                            style={styles.unsavedDot}
                        />
                    ) : (
                        <Icon name="x" size={M.tabCloseGlyphPx} color={theme.colors.text.tertiary} />
                    )}
                />
            </View>
        </View>
    );
    const wrapped = props.wrapTab ? props.wrapTab(tab, content) : content;
    return props.entitySource
        ? <DocumentEntityTab tab={tab} binding={props.entitySource} dropBinding={props.entityDrop}
            enabled={props.dragEnabled} gapPx={M.tabGapPx} first={props.first}>{wrapped}</DocumentEntityTab>
        : wrapped;
}
const DocumentDetailsTab = React.memo(DocumentDetailsTabRow) as typeof DocumentDetailsTabRow;

/**
 * Keeps the open tab in view in a strip that scrolls sideways: when it changes (a tab opened from
 * elsewhere, chosen from the tab list, a preview replaced) and when the strip is first measured,
 * without animating on arrival.
 */
function useRevealedActiveTab(activeTabKey: string | null) {
    const scrollRef = React.useRef<ScrollView | null>(null);
    const frames = React.useRef(new Map<string, { x: number; width: number }>());
    const frameNodes = React.useRef(new Map<string, unknown>());
    const viewport = React.useRef({ x: 0, width: 0 });
    // The web reports a layout only when a size changes, so a tab pushed along by its neighbours
    // keeps a stale position; read the live DOM there and the measured layout elsewhere.
    const readViewport = React.useCallback(() => {
        const node = (scrollRef.current as { getScrollableNode?: () => unknown } | null)?.getScrollableNode?.() as
            { scrollLeft?: unknown; clientWidth?: unknown } | null | undefined;
        return typeof node?.scrollLeft === 'number' && typeof node.clientWidth === 'number' && node.clientWidth > 0
            ? { x: node.scrollLeft, width: node.clientWidth } : viewport.current;
    }, []);
    const readFrame = React.useCallback((key: string) => {
        const node = frameNodes.current.get(key) as { offsetLeft?: unknown; offsetWidth?: unknown } | undefined;
        return typeof node?.offsetLeft === 'number' && typeof node.offsetWidth === 'number' && node.offsetWidth > 0
            ? { x: node.offsetLeft, width: node.offsetWidth } : frames.current.get(key);
    }, []);
    const reveal = React.useCallback((key: string | null, animated: boolean) => {
        const frame = key ? readFrame(key) : undefined;
        const { x, width } = readViewport();
        if (!frame || width === 0) return;
        if (frame.x < x + 12) scrollRef.current?.scrollTo({ x: Math.max(0, frame.x - 12), animated });
        else if (frame.x + frame.width > x + width - 12) scrollRef.current?.scrollTo({ x: frame.x + frame.width - width + 12, animated });
    }, [readFrame, readViewport]);
    const registerFrameNode = React.useCallback((key: string, node: unknown) => {
        if (node) frameNodes.current.set(key, node);
        else frameNodes.current.delete(key);
    }, []);
    React.useEffect(() => { reveal(activeTabKey, false); }, [reveal, activeTabKey]);
    return { scrollRef, frames, viewport, reveal, readViewport, registerFrameNode };
}

/**
 * The bar's scroller, for the tabs inside it: a tab scrolled out of view is not a destination (its
 * box still lies beyond the clip, over whatever is drawn there), and a carry near either end scrolls
 * the strip.
 */
type DocumentBarScroll = Readonly<{
    containsPointer: (pointer: Readonly<{ x: number; y: number }>) => boolean;
    autoscroll: (pointer: Readonly<{ x: number; y: number }>) => void;
    /** Native: re-read the visible strip's window frame with the tabs' own measurement. */
    measure: () => Promise<void>;
}>;
const DocumentBarScrollContext = React.createContext<DocumentBarScroll | null>(null);

type WheelLikeEvent = Readonly<{ deltaX?: number; deltaY?: number; nativeEvent?: Readonly<{ deltaX?: number; deltaY?: number }> }>;

/** One tab's slot in a crowded strip: every tab sits at its minimum width then, plus the gap. */
const BAR_TAB_PITCH_PX = B.tabMinWidthPx + B.stripGapPx;
/** Tabs kept mounted beyond each edge of the viewport, so a scroll never shows an empty slot. */
const BAR_WINDOW_OVERSCAN_TABS = 6;
/** Before the strip is measured: enough to fill any ordinary width, never the whole restored set. */
export const DOCUMENT_BAR_INITIAL_WINDOW_TABS = 24;

/** The tab being carried from this strip: its source must stay registered while the strip autoscrolls. */
function useCarriedTabKey(source: DocumentTabEntityDragSource | undefined): string | null {
    const runtime = source?.runtime;
    const bindingId = source?.id;
    const read = React.useCallback(() => {
        const snapshot = runtime?.getSnapshot();
        if (!snapshot || snapshot.phase !== 'carrying' || !snapshot.sourceId) return null;
        try {
            const parsed: unknown = JSON.parse(snapshot.sourceId);
            return Array.isArray(parsed) && parsed[0] === 'document-tab' && parsed[1] === bindingId
                && typeof parsed[2] === 'string' ? parsed[2] : null;
        } catch { return null; }
    }, [runtime, bindingId]);
    return React.useSyncExternalStore(runtime?.subscribe ?? subscribeStaticTabTitle, read, () => null);
}

/**
 * The workspace bar (workspace lab T): pinned tabs stay at the leading edge as their marks; every
 * other tab sits in one strip that scrolls sideways. Tabs keep their natural width while they fit,
 * shrink toward their minimum when crowded, and only then scroll. A soft fade marks an edge with
 * more beyond it; a mouse wheel scrolls the strip sideways.
 */
function DocumentBar<T extends DocumentTabItem>(props: Readonly<{
    strip: DocumentTabStripProps<T>;
    rowProps: (tab: T, index: number) => DocumentTabRowProps<T>;
    tabIndexes: ReadonlyMap<string, number>;
}>) {
    const styles = stylesheet;
    const { strip } = props;
    const { theme } = useUnistyles();
    const { scrollRef, frames, viewport, reveal, readViewport, registerFrameNode } = useRevealedActiveTab(strip.activeTabKey);
    const fades = useScrollEdgeFades({ enabledEdges: { left: true, right: true }, overflowThreshold: 2, edgeThreshold: 2 });
    const viewportHost = React.useRef<unknown>(null);
    const viewportBounds = React.useRef<WindowBounds | null>(null);
    const heightPx = strip.barTabHeightPx ?? B.tabHeightPx;
    const pinned = strip.tabs.filter(tab => tab.isPinned);
    const unpinned = strip.tabs.filter(tab => !tab.isPinned);
    const refresh = strip.entityDragDrop?.runtime;
    // A strip that scrolls holds every tab at its minimum width, so a tab's place along it is its index:
    // only the tabs near the viewport mount, and one spacer stands for each run left out.
    const [windowRange, setWindowRange] = React.useState({ first: 0, last: DOCUMENT_BAR_INITIAL_WINDOW_TABS });
    const syncWindow = React.useCallback((x: number, width: number) => {
        const first = Math.max(0, Math.floor(x / BAR_TAB_PITCH_PX) - BAR_WINDOW_OVERSCAN_TABS);
        const last = Math.ceil((x + width) / BAR_TAB_PITCH_PX) + BAR_WINDOW_OVERSCAN_TABS;
        setWindowRange(current => current.first === first && current.last === last ? current : { first, last });
    }, []);
    const contentWidth = React.useRef(0);
    const carriedTabKey = useCarriedTabKey(strip.entityDragDrop ?? strip.entityDragSource);
    const openTabAt = unpinned.findIndex(tab => tab.key === strip.activeTabKey);
    const measureViewport = React.useCallback(async () => {
        const node = viewportHost.current;
        const bounds = await measureWindowBounds(node);
        if (viewportHost.current === node) viewportBounds.current = bounds;
    }, []);
    const autoscroll = React.useCallback((pointer: Readonly<{ x: number; y: number }>) => {
        const bounds = readWindowBounds(viewportHost.current) ?? viewportBounds.current;
        if (!bounds) return;
        const content = Array.from(frames.current.values()).reduce((end, frame) => Math.max(end, frame.x + frame.width), contentWidth.current);
        const next = resolveTreeDropAutoscrollTarget({ pointerY: pointer.x, viewportTopY: bounds.x,
            viewportHeight: bounds.width, scrollOffsetY: readViewport().x, contentHeight: content });
        if (next !== readViewport().x) scrollRef.current?.scrollTo({ x: next, animated: false });
    }, [frames, readViewport, scrollRef]);
    const containsPointer = React.useCallback((pointer: Readonly<{ x: number; y: number }>) => {
        const bounds = readWindowBounds(viewportHost.current) ?? viewportBounds.current;
        return !bounds || (pointer.x >= bounds.x && pointer.x <= bounds.x + bounds.width);
    }, []);
    const scrollBinding = React.useMemo(() => ({ containsPointer, autoscroll, measure: measureViewport }), [autoscroll, containsPointer, measureViewport]);
    const tabProps = (tab: T) => {
        const index = props.tabIndexes.get(tab.key)!;
        const row = props.rowProps(tab, index);
        return { ...row, emphasis: row.active ? strip.activeEmphasis ?? 'focused' : 'unfocused',
            heightPx,
            dropRing: strip.dropRingTabKey === tab.key,
            endMark: strip.dropSlot === true && index === strip.tabs.length - 1 } as const;
    };
    const onWheel = React.useCallback((event: WheelLikeEvent) => {
        const deltaX = event.deltaX ?? event.nativeEvent?.deltaX ?? 0;
        const deltaY = event.deltaY ?? event.nativeEvent?.deltaY ?? 0;
        // A trackpad already scrolls sideways; a vertical wheel turns into sideways movement here.
        if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
        scrollRef.current?.scrollTo({ x: Math.max(0, readViewport().x + deltaY), animated: false });
    }, [readViewport, scrollRef]);
    const barChildren: React.ReactNode[] = [];
    const mountedTabIds = pinned.map(tab => strip.tabNativeId(tab.key));
    let leftOut = 0;
    const flushLeftOut = (before: number) => {
        if (leftOut === 0) return;
        barChildren.push(<View key={`left-out-${before - leftOut}`}
            style={{ width: leftOut * B.tabMinWidthPx + (leftOut - 1) * B.stripGapPx, flexShrink: 0 }} />);
        leftOut = 0;
    };
    unpinned.forEach((tab, index) => {
        const mounted = (index >= windowRange.first && index <= windowRange.last)
            || tab.key === strip.activeTabKey || tab.key === strip.dropRingTabKey || tab.key === carriedTabKey
            || (openTabAt >= 0 && Math.abs(index - openTabAt) <= 1);
        if (!mounted) { leftOut += 1; return; }
        mountedTabIds.push(strip.tabNativeId(tab.key));
        flushLeftOut(index);
        barChildren.push(
            <View key={tab.key} testID={`document-tab-frame-${toTestIdSafeValue(tab.key)}`}
                ref={(node) => registerFrameNode(tab.key, node)}
                style={[styles.barFrame, tab.key === strip.activeTabKey ? styles.barFrameOpen : null]}
                onLayout={(event) => {
                    const { x, width } = event.nativeEvent.layout;
                    frames.current.set(tab.key, { x, width });
                    if (tab.key === strip.activeTabKey) reveal(tab.key, false);
                }}>
                <DocumentBarTab {...tabProps(tab)} />
            </View>,
        );
    });
    flushLeftOut(unpinned.length);
    return (
        <View style={styles.bar} accessibilityRole="tablist" role={Platform.OS === 'web' ? 'presentation' : undefined}
            accessibilityLabel={Platform.OS === 'web' ? undefined : strip.accessibilityLabel}
            onLayout={() => { void refresh?.refreshMeasurements(); }}>
            <DocumentTabAccessibilityList label={strip.accessibilityLabel} tabIds={mountedTabIds} />
            {pinned.map(tab => <DocumentBarTab key={tab.key} {...tabProps(tab)} />)}
            {pinned.length > 0 && unpinned.length > 0 ? <View style={styles.barPinSeparator} /> : null}
            <View ref={(node) => { viewportHost.current = node; }} testID="document-tab-viewport" style={styles.barViewport} onLayout={() => { void measureViewport(); }}>
                <DocumentBarScrollContext.Provider value={scrollBinding}>
                    <ScrollView
                        ref={scrollRef}
                        horizontal
                        style={[styles.barScroll, { height: heightPx + 2 * BAR_SCROLL_BLEED_PX }]}
                        contentContainerStyle={[styles.barContent, {
                            minWidth: unpinned.length * (B.tabMinWidthPx + B.stripGapPx) + B.stripGapPx,
                        }]}
                        showsHorizontalScrollIndicator={false}
                        scrollEventThrottle={32}
                        onLayout={(event) => {
                            viewport.current = { ...viewport.current, width: event.nativeEvent.layout.width };
                            fades.onViewportLayout(event);
                            syncWindow(viewport.current.x, viewport.current.width);
                            reveal(strip.activeTabKey, false);
                            void measureViewport();
                            void refresh?.refreshMeasurements();
                        }}
                        onContentSizeChange={(width, height) => {
                            contentWidth.current = width;
                            fades.onContentSizeChange(width, height);
                            // A tab that just opened at the end widens the strip after its own layout.
                            reveal(strip.activeTabKey, false);
                        }}
                        onScroll={(event) => {
                            viewport.current = { ...viewport.current, x: event.nativeEvent.contentOffset.x };
                            fades.onScroll(event);
                            syncWindow(viewport.current.x, viewport.current.width);
                            void refresh?.refreshMeasurements();
                        }}
                        {...(Platform.OS === 'web' ? { onWheel } : null)}
                    >
                        {barChildren}
                    </ScrollView>
                </DocumentBarScrollContext.Provider>
                <ScrollEdgeFades color={strip.barFadeColor ?? theme.colors.background.canvas} size={20} edges={fades.visibility} />
            </View>
        </View>
    );
}

/** The rail's scrolled-edge fade: the bar's 20. */
const RAIL_EDGE_FADE_PX = 20;
const RAIL_TAB_HIT_REACH = Object.freeze({ top: RAIL_TAB_REACH_PX, bottom: RAIL_TAB_REACH_PX, left: 0, right: 0 });

/**
 * The phone's open-tabs rail: the bar's tabs as scrolling pills. The open tab is kept in view when it
 * changes (a tab opened from elsewhere, a preview replaced), without animating on arrival.
 */
function DocumentRail<T extends DocumentTabItem>(props: Readonly<{
    strip: DocumentTabStripProps<T>;
    rowProps: (tab: T, index: number) => DocumentTabRowProps<T>;
}>) {
    const styles = stylesheet;
    const { strip } = props;
    const { theme } = useUnistyles();
    const { scrollRef, frames, viewport, reveal, registerFrameNode } = useRevealedActiveTab(strip.activeTabKey);
    // A scrolled edge fades out, as the bar's does, instead of cutting a pill hard at the screen edge.
    const fades = useScrollEdgeFades({ enabledEdges: { left: true, right: true }, overflowThreshold: 2, edgeThreshold: 2 });
    const webEdgeMask = React.useMemo(() => (Platform.OS === 'web'
        ? resolveHorizontalScrollEdgeMaskStyle(fades.visibility, { fadeSize: RAIL_EDGE_FADE_PX }) : null), [fades.visibility]);
    return (
        <View style={styles.railViewport}>
        <ScrollView
            ref={scrollRef}
            horizontal
            // Web fades the pills themselves (the header may be translucent); native paints the header's colour.
            style={webEdgeMask}
            contentContainerStyle={styles.railContent}
            showsHorizontalScrollIndicator={false}
            onLayout={(event) => {
                viewport.current = { ...viewport.current, width: event.nativeEvent.layout.width };
                fades.onViewportLayout(event);
                reveal(strip.activeTabKey, false);
                void strip.entityDragDrop?.runtime.refreshMeasurements();
            }}
            onContentSizeChange={(width, height) => {
                fades.onContentSizeChange(width, height);
                // Tabs arriving or leaving beside the open one move it without a layout event of its own.
                reveal(strip.activeTabKey, false);
            }}
            onScroll={(event) => {
                viewport.current = { ...viewport.current, x: event.nativeEvent.contentOffset.x };
                fades.onScroll(event);
                void strip.entityDragDrop?.runtime.refreshMeasurements();
            }}
            scrollEventThrottle={32}
            accessibilityRole="tablist" role={Platform.OS === 'web' ? 'presentation' : undefined}
            accessibilityLabel={Platform.OS === 'web' ? undefined : strip.accessibilityLabel}
        >
            <DocumentTabAccessibilityList label={strip.accessibilityLabel} tabIds={strip.tabs.map(tab => strip.tabNativeId(tab.key))} />
            {strip.tabs.map((tab, tabIndex) => (
                <View key={tab.key} testID={`document-tab-frame-${toTestIdSafeValue(tab.key)}`} ref={(node) => registerFrameNode(tab.key, node)} onLayout={(event) => {
                    const { x, width } = event.nativeEvent.layout;
                    frames.current.set(tab.key, { x, width });
                    if (tab.key === strip.activeTabKey) reveal(tab.key, false);
                }}>
                    <DocumentBarTab {...props.rowProps(tab, tabIndex)} rail emphasis="unfocused"
                        heightPx={B.tabHeightPx} dropRing={false} endMark={false} />
                </View>
            ))}
            {strip.railTrailing ?? null}
        </ScrollView>
        {Platform.OS === 'web' ? null : <ScrollEdgeFades color={theme.colors.chrome.header.background} size={RAIL_EDGE_FADE_PX} edges={fades.visibility} />}
        </View>
    );
}

function stopPropagation(event: unknown) {
    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
        (event as ScrollPropagationEvent).stopPropagation?.();
    }
}

function closeTabOnMiddleClick(event: React.MouseEvent<HTMLElement>, tabKey: string, onClose: (key: string) => void) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(tabKey);
}

function documentTabSourceId(bindingId: string, tabKey: string): string {
    return JSON.stringify(['document-tab', bindingId, tabKey, 'source']);
}

/**
 * One tab of the bar variant. Its own hover state reveals close in the reserved trailing slot, so the
 * tab never changes width under the pointer (workspace lab: "hover never changes width").
 */
function DocumentBarTabRow<T extends DocumentTabItem>(props: DocumentTabRowProps<T> & Readonly<{
    emphasis: 'focused' | 'unfocused';
    heightPx: number;
    rail?: boolean;
    dropRing: boolean;
    endMark: boolean;
    onLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const selectedPaint = { backgroundColor: materialColor(theme.colors.surface.selected) };
    const styles = {
        ...stylesheet,
        barTabHovered: [stylesheet.barTabHovered, selectedPaint],
        railTabOpen: [stylesheet.railTabOpen, selectedPaint],
    };
    const [hovered, setHovered] = React.useState(false);
    // The ring is for keyboard focus and belongs on the drawn tab, at its radius, not on the hit box.
    const [focusVisible, setFocusVisible] = React.useState(false);
    const tab = useDocumentTabItem(props.tab);
    const draggedDuringPress = React.useRef(false);
    const dismissMenu = React.useRef(props.onDismissTabMenu);
    dismissMenu.current = props.onDismissTabMenu;
    const entitySource = props.entitySource;
    const runtime = entitySource?.runtime;
    const sourceId = entitySource ? documentTabSourceId(entitySource.id, tab.key) : null;
    React.useEffect(() => {
        if (!runtime || !sourceId) return;
        return runtime.subscribe(() => {
            const snapshot = runtime.getSnapshot();
            if (snapshot.sourceId === sourceId && snapshot.phase === 'carrying' && !draggedDuringPress.current) {
                // Latch until the next press: RN Web's pending long-press can fire
                // after dragend has already settled the canonical carry.
                draggedDuringPress.current = true;
                dismissMenu.current?.(tab.key);
            }
        });
    }, [runtime, sourceId, tab.key]);
    const presentation = { isLoading: props.isLoading, faviconUrl: props.faviconUrl, mark: props.mark,
        status: props.statusTone ? { tone: props.statusTone, label: props.statusLabel } : null };
    const pinned = tab.isPinned;
    const status = presentation?.status ?? null;
    const showClose = !pinned && ((hovered && !props.rail) || props.active || (!status && props.unsaved));
    const openMenu = props.onTabMenu
        ? (event: unknown) => {
            (event as { preventDefault?: () => void } | null)?.preventDefault?.();
            props.onTabMenu?.(tab.key, event);
        }
        : undefined;
    const closeLabel = `${props.unsaved
        ? t('detailsSurface.chrome.closeUnsavedTabA11y')
        : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`;
    // The tab keeps its designed height under every pointer. The tabs sit flush and the scroll viewport
    // that holds them is exactly one tab tall, which clips any reach past it: the hit area is the tab.
    // The rail's viewport keeps a finger's room above and below its pills, so a rail tab reaches into it.
    const tabHitArea = useHappierHitArea({
        restingStyle: () => [stylesheet.barTabPress, { height: props.heightPx }],
        hitReach: props.rail ? RAIL_TAB_HIT_REACH : 0,
    });
    const content = (
        <View
            onLayout={props.onLayout}
            style={[
                styles.barTab,
                { height: props.heightPx },
                pinned ? [styles.barTabPinned, { width: props.rail ? RAIL_TOUCH_PX : props.heightPx }] : null,
                props.active ? styles.barTabOpen : null,
                hovered && !props.active ? styles.barTabHovered : null,
                // Hover paints in and out on the hover curve; selecting a tab fills it at once.
                !props.active ? BAR_TAB_HOVER_PAINT : null,
                props.active && !props.rail ? (props.emphasis === 'focused' ? styles.barTabOpenFocused : styles.barTabOpenUnfocused) : null,
                props.rail ? [styles.railTab, props.active ? styles.railTabOpen : null] : null,
                happierFocusRingStyle({ visible: focusVisible, color: theme.colors.border.focus }),
            ]}
            {...(Platform.OS === 'web' ? {
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            } : null)}
        >
            <DocumentTabWebPressable
                ref={(target) => props.registerFocusTarget(tab.key, target as { focus?: () => void } | null)}
                onPress={() => props.onActivate(tab.key)}
                onAuxClick={Platform.OS === 'web' ? (event) => closeTabOnMiddleClick(event, tab.key, props.onClose) : undefined}
                onPressIn={() => { draggedDuringPress.current = false; }}
                onFocus={(event) => setFocusVisible(isHappierFocusVisible(event?.target))}
                onBlur={() => setFocusVisible(false)}
                onLongPress={openMenu ? (event) => { if (!draggedDuringPress.current) openMenu(event); } : undefined}
                hitSlop={tabHitArea.hitSlop}
                onLayout={tabHitArea.onLayout}
                {...(Platform.OS === 'web' && openMenu ? { onContextMenu: openMenu } : null)}
                onKeyDown={Platform.OS === 'web'
                    ? (event) => props.onKeyDown(event, tab.key)
                    : undefined}
                testID={props.tabTestID}
                style={[styles.barTabPress, pinned ? styles.barTabPressPinned : null, { height: props.heightPx }, HAPPIER_FOCUS_RING_DELEGATED_STYLE]}
                accessibilityRole="tab"
                accessibilityLabel={status
                    ? `${t('session.detailsPanel.openTabA11y', { title: tab.title })}, ${status.label}`
                    : t('session.detailsPanel.openTabA11y', { title: tab.title })}
                accessibilityState={{ selected: props.active }}
                aria-selected={props.active}
                nativeID={props.tabNativeID}
                aria-controls={props.panelNativeID}
                tabIndex={props.active ? 0 : -1}
            >
                {tabHitArea.frame}
                <View style={styles.barGlyph}>
                    {presentation?.isLoading ? (
                        <ActivitySpinner
                            size={M.tabGlyphPx - 3}
                            color={theme.colors.text.secondary}
                            testID={props.spinnerTestID}
                        />
                    ) : presentation?.faviconUrl ? (
                        <Image
                            source={{ uri: presentation.faviconUrl }}
                            style={styles.favicon}
                            testID={props.faviconTestID}
                        />
                    ) : presentation?.mark ?? props.renderLeadingIcon(tab, props.active || hovered)}
                    {pinned && status ? (
                        <View style={styles.pinnedStatus}>
                            <DocumentTabStatusMark status={status} compact testID={props.statusTestID} />
                        </View>
                    ) : null}
                </View>
                {pinned ? null : (
                    <Text
                        style={[
                            styles.tabLabel,
                            // A pane that is not focused keeps its open tab's name in secondary ink.
                            (props.active && (props.rail || props.emphasis === 'focused')) || hovered ? { color: theme.colors.text.primary } : null,
                            props.active ? styles.tabLabelActive : null,
                            tab.isPreview ? styles.tabLabelPreview : null,
                            tab.isUnavailable ? styles.tabLabelUnavailable : null,
                            { flexShrink: 1 },
                        ]}
                        numberOfLines={1}
                    >
                        {tab.title}
                    </Text>
                )}
                {props.rail && !pinned && typeof tab.subtitle === 'string' && tab.subtitle.length > 0 ? (
                    <Text style={styles.railCount}>{tab.subtitle}</Text>
                ) : null}
            </DocumentTabWebPressable>
            {pinned || (props.rail && !showClose && !status) ? null : (
                <View style={styles.barTrailing}>
                    <View style={styles.barTrailingSlot}>
                        {!showClose && status ? (
                            <DocumentTabStatusMark
                                status={status}
                                testID={props.statusTestID}
                                spinnerTestID={props.spinnerTestID}
                            />
                        ) : showClose ? (
                            <IconButton
                                onPress={(event: unknown) => {
                                    stopPropagation(event);
                                    props.onClose(tab.key);
                                }}
                                testID={props.closeTestID}
                                accessibilityLabel={closeLabel}
                                tooltip={closeLabel}
                                tooltipPlacement="bottom"
                                variant="plain"
                                size={B.trailingSlotPx}
                                // The close sits at its tab's end: the tab's own press area abuts it (no reach leading),
                                // and its hit area stays inside the tab's end padding, so the control after the strip
                                // (+ New tab) keeps its own side of the gap. Above and below it stops at the tab
                                // edge, where the scroll viewport clips.
                                interactiveTargetEdgesPx={{
                                    leading: props.rail ? RAIL_CLOSE_LEADING_REACH_PX : BAR_CLOSE_LEADING_REACH_PX,
                                    trailing: B.tabPaddingEndPx,
                                    top: (props.heightPx - B.trailingSlotPx) / 2 + (props.rail ? RAIL_TAB_REACH_PX : 0),
                                    bottom: (props.heightPx - B.trailingSlotPx) / 2 + (props.rail ? RAIL_TAB_REACH_PX : 0),
                                }}
                                iconSize={M.tabCloseGlyphPx}
                                icon={props.unsaved && !hovered ? (
                                    <View
                                        testID={props.unsavedTestID}
                                        style={styles.unsavedDot}
                                    />
                                ) : (
                                    <Icon name="x" size={M.tabCloseGlyphPx} color={theme.colors.text.tertiary} />
                                )}
                            />
                        ) : null}
                    </View>
                </View>
            )}
            {props.dropRing ? <DocumentTabGoToRing /> : null}
        </View>
    );
    return entitySource
        ? <DocumentEntityTab tab={tab} binding={entitySource} dropBinding={props.entityDrop} enabled={props.dragEnabled} gapPx={B.stripGapPx} first={props.first}
            // A rail scrolls, so every rail tab keeps its own width; a bar crushes all but its pinned marks.
            fixed={pinned || Boolean(props.rail)}
            endMark={props.endMark}>{content}</DocumentEntityTab>
        : content;
}

const DocumentBarTab = React.memo(DocumentBarTabRow) as typeof DocumentBarTabRow;

function DocumentTabStatusMark(props: Readonly<{
    status: DocumentTabStatus;
    compact?: boolean;
    testID?: string;
    spinnerTestID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.status.tone === 'working' && !props.compact) {
        return <ActivitySpinner size={10} color={theme.colors.text.tertiary} testID={props.spinnerTestID} />;
    }
    const dot = resolveDocumentTabStatusDot(theme, props.status.tone);
    return <StatusDot testID={props.testID} color={dot.color} halo={dot.halo} size={props.compact ? 4 : 6} />;
}

/** Each mounted tab supplies its current semantic anchor to the shared owner. */
function DocumentEntityTab(props: Readonly<{
    tab: DocumentTabItem;
    binding: DocumentTabEntityDragSource;
    dropBinding?: DocumentTabEntityDragDrop;
    enabled: boolean;
    /** The strip's gap: the insertion mark sits in the gap before this tab. */
    gapPx: number;
    first: boolean;
    /** The tab keeps its own width (a pinned mark) instead of shrinking with the strip. */
    fixed?: boolean;
    /**
     * A kept tab lands after this, the strip's last tab (DnD lab C2 tab slot). The same mark as a
     * gap insertion, drawn past the tab's end, so the strip never reflows while the pointer crosses
     * between the pane centre and its edges.
     */
    endMark?: boolean;
    children: React.ReactNode;
}>) {
    const { tab, binding } = props;
    const sourceId = documentTabSourceId(binding.id, tab.key);
    const host = React.useRef<unknown>(null);
    const nativeBounds = React.useRef<WindowBounds | null>(null);
    const measure = React.useCallback(async () => {
        const node = host.current;
        const next = await measureWindowBounds(node);
        if (host.current === node) nativeBounds.current = next;
    }, []);
    const bounds = React.useCallback(() => readWindowBounds(host.current) ?? nativeBounds.current, []);
    useEntityDragSource(binding.runtime, {
        id: sourceId, scope: binding.scope,
        getItem: () => binding.getItem(tab.key),
        isCurrent: () => binding.isCurrent?.() !== false && binding.getItem(tab.key) !== null,
        describe: () => ({ title: tab.title }),
        getBounds: bounds,
    });
    const enabled = props.enabled;
    const sourceRef = useEntityDragDomBinding({ runtime: binding.runtime, sourceId,
        enabled,
        describe: () => tab.title,
        canStart: (event, element) => !isSecondaryEntityRowControl(event, element),
    });
    const dropRef = useEntityDropDomBinding(props.dropBinding ? binding.runtime : undefined);
    const attach = React.useCallback((node: unknown) => {
        host.current = node;
        sourceRef(node);
        dropRef(node);
        // Styling wrappers can detach/reattach the same host during a feedback
        // commit. Registration and measured layout own refresh, not transient refs.
    }, [sourceRef, dropRef]);
    const adapter = React.useRef<ReturnType<typeof createEntityDragGestureAdapter> | null>(null);
    const gesture = React.useMemo(() => Gesture.Pan().runOnJS(true)
        .enabled(Platform.OS !== 'web' && enabled && binding.nativeDragAxis === 'vertical')
        .activeOffsetY([-ENTITY_DRAG_ACTIVATION_DISTANCE_PX, ENTITY_DRAG_ACTIVATION_DISTANCE_PX])
        .failOffsetX([-ENTITY_DRAG_ACTIVATION_DISTANCE_PX, ENTITY_DRAG_ACTIVATION_DISTANCE_PX])
        .onStart(event => {
            const carry = binding.runtime.begin(sourceId, 'pointer');
            adapter.current = carry ? createEntityDragGestureAdapter(carry) : null;
            adapter.current?.update({ x: event.absoluteX, y: event.absoluteY });
            void binding.runtime.refreshMeasurements();
        })
        .onUpdate(event => { adapter.current?.update({ x: event.absoluteX, y: event.absoluteY }); binding.runtime.autoscroll(); })
        .onEnd((event, success) => { void adapter.current?.end(success, { x: event.absoluteX, y: event.absoluteY }); })
        .onFinalize(() => adapter.current?.finalize()), [binding.runtime, sourceId, enabled, binding.nativeDragAxis]);
    React.useEffect(() => () => adapter.current?.cancel(), []);
    const content = <View ref={attach} collapsable={false} onLayout={() => {
        void measure().then(() => binding.runtime.refresh());
    }} testID={`document-tab-entity-${toTestIdSafeValue(tab.key)}`}
        style={props.fixed ? [stylesheet.entityTab, stylesheet.entityTabFixed] : stylesheet.entityTab}>
        {props.children}
        {props.dropBinding ? <DocumentEntityTabTarget tab={tab} binding={props.dropBinding} bounds={bounds} measure={measure}
            gapPx={props.gapPx} first={props.first} endMark={props.endMark} /> : null}
    </View>;
    return Platform.OS !== 'web' && binding.nativeDragAxis === 'vertical'
        ? <GestureDetector gesture={gesture}>{content}</GestureDetector> : content;
}

/** Only strips that declare a destination register its admission and subscribe to feedback. */
function DocumentEntityTabTarget(props: Readonly<{
    tab: DocumentTabItem;
    binding: DocumentTabEntityDragDrop;
    bounds: () => WindowBounds | null;
    measure: () => Promise<void>;
    gapPx: number;
    first: boolean;
    endMark?: boolean;
}>) {
    const { tab, binding } = props;
    const targetId = JSON.stringify(['document-tab', binding.id, tab.key, 'target']);
    const scroll = React.useContext(DocumentBarScrollContext);
    useEntityDropTarget(binding.runtime, {
        id: targetId, scope: binding.scope, acceptedKinds: binding.acceptedKinds,
        isCurrent: () => binding.isCurrent?.() !== false,
        getBounds: props.bounds,
        measureBounds: scroll ? async () => { await Promise.all([props.measure(), scroll.measure()]); } : props.measure,
        ...(scroll ? { autoscroll: scroll.autoscroll, containsPointer: scroll.containsPointer } : {}),
        listDestinations: () => [{ destination: { beforeTabId: tab.key }, label: tab.title }],
        resolve: ({ item, input }) => binding.resolve({ item, beforeTabId: tab.key, input }),
        execute: binding.execute,
    });
    const state = useEntityDropTargetState(binding.runtime, targetId);
    const allowed = state?.phase === 'carrying' && state.admission?.status === 'allowed';
    return <>
        {allowed ? <View pointerEvents="none" testID={`document-tab-drop-before-${toTestIdSafeValue(tab.key)}`}
            style={[stylesheet.entityTabInsertion, { left: props.first ? 0 : -(props.gapPx / 2) - 1 }]}>
            <TreeDropIndicatorLine orientation="vertical" indentPx={0}
                visual={{ kind: 'line', targetId: tab.key, edge: 'top', depth: 0 }} />
        </View> : null}
        {props.endMark ? <View pointerEvents="none" testID="document-tab-drop-slot"
            style={[stylesheet.entityTabInsertion, { right: -(props.gapPx / 2) - 1 }]}>
            <TreeDropIndicatorLine orientation="vertical" indentPx={0}
                visual={{ kind: 'line', targetId: tab.key, edge: 'bottom', depth: 0 }} />
        </View> : null}
    </>;
}

/** Rings the tab the carried item would go to. It pulses once on arrival; under reduced motion it simply appears. */
function DocumentTabGoToRing() {
    const reducedMotion = useReducedMotionPreference();
    const opacity = useSharedValue(reducedMotion ? 1 : 0);
    React.useEffect(() => {
        if (reducedMotion) { opacity.value = 1; return; }
        const { durationMs, easing } = reanimatedMotionTokens;
        opacity.value = withSequence(
            withTiming(1, { duration: durationMs.fast, easing: easing.standard }),
            withTiming(0.45, { duration: durationMs.base, easing: easing.standard }),
            withTiming(1, { duration: durationMs.base, easing: easing.standard }),
        );
    }, [opacity, reducedMotion]);
    const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return <Animated.View pointerEvents="none" testID="document-tab-go-to-ring" style={[stylesheet.barTabGoToRing, animated]} />;
}
