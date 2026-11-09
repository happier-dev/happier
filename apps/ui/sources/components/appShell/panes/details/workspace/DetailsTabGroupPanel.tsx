import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { PaneHeaderScrollScope } from '@/components/appShell/panes/paneHeaderScroll';
import { PaneMainRestoreChip, usePaneMainRestoreChipVisible } from '@/components/appShell/panes/mainColumn/PaneMainColumnControls';
import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, { FadeIn, type EntryOrExitLayoutType } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { useWebScrollLockBypass } from '@/components/ui/scroll/useWebScrollLockBypass';
import { DIFF_SPLIT_MIN_WIDTH_PX, DiffPresentationWidthProvider, resolveDiffSplitFits } from '@/components/ui/code/diff/diffPresentationStyle';
import { DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DetailsTabState, DetailsWorkspaceGroupView } from './detailsWorkspaceTypes';
import {
    DetailsTabStrip,
    resolveDetailsTabGlyph,
    useGuardedDetailsTabClose,
    detailsTabNativeId,
    detailsTabPanelNativeId,
    type DetailsTabPresentation,
    type DetailsTabStripTestIds,
} from './DetailsTabStrip';
import { DetailsTabChromeProvider, useDetailsTabUnsavedKeys } from './detailsTabChrome';
import { HeaderActionsScope, useStackHeaderActionsClaimed, useStackHeaderActionsPublisher, type LentHeaderMenuRow } from '@/components/navigation/stackHeaderActions';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { PopoverScope } from '@/components/ui/popover';
import { DetailsTabLifetimeScope, detailsTabNavigationKey } from './detailsTabLifetime';
import { runGuardedTabNavigation } from '@/utils/navigation/runGuardedNavigation';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

type ScrollPropagationEvent = Readonly<{ stopPropagation?: () => void }>;

const ViewWithWheel = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onWheel?: (event: unknown) => void; onTouchMove?: (event: unknown) => void }
>;
// Animated so a tab that takes another's place in the same group (a Start form becoming its Discussion
// or Run) can fade in; every other tab mounts still. One type for every panel, so none remounts.
const AccessibleTabPanelView = Animated.View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & Pick<React.HTMLAttributes<HTMLElement>, 'inert'> & { entering?: EntryOrExitLayoutType }
>;
/** Lab flows: after Ask/Start the body cross-fades into its result on the base duration, also under reduced motion. */
const REPLACED_TAB_ENTERING = FadeIn.duration(motionTokens.durationMs.base);

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        minHeight: 0,
        minWidth: 0,
    },
    // The strip sits on the paper, on one hairline, with the pane's controls at its end (details
    // lab 2, `dl-strip`): the tabs are the only chrome above the tab's own header.
    header: {
        minHeight: DETAILS_TAB_STRIP_METRICS.heightPx,
        paddingLeft: DETAILS_TAB_STRIP_METRICS.paddingStartPx,
        paddingRight: DETAILS_TAB_STRIP_METRICS.paddingEndPx,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
        flexDirection: 'row',
        alignItems: 'center',
        gap: DETAILS_TAB_STRIP_METRICS.tabGapPx,
    },
}));

const DetailsTabSurface = React.memo((props: Readonly<{
    groupId: string;
    tabKey: string;
    isActive: boolean;
    /** Mounted in place of a tab that just left this group (`replaceTab`): it fades in. */
    replacing?: boolean;
    children: React.ReactNode;
}>) => {
    const a11yHiddenProps =
        Platform.OS === 'web'
            ? null
            : {
                accessibilityElementsHidden: !props.isActive,
                importantForAccessibility: props.isActive ? ('auto' as const) : ('no-hide-descendants' as const),
            };

    return (
        <AccessibleTabPanelView
            entering={props.replacing ? REPLACED_TAB_ENTERING : undefined}
            nativeID={detailsTabPanelNativeId(props.groupId, props.tabKey)}
            role="tabpanel"
            accessibilityLabelledBy={detailsTabNativeId(props.groupId, props.tabKey)}
            aria-labelledby={detailsTabNativeId(props.groupId, props.tabKey)}
            {...(Platform.OS === 'web' && !props.isActive ? { inert: true } : {})}
            pointerEvents={props.isActive ? 'auto' : 'none'}
            // Every retained tab fills the group on its own layer; stacked as flex siblings they split
            // the height, so the open tab got 1/N of the pane (its floating tray sat mid-pane).
            style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                minHeight: 0,
                minWidth: 0,
                opacity: props.isActive ? 1 : 0,
                display: 'flex',
                ...(Platform.OS === 'web' ? { visibility: props.isActive ? 'visible' : 'hidden' } : null),
            } as any}
            {...a11yHiddenProps}
        >
            <PluginSurfaceFocusEligibilityProvider active={props.isActive}>
                {/* A tab is not the page its pane sits in: it draws its own title and way back under its strip,
                    never in that page's navigation band (a second header over a Session's). */}
                <NavigationTitleChromeProvider showsTitle={false}>
                    {/* Each retained tab is its own header/body pair: its scroll drives only its header's shade. */}
                    <PaneHeaderScrollScope>{props.children}</PaneHeaderScrollScope>
                </NavigationTitleChromeProvider>
            </PluginSurfaceFocusEligibilityProvider>
        </AccessibleTabPanelView>
    );
});

export type DetailsTabGroupPanelProps = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    resolveTabHref?: (tab: DetailsTabState) => string | null;
    pane: AppPaneScopeApi;
    group: DetailsWorkspaceGroupView;
    paddingTop?: number;
    headerPaddingTop?: number;
    forceEmptyState?: boolean;
    testIds?: Readonly<{
        root?: string;
    }> & DetailsTabStripTestIds;
    resolveTabIconName?: ((tab: DetailsTabState) => string | null | undefined) | null;
    resolveTabPresentation?: ((tab: DetailsTabState) => DetailsTabPresentation | null | undefined) | null;
    /**
     * Whether the workspace is showing this group at all. A maximized group is
     * the only one on screen, and the others stay mounted behind it — the same
     * definition the Board's own visibility owner uses. Absent means "the only
     * group", so a panel rendered on its own keeps presenting its active tab.
     */
    presented?: boolean;
    /**
     * The group knows which of its retained tabs is actually presented, so it
     * hands that fact to the content it renders. A surface that owns an editor,
     * a draft or an executable frame cannot infer it from being mounted.
     */
    renderTabContent: (tab: DetailsTabState, presentation: Readonly<{ active: boolean }>) => React.ReactNode;
    renderHeaderLeadingActions?: (() => React.ReactNode) | null;
    /**
     * Launchers that open another tab in this group (the browser launchpad). They belong to the
     * strip: when one tab's header takes the pane's controls, a peek keeps only the pane's own
     * (focus, close), and the launchers come back with the strip.
     */
    renderStripActions?: (() => React.ReactNode) | null;
    /**
     * What must stay reachable whatever the strip does: live controls (Track following an agent's write,
     * a pending approval) and the pane's own toggles (the right pane). Unlike a launcher they never leave
     * with the strip: they sit just before the pane's controls wherever those are drawn, on the strip or in
     * the one tab's header the controls are lent to. They are not a close, so a phone tab's `⋯` keeps its
     * Close row. Return null while there is nothing to show, so a pane with nothing else to lend lends nothing.
     */
    renderLiveActions?: (() => React.ReactNode) | null;
    renderHeaderActions?: (() => React.ReactNode) | null;
    /**
     * Closing the pane's last tab ends the pane's presentation rather than leaving it empty (a phone
     * Session returns to the scene it came from). Offered by the one tab's header `⋯` on a phone.
     */
    closeLastTab?: (() => void) | null;
    renderEmptyState?: (() => React.ReactNode) | null;
    /**
     * The group is the pane's only one: while it shows a single tab whose content draws its own
     * header, the strip (one chip naming what the header names) gives way and the pane's controls
     * ride in that header (lab `session-D`). Several tabs, or a tab without a header, keep the strip.
     */
    collapseSingleTabStrip?: boolean;
}>;

function DetailsTabBody(props: Readonly<{
    scopeId: string;
    tab: DetailsTabState;
    active: boolean;
    renderTabContent: DetailsTabGroupPanelProps['renderTabContent'];
}>) {
    return <DetailsTabLifetimeScope scopeId={props.scopeId} tabKey={props.tab.key}>
        {props.renderTabContent(props.tab, { active: props.active })}
    </DetailsTabLifetimeScope>;
}

export const DetailsTabGroupPanel = React.memo((props: DetailsTabGroupPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const backgroundColor = materialColor(theme.colors.surface.base, 'transparent');
    const rootRef = React.useRef<View | null>(null);
    useWebScrollLockBypass({ rootRef, enabled: true });

    const stopScrollEventPropagationOnWeb = React.useCallback((event: unknown) => {
        if (Platform.OS !== 'web') return;
        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
            (event as ScrollPropagationEvent).stopPropagation?.();
        }
    }, []);

    const activeTab = React.useMemo(() => {
        return props.group.tabs.find((tab) => tab.key === props.group.activeTabKey) ?? props.group.tabs.at(-1) ?? null;
    }, [props.group.activeTabKey, props.group.tabs]);
    const effectiveActiveKey = props.group.activeTabKey ?? activeTab?.key ?? null;
    const forceEmptyState = props.forceEmptyState === true;
    // A tab replaced in place: the active key is new while a key the group showed before has left.
    // Only that tab's mount reads it, so a later render computing nothing changes no animation.
    const previousTabKeys = React.useRef<ReadonlySet<string> | null>(null);
    const tabKeys = React.useMemo(() => new Set(props.group.tabs.map((tab) => tab.key)), [props.group.tabs]);
    const previousKeys = previousTabKeys.current;
    const replacingKey = previousKeys && effectiveActiveKey && !previousKeys.has(effectiveActiveKey)
        && [...previousKeys].some((key) => !tabKeys.has(key)) ? effectiveActiveKey : null;
    React.useLayoutEffect(() => {
        previousTabKeys.current = tabKeys;
    }, [tabKeys]);


    const headerPaddingTop = props.headerPaddingTop ?? 0;
    // A phone keeps its strip only while it carries the screen's leading control (Back belongs on that
    // row). When the screen bar above already holds Back, a one-tab strip is a second header (lab FV1p).
    // What the leading slot draws decides it, not whether a renderer was passed: a pane whose leading
    // control is withheld (the Session cockpit keeps Back in its own header) has nothing to carry.
    const phone = useSurfaceStateSize() === 'phone';
    const leadingActions = props.renderHeaderLeadingActions ? props.renderHeaderLeadingActions() : null;
    const phoneStripCarriesLeading = phone && leadingActions != null;
    // A hidden main column's restore chip lives on the strip edge the column went to (lab H1/H3), so the
    // focused group keeps its strip while that chip has something to show.
    const restoreChipOnStrip = usePaneMainRestoreChipVisible() && props.group.isFocused;
    // One tab bar on a phone (owner ruling 2026-10-30): the Session tabs rail is the phone's only tab bar, so a group
    // holding several pages (a wide layout's, after a resize) shows the page on screen alone, and the other pages its
    // strip offered move into that page's `⋯`. Presentation only: the group itself is not changed.
    const lendsControls = props.collapseSingleTabStrip === true && !phoneStripCarriesLeading && !forceEmptyState && !restoreChipOnStrip
        && (props.group.tabs.length === 1 || phone);
    const headerActionsScopeKey = `details-group:${React.useId()}`;
    const { renderHeaderLeadingActions, renderHeaderActions, renderLiveActions } = props;
    // Nothing to lend lends nothing: an empty fragment would read as pane controls and keep a header's row (FV2bp).
    // Live controls travel with the pane's controls; launchers (`renderStripActions`) stay with the strip.
    const renderLentControls = React.useCallback(() => {
        const leading = renderHeaderLeadingActions ? renderHeaderLeadingActions() : null;
        const live = renderLiveActions ? renderLiveActions() : null;
        const trailing = renderHeaderActions ? renderHeaderActions() : null;
        return leading == null && live == null && trailing == null ? null : <>{leading}{live}{trailing}</>;
    }, [renderHeaderActions, renderHeaderLeadingActions, renderLiveActions]);
    const controlsTakenByTab = useStackHeaderActionsClaimed(headerActionsScopeKey);
    const showStrip = !(lendsControls && controlsTakenByTab);
    // On a phone the one tab's page header is its only chrome (owner ruling 2026-10-30): what its chip
    // offered (pin or unpin, close) moves into that header's `⋯` rather than leaving with the strip.
    const { pinDetailsTab, unpinDetailsTab, setActiveDetailsTab } = props.pane;
    const closeTab = useGuardedDetailsTabClose(props.pane.closeDetailsTab, props.pane.scopeId);
    const { closeLastTab } = props;
    const foldedTab = phone && !showStrip ? activeTab : null;
    // A pane that lends its own close (a full-screen route's ✕) already offers it in the header; a live control is no close.
    const paneLendsClose = foldedTab !== null
        && ((renderHeaderLeadingActions?.() ?? null) !== null || (renderHeaderActions?.() ?? null) !== null);
    const foldedTabKey = foldedTab?.key ?? null;
    const foldedTabPin = foldedTab ? (foldedTab.isPreview ? 'pin' : foldedTab.isPinned ? 'unpin' : null) : null;
    const { resolveTabIconName } = props;
    const groupTabs = props.group.tabs;
    const otherTabs = React.useMemo(() => foldedTabKey === null ? null : groupTabs.filter((tab) => tab.key !== foldedTabKey),
        [foldedTabKey, groupTabs]);
    const stripMenuRows = React.useMemo((): readonly LentHeaderMenuRow[] | null => {
        if (foldedTabKey === null) return null;
        const show = (otherTabs ?? []).map((tab): LentHeaderMenuRow => ({ id: `details-tab-show:${tab.key}`, title: tab.title,
            testID: `details-tab-menu-show-${toTestIdSafeValue(tab.key)}`, iconName: resolveDetailsTabGlyph(tab, resolveTabIconName),
            onSelect: () => setActiveDetailsTab(tab.key) }));
        const pin: LentHeaderMenuRow | null = foldedTabPin === 'pin'
            ? { id: 'details-tab-pin', title: t('session.detailsPanel.pinTabA11y'), testID: 'details-tab-menu-pin', iconName: 'push-pin', onSelect: () => pinDetailsTab(foldedTabKey) }
            : foldedTabPin === 'unpin'
                ? { id: 'details-tab-unpin', title: t('session.detailsPanel.unpinTabA11y'), testID: 'details-tab-menu-unpin', iconName: 'push-pin-slash', onSelect: () => unpinDetailsTab(foldedTabKey) }
                : null;
        const close: LentHeaderMenuRow = { id: 'details-tab-close', title: t('session.detailsPanel.closeTabA11y'),
            // Closing the last page ends the pane; with others held, the next one takes the screen.
            testID: 'details-tab-menu-close', iconName: 'x', onSelect: closeLastTab && show.length === 0
                ? () => { void runGuardedTabNavigation([detailsTabNavigationKey(props.pane.scopeId, foldedTabKey)], closeLastTab); }
                : () => closeTab(foldedTabKey) };
        return [...show, ...(pin ? [pin] : []), ...(paneLendsClose ? [] : [close])];
    }, [closeLastTab, closeTab, foldedTabKey, foldedTabPin, otherTabs, paneLendsClose, pinDetailsTab, resolveTabIconName, setActiveDetailsTab, unpinDetailsTab]);
    // The rows travel with the lent controls, so whichever header draws those controls offers them too (a Details
    // header in its own `⋯`; a plugin or core page header in a `⋯` beside them).
    useStackHeaderActionsPublisher(headerActionsScopeKey, lendsControls ? renderLentControls : null, stripMenuRows);
    const mainColumnEdge = useOptionalAppPaneScopeLayout()?.arrangement === 'editor' ? 'end' : 'start';
    const { unsavedKeys, chromeFor } = useDetailsTabUnsavedKeys(props.pane.pinDetailsTab);
    // Every diff drawn in this group applies the one split-width rule against the group's width. Only
    // crossing the threshold is state: resizing the pane does not re-render its tabs per pixel.
    const [splitFits, setSplitFits] = React.useState<boolean | null>(null);
    const onGroupLayout = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
        const next = resolveDiffSplitFits(event.nativeEvent.layout.width);
        if (next === null) return;
        setSplitFits((current) => (current === next ? current : next));
    }, []);

    return (
        <ViewWithWheel
            ref={rootRef}
            testID={props.testIds?.root}
            onLayout={onGroupLayout}
            style={[styles.container, { backgroundColor }, props.paddingTop ? { paddingTop: props.paddingTop } : null]}
            {...(Platform.OS === 'web'
                ? { onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb }
                : {})}
        >
            {/* The tab group (its strip and body) is the boundary its menus and Add surfaces float inside. */}
            <PopoverScope boundaryRef={rootRef}>
            {showStrip ? <View style={[styles.header, { paddingTop: headerPaddingTop, backgroundColor }]}>
                {leadingActions}
                {/* A hidden main column's restore chip, at the strip edge the column went to (lab H1–H3). */}
                {props.group.isFocused && mainColumnEdge === 'start' ? <PaneMainRestoreChip /> : null}
                {!forceEmptyState ? (
                    <DetailsTabStrip
                        paneScopeId={props.pane.scopeId}
                        sessionId={props.sessionId}
                        serverId={props.serverId}
                        pane={props.pane}
                        group={props.group}
                        resolveTabIconName={props.resolveTabIconName}
                        resolveTabPresentation={props.resolveTabPresentation}
                        resolveTabHref={props.resolveTabHref}
                        unsavedTabKeys={unsavedKeys}
                        testIds={props.testIds}
                    />
                ) : (
                    <View style={{ flex: 1, minHeight: 0, minWidth: 0 }} />
                )}
                {props.group.isFocused && mainColumnEdge === 'end' ? <PaneMainRestoreChip /> : null}
                {props.renderStripActions ? props.renderStripActions() : null}
                {/* Launchers lead; what stays reachable and the pane's own controls close the row, in the same order a lent header draws them. */}
                {renderLiveActions ? renderLiveActions() : null}
                {props.renderHeaderActions ? props.renderHeaderActions() : null}
            </View> : null}
            {forceEmptyState || props.group.tabs.length === 0 ? (
                props.renderEmptyState ? props.renderEmptyState() : (
                    <SurfaceStateCard
                        testID="pane-details-empty-state"
                        kind="empty"
                        iconName="files"
                        title={t('detailsSurface.chrome.emptyTitle')}
                        reason={t('detailsSurface.chrome.emptyReason')}
                    />
                )
            ) : (
                <DiffPresentationWidthProvider widthPx={splitFits === null ? null : splitFits ? DIFF_SPLIT_MIN_WIDTH_PX : 1}>
                <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    {props.group.tabs.map((tab) => {
                        const isActive = effectiveActiveKey ? tab.key === effectiveActiveKey : false;
                        // Tab chrome keeps answering for this group's own strip, while the
                        // content is told whether the WORKSPACE is presenting it: a group
                        // hidden behind a maximized sibling presents none of its tabs.
                        const presented = isActive && props.presented !== false;
                        return (
                            <DetailsTabSurface
                                key={tab.key}
                                groupId={props.group.id}
                                tabKey={tab.key}
                                isActive={isActive}
                                replacing={tab.key === replacingKey}
                            >
                                <RetainedPanelSurface isActive={presented} mode="flow">
                                    <DetailsTabChromeProvider value={chromeFor(tab.key)}>
                                        <HeaderActionsScope scopeKey={lendsControls && isActive ? headerActionsScopeKey : null}>
                                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                                <DetailsTabBody scopeId={props.pane.scopeId} tab={tab} active={presented} renderTabContent={props.renderTabContent} />
                                            </React.Suspense>
                                        </HeaderActionsScope>
                                    </DetailsTabChromeProvider>
                                </RetainedPanelSurface>
                            </DetailsTabSurface>
                        );
                    })}
                </View>
                </DiffPresentationWidthProvider>
            )}
            </PopoverScope>
        </ViewWithWheel>
    );
});
