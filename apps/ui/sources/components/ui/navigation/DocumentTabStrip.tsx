import * as React from 'react';
import { I18nManager, Image, Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { PinIcon } from '@/components/sessions/shell/sessionPinIcons';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { resolveHappierTabKeySelection } from '@happier-dev/plugin-ui/presentation';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { shadowLevelStyle } from '@/shadowElevation';
import type { EntityDragItemV1, EntityDragKindV1, EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { useEntityDragSource, useEntityDropTarget, useEntityDropTargetState, type EntityDragDropRuntime, type EntityDragInput } from '@/components/ui/treeDragDrop';
import { useEntityDragDomBinding, useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { TreeDropIndicatorLine } from '@/components/ui/treeDragDrop/ui/TreeDropIndicatorLine';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type DocumentTabEntityDragDrop = Readonly<{
    runtime: EntityDragDropRuntime;
    id: string;
    scope: EntityDragScopeV1;
    acceptedKinds: readonly EntityDragKindV1[];
    getItem: (tabKey: string) => EntityDragItemV1 | null;
    isCurrent?: () => boolean;
    resolve: (input: Readonly<{ item: EntityDragItemV1; beforeTabId: string | null; input: EntityDragInput }>) => EntityDropAdmissionV1;
    execute: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
}>;

type ScrollPropagationEvent = Readonly<{ stopPropagation?: () => void }>;
type DocumentTabWebPressableProps = React.ComponentPropsWithRef<typeof Pressable> & Readonly<{
    onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
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

export type DocumentTabItem = Readonly<{
    key: string;
    title: string;
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
    panelNativeId: (key: string) => string;
    unsavedTabKeys?: ReadonlySet<string>;
    testIds?: DocumentTabStripTestIds;
    /**
     * `strip` (default): the Details strip — tabs scroll, each shows its pin and close.
     * `bar`: the workspace bar (workspace lab T) — tabs shrink instead of scrolling (the consumer
     * passes only the tabs that fit), a pinned tab is its mark alone, and close appears on hover and
     * on the open tab in one always-reserved trailing slot. Pinning lives in the tab's menu.
     * `rail`: the phone's open-tabs rail (phone-nav lab R) — the bar's anatomy as pills that scroll
     * sideways: each tab rests on a hairline, the open one takes the selection fill and its close,
     * and `subtitle` reads as a quiet count after the title (a split's panes).
     */
    variant?: 'strip' | 'bar' | 'rail';
    /** `rail` only: what follows the last tab inside the scroll (the "Synced" note). */
    railTrailing?: React.ReactNode;
    /**
     * `bar` only. `raised`: the open tab is lifted onto paper — the focused pane's tab, the one
     * focus signal. `quiet`: the open tab of a pane that is not focused takes a selection tint.
     */
    activeEmphasis?: 'raised' | 'quiet';
    /** `bar` and `rail`: a tab's menu, from a right click or a long press. */
    onTabMenu?: (key: string, event: unknown) => void;
    /** `bar` only: the tablist's own height (30 in the title strip, 28 in a pane's own strip). */
    barTabHeightPx?: number;
    entityDragDrop?: DocumentTabEntityDragDrop;
    /**
     * `bar` only, while an item is carried (DnD lab C2): `dropSlot` shows the place a kept tab will
     * land at the end of the strip; `dropRingTabKey` rings the tab an already-open item will go to.
     */
    dropSlot?: boolean;
    dropRingTabKey?: string | null;
}>;

/** The bar variant's measures (workspace lab T: 30 tall in the title strip, 28 in a pane strip). */
export const DOCUMENT_TAB_BAR_METRICS = Object.freeze({
    tabHeightPx: 30,
    tabRadiusPx: 9,
    tabPaddingStartPx: 10,
    tabPaddingEndPx: 5,
    tabGapPx: 7,
    tabMinWidthPx: 120,
    tabMaxWidthPx: 212,
    glyphBoxPx: 16,
    trailingSlotPx: 18,
    trailingRadiusPx: 5,
    stripGapPx: 2,
});
const B = DOCUMENT_TAB_BAR_METRICS;

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
        gap: 6,
        paddingLeft: M.tabPaddingStartPx,
        paddingRight: 2,
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
        gap: 6,
    },
    tabSubtitle: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
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
        overflow: 'hidden',
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
        // Every tab reserves the raised tab's hairline, so raising one never shifts its neighbours.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'transparent',
    },
    barTabPinned: {
        minWidth: 0,
        flexShrink: 0,
    },
    barTabOpen: {
        flexShrink: 0,
    },
    // Hover and the open tab of a pane that is not focused take the strip's own control hover
    // (the same fill as the back/forward buttons beside them); only the focused pane's open tab is
    // raised (workspace lab T: "that is the whole focus indicator").
    barTabHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    barTabQuiet: {
        backgroundColor: theme.colors.surface.selected,
    },
    barTabRaised: {
        backgroundColor: theme.colors.surface.pressed,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    entityTab: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** The carried item lands before this tab: a mark in the gap, so no tab moves under the pointer. */
    entityTabInsertion: {
        position: 'absolute',
        top: 4,
        bottom: 4,
        width: 2,
        flexDirection: 'row',
    },
    /** Where a kept tab will land at the end of the strip (DnD lab C2 tab slot). */
    barDropSlot: {
        width: B.tabMinWidthPx,
        flexShrink: 1,
        minWidth: 0,
        borderRadius: B.tabRadiusPx,
        borderWidth: 1,
        borderColor: theme.colors.state.active.border,
        backgroundColor: theme.colors.state.active.background,
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
        marginHorizontal: 5,
        backgroundColor: theme.colors.border.strong,
        flexShrink: 0,
    },
    barTrailing: {
        paddingRight: B.tabPaddingEndPx,
        paddingLeft: 2,
    },
    railContent: {
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
    },
    railTab: {
        borderRadius: B.tabHeightPx / 2,
        borderColor: theme.colors.border.default,
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

export function DocumentTabStrip<T extends DocumentTabItem>(props: DocumentTabStripProps<T>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    // A finger gets the platform touch floor; a precise pointer keeps the dense strip (details lab 2),
    // with its pin and close still at least the WCAG 2.5.8 target.
    const touchFloorPx = resolveTouchTargetFloorPx(Platform.OS);
    const interactiveTargetStyle = React.useMemo(() => (touchFloorPx === null ? null : {
        minWidth: touchFloorPx,
        minHeight: touchFloorPx,
    }), [touchFloorPx]);
    const actionSize = Math.max(M.tabActionTargetPx, touchFloorPx ?? 0);
    const tabFocusTargetsRef = React.useRef(new Map<string, { focus?: () => void }>());
    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => {
        const key = event.key;
        const nextIndex = resolveHappierTabKeySelection({
            tabs: props.tabs,
            key,
            currentIndex,
            rtl: I18nManager.isRTL,
        });
        if (nextIndex === null) return;
        event.preventDefault();
        const nextTab = props.tabs[nextIndex];
        if (!nextTab) return;
        props.onActivate(nextTab.key);
        if (nextIndex !== currentIndex) tabFocusTargetsRef.current.get(nextTab.key)?.focus?.();
    }, [props.tabs, props.onActivate]);

    if (props.variant === 'rail') {
        return <DocumentRail strip={props} actionSize={actionSize} onKeyDown={handleKeyDown} focusTargets={tabFocusTargetsRef.current} />;
    }

    if (props.variant === 'bar') {
        return (
            <View
                style={styles.bar}
                accessibilityRole="tablist"
                accessibilityLabel={props.accessibilityLabel}
            >
                {props.tabs.map((tab, tabIndex) => (
                    <React.Fragment key={tab.key}>
                    {tabIndex > 0 && props.tabs[tabIndex - 1]?.isPinned && !tab.isPinned
                        ? <View style={styles.barPinSeparator} />
                        : null}
                    <DocumentBarTab
                        tab={tab}
                        index={tabIndex}
                        active={props.activeTabKey ? tab.key === props.activeTabKey : false}
                        emphasis={props.activeEmphasis ?? 'raised'}
                        unsaved={props.unsavedTabKeys?.has(tab.key) === true}
                        heightPx={props.barTabHeightPx ?? B.tabHeightPx}
                        actionSize={actionSize}
                        strip={props}
                        onKeyDown={handleKeyDown}
                        registerFocusTarget={(target) => {
                            if (target) tabFocusTargetsRef.current.set(tab.key, target);
                            else tabFocusTargetsRef.current.delete(tab.key);
                        }}
                    />
                    </React.Fragment>
                ))}
                {props.dropSlot ? <View testID="document-tab-drop-slot" style={[styles.barDropSlot, { height: props.barTabHeightPx ?? B.tabHeightPx }]}
                    accessibilityElementsHidden importantForAccessibility="no-hide-descendants" /> : null}
            </View>
        );
    }

    return (
        <ScrollView
            horizontal
            style={styles.tabsScroll}
            contentContainerStyle={styles.tabsContent}
            showsHorizontalScrollIndicator={false}
            accessibilityRole="tablist"
            accessibilityLabel={props.accessibilityLabel}
        >
            {props.tabs.map((tab, tabIndex) => {
                const isActive = props.activeTabKey ? tab.key === props.activeTabKey : false;
                const isUnsaved = props.unsavedTabKeys?.has(tab.key) === true;
                const safeTabKey = toTestIdSafeValue(tab.key);
                const presentation = props.resolveTabPresentation?.(tab) ?? null;
                const content = (
                    <View
                        key={tab.key}
                        style={[styles.tab, isActive ? styles.tabActive : null]}
                    >
                        <DocumentTabWebPressable
                            ref={(target) => {
                                if (target) tabFocusTargetsRef.current.set(tab.key, target);
                                else tabFocusTargetsRef.current.delete(tab.key);
                            }}
                            onPress={() => props.onActivate(tab.key)}
                            onKeyDown={Platform.OS === 'web'
                                ? (event) => handleKeyDown(event, tabIndex)
                                : undefined}
                            testID={props.testIds?.tab?.(safeTabKey) ?? undefined}
                            style={[
                                styles.tabContent,
                                interactiveTargetStyle,
                            ]}
                            accessibilityRole="tab"
                            accessibilityLabel={presentation?.status
                                ? `${t('session.detailsPanel.openTabA11y', { title: tab.title })}, ${presentation.status.label}`
                                : t('session.detailsPanel.openTabA11y', { title: tab.title })}
                            accessibilityState={{ selected: isActive }}
                            aria-selected={isActive}
                            nativeID={props.tabNativeId(tab.key)}
                            aria-controls={props.panelNativeId(tab.key)}
                            tabIndex={isActive ? 0 : -1}
                        >
                            {presentation?.isLoading ? (
                                <ActivitySpinner
                                    size={M.tabGlyphPx - 3}
                                    color={theme.colors.text.secondary}
                                    testID={props.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                                />
                            ) : presentation?.faviconUrl ? (
                                <Image
                                    source={{ uri: presentation.faviconUrl }}
                                    style={styles.favicon}
                                    testID={props.testIds?.tabFavicon?.(safeTabKey) ?? undefined}
                                />
                            ) : props.renderLeadingIcon(tab, isActive)}
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
                                    testID={props.testIds?.tabStatus?.(safeTabKey) ?? undefined}
                                    spinnerTestID={props.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
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
                                    testID={props.testIds?.tabPin?.(safeTabKey) ?? undefined}
                                    accessibilityLabel={`${t('session.detailsPanel.pinTabA11y')}: ${tab.title}`}
                                    tooltip={`${t('session.detailsPanel.pinTabA11y')}: ${tab.title}`}
                                    variant="plain"
                                    size={actionSize}
                                    minimumInteractiveTargetSize={actionSize}
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
                                    testID={props.testIds?.tabUnpin?.(safeTabKey) ?? undefined}
                                    accessibilityLabel={`${t('session.detailsPanel.unpinTabA11y')}: ${tab.title}`}
                                    tooltip={`${t('session.detailsPanel.unpinTabA11y')}: ${tab.title}`}
                                    variant="plain"
                                    size={actionSize}
                                    minimumInteractiveTargetSize={actionSize}
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
                                testID={props.testIds?.tabClose?.(safeTabKey) ?? undefined}
                                accessibilityLabel={`${isUnsaved
                                    ? t('detailsSurface.chrome.closeUnsavedTabA11y')
                                    : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`}
                                tooltip={`${isUnsaved
                                    ? t('detailsSurface.chrome.closeUnsavedTabA11y')
                                    : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`}
                                variant="plain"
                                size={actionSize}
                                minimumInteractiveTargetSize={actionSize}
                                iconSize={M.tabCloseGlyphPx}
                                icon={isUnsaved ? (
                                    <View
                                        testID={props.testIds?.tabUnsaved?.(safeTabKey) ?? undefined}
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
                return <React.Fragment key={tab.key}>{props.entityDragDrop
                    ? <DocumentEntityTab tab={tab} binding={props.entityDragDrop} gapPx={M.tabGapPx} first={tabIndex === 0}>{wrapped}</DocumentEntityTab>
                    : wrapped}</React.Fragment>;
            })}
        </ScrollView>
    );
}

/** The rail's pills are 30 tall; the press reaches the platform's comfortable touch height. */
const RAIL_HIT_SLOP = { top: 7, bottom: 7 } as const;

/**
 * The phone's open-tabs rail: the bar's tabs as scrolling pills. The open tab is kept in view when it
 * changes (a tab opened from elsewhere, a preview replaced), without animating on arrival.
 */
function DocumentRail<T extends DocumentTabItem>(props: Readonly<{
    strip: DocumentTabStripProps<T>;
    actionSize: number;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => void;
    focusTargets: Map<string, { focus?: () => void }>;
}>) {
    const styles = stylesheet;
    const { strip } = props;
    const scrollRef = React.useRef<ScrollView | null>(null);
    const frames = React.useRef(new Map<string, { x: number; width: number }>());
    const viewport = React.useRef({ x: 0, width: 0 });
    const reveal = React.useCallback((key: string | null, animated: boolean) => {
        const frame = key ? frames.current.get(key) : undefined;
        const { x, width } = viewport.current;
        if (!frame || width === 0) return;
        if (frame.x < x + 12) scrollRef.current?.scrollTo({ x: Math.max(0, frame.x - 12), animated });
        else if (frame.x + frame.width > x + width - 12) scrollRef.current?.scrollTo({ x: frame.x + frame.width - width + 12, animated });
    }, []);
    React.useEffect(() => { reveal(strip.activeTabKey, false); }, [reveal, strip.activeTabKey]);
    return (
        <ScrollView
            ref={scrollRef}
            horizontal
            contentContainerStyle={styles.railContent}
            showsHorizontalScrollIndicator={false}
            onLayout={(event) => {
                viewport.current = { ...viewport.current, width: event.nativeEvent.layout.width };
                reveal(strip.activeTabKey, false);
            }}
            onScroll={(event) => { viewport.current = { ...viewport.current, x: event.nativeEvent.contentOffset.x }; }}
            scrollEventThrottle={32}
            accessibilityRole="tablist"
            accessibilityLabel={strip.accessibilityLabel}
        >
            {strip.tabs.map((tab, tabIndex) => (
                <DocumentBarTab
                    key={tab.key}
                    rail
                    tab={tab}
                    index={tabIndex}
                    active={strip.activeTabKey ? tab.key === strip.activeTabKey : false}
                    emphasis="quiet"
                    unsaved={strip.unsavedTabKeys?.has(tab.key) === true}
                    heightPx={B.tabHeightPx}
                    actionSize={props.actionSize}
                    strip={strip}
                    onKeyDown={props.onKeyDown}
                    onLayout={(event) => {
                        const { x, width } = event.nativeEvent.layout;
                        frames.current.set(tab.key, { x, width });
                        if (tab.key === strip.activeTabKey) reveal(tab.key, false);
                    }}
                    registerFocusTarget={(target) => {
                        if (target) props.focusTargets.set(tab.key, target);
                        else props.focusTargets.delete(tab.key);
                    }}
                />
            ))}
            {strip.railTrailing ?? null}
        </ScrollView>
    );
}

function stopPropagation(event: unknown) {
    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
        (event as ScrollPropagationEvent).stopPropagation?.();
    }
}

/**
 * One tab of the bar variant. Its own hover state reveals close in the reserved trailing slot, so the
 * tab never changes width under the pointer (workspace lab: "hover never changes width").
 */
function DocumentBarTab<T extends DocumentTabItem>(props: Readonly<{
    tab: T;
    index: number;
    active: boolean;
    emphasis: 'raised' | 'quiet';
    unsaved: boolean;
    heightPx: number;
    actionSize: number;
    strip: DocumentTabStripProps<T>;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentIndex: number) => void;
    registerFocusTarget: (target: { focus?: () => void } | null) => void;
    rail?: boolean;
    onLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const { tab, strip } = props;
    const safeTabKey = toTestIdSafeValue(tab.key);
    const presentation = strip.resolveTabPresentation?.(tab) ?? null;
    const pinned = tab.isPinned;
    const status = presentation?.status ?? null;
    const showClose = !pinned && ((hovered && !props.rail) || props.active || (!status && props.unsaved));
    const openMenu = strip.onTabMenu
        ? (event: unknown) => {
            (event as { preventDefault?: () => void } | null)?.preventDefault?.();
            strip.onTabMenu?.(tab.key, event);
        }
        : undefined;
    const closeLabel = `${props.unsaved
        ? t('detailsSurface.chrome.closeUnsavedTabA11y')
        : t('session.detailsPanel.closeTabA11y')}: ${tab.title}`;
    const content = (
        <View
            onLayout={props.onLayout}
            style={[
                styles.barTab,
                { height: props.heightPx },
                pinned ? [styles.barTabPinned, { width: props.heightPx }] : null,
                props.active ? styles.barTabOpen : null,
                hovered && !props.active ? styles.barTabHovered : null,
                props.active && !props.rail ? (props.emphasis === 'raised' ? styles.barTabRaised : styles.barTabQuiet) : null,
                props.rail ? [styles.railTab, props.active ? styles.railTabOpen : null] : null,
            ]}
            {...(Platform.OS === 'web' ? {
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            } : null)}
        >
            <DocumentTabWebPressable
                ref={(target) => props.registerFocusTarget(target as { focus?: () => void } | null)}
                onPress={() => strip.onActivate(tab.key)}
                onLongPress={openMenu}
                hitSlop={props.rail ? RAIL_HIT_SLOP : undefined}
                {...(Platform.OS === 'web' && openMenu ? { onContextMenu: openMenu } : null)}
                onKeyDown={Platform.OS === 'web'
                    ? (event) => props.onKeyDown(event, props.index)
                    : undefined}
                testID={strip.testIds?.tab?.(safeTabKey) ?? undefined}
                style={[styles.barTabPress, pinned ? styles.barTabPressPinned : null, { height: props.heightPx }]}
                accessibilityRole="tab"
                accessibilityLabel={status
                    ? `${t('session.detailsPanel.openTabA11y', { title: tab.title })}, ${status.label}`
                    : t('session.detailsPanel.openTabA11y', { title: tab.title })}
                accessibilityState={{ selected: props.active }}
                aria-selected={props.active}
                nativeID={strip.tabNativeId(tab.key)}
                aria-controls={strip.panelNativeId(tab.key)}
                tabIndex={props.active ? 0 : -1}
            >
                <View style={styles.barGlyph}>
                    {presentation?.isLoading ? (
                        <ActivitySpinner
                            size={M.tabGlyphPx - 3}
                            color={theme.colors.text.secondary}
                            testID={strip.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                        />
                    ) : presentation?.faviconUrl ? (
                        <Image
                            source={{ uri: presentation.faviconUrl }}
                            style={styles.favicon}
                            testID={strip.testIds?.tabFavicon?.(safeTabKey) ?? undefined}
                        />
                    ) : strip.renderLeadingIcon(tab, props.active || hovered)}
                    {pinned && status ? (
                        <View style={styles.pinnedStatus}>
                            <DocumentTabStatusMark status={status} compact testID={strip.testIds?.tabStatus?.(safeTabKey) ?? undefined} />
                        </View>
                    ) : null}
                </View>
                {pinned ? null : (
                    <Text
                        style={[
                            styles.tabLabel,
                            props.active || hovered ? { color: theme.colors.text.primary } : null,
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
                                testID={strip.testIds?.tabStatus?.(safeTabKey) ?? undefined}
                                spinnerTestID={strip.testIds?.tabSpinner?.(safeTabKey) ?? undefined}
                            />
                        ) : showClose ? (
                            <IconButton
                                onPress={(event: unknown) => {
                                    stopPropagation(event);
                                    strip.onClose(tab.key);
                                }}
                                testID={strip.testIds?.tabClose?.(safeTabKey) ?? undefined}
                                accessibilityLabel={closeLabel}
                                tooltip={closeLabel}
                                tooltipPlacement="bottom"
                                variant="plain"
                                size={B.trailingSlotPx}
                                minimumInteractiveTargetSize={props.actionSize}
                                iconSize={M.tabCloseGlyphPx}
                                icon={props.unsaved && !hovered ? (
                                    <View
                                        testID={strip.testIds?.tabUnsaved?.(safeTabKey) ?? undefined}
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
            {strip.dropRingTabKey === tab.key ? <DocumentTabGoToRing /> : null}
        </View>
    );
    return strip.entityDragDrop
        ? <DocumentEntityTab tab={tab} binding={strip.entityDragDrop} gapPx={B.stripGapPx} first={props.index === 0}>{content}</DocumentEntityTab>
        : content;
}

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
    binding: DocumentTabEntityDragDrop;
    /** The strip's gap: the insertion mark sits in the gap before this tab. */
    gapPx: number;
    first: boolean;
    children: React.ReactNode;
}>) {
    const { tab, binding } = props;
    const sourceId = JSON.stringify(['document-tab', binding.id, tab.key, 'source']);
    const targetId = JSON.stringify(['document-tab', binding.id, tab.key, 'target']);
    const host = React.useRef<HTMLElement | null>(null);
    const nativeBounds = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);
    useEntityDragSource(binding.runtime, {
        id: sourceId, scope: binding.scope,
        getItem: () => binding.getItem(tab.key),
        isCurrent: () => binding.isCurrent?.() !== false && binding.getItem(tab.key) !== null,
        describe: () => ({ title: tab.title }),
    });
    useEntityDropTarget(binding.runtime, {
        id: targetId, scope: binding.scope, acceptedKinds: binding.acceptedKinds,
        isCurrent: () => binding.isCurrent?.() !== false,
        getBounds: () => {
            const rect = host.current?.getBoundingClientRect?.();
            return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : nativeBounds.current;
        },
        listDestinations: () => [{ destination: { beforeTabId: tab.key }, label: tab.title }],
        resolve: ({ item, input }) => binding.resolve({ item, beforeTabId: tab.key, input }),
        execute: binding.execute,
    });
    const sourceRef = useEntityDragDomBinding({ runtime: binding.runtime, sourceId,
        enabled: binding.isCurrent?.() !== false && binding.getItem(tab.key) !== null,
        describe: () => tab.title,
        canStart: (event, element) => {
            const control = (event.target as Element | null)?.closest?.('button, input, [role="checkbox"]');
            return !control || control === element.querySelector('[role="tab"]');
        },
    });
    const dropRef = useEntityDropDomBinding(binding.runtime);
    const attach = React.useCallback((node: unknown) => {
        host.current = node as HTMLElement | null;
        sourceRef(node);
        dropRef(node);
        binding.runtime.refresh();
    }, [binding.runtime, sourceRef, dropRef]);
    const state = useEntityDropTargetState(binding.runtime, targetId);
    const allowed = state?.phase === 'carrying' && state.admission?.status === 'allowed';
    return <View ref={attach} onLayout={() => {
        const node = host.current as unknown as { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void } | null;
        node?.measureInWindow?.((x, y, width, height) => { nativeBounds.current = { x, y, width, height }; binding.runtime.refresh(); });
        binding.runtime.refresh();
    }} style={stylesheet.entityTab}>
        {props.children}
        {allowed ? <View pointerEvents="none" testID={`document-tab-drop-before-${toTestIdSafeValue(tab.key)}`}
            style={[stylesheet.entityTabInsertion, { left: props.first ? 0 : -(props.gapPx / 2) - 1 }]}>
            <TreeDropIndicatorLine orientation="vertical" indentPx={0}
                visual={{ kind: 'line', targetId: tab.key, edge: 'top', depth: 0 }} />
        </View> : null}
    </View>;
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
