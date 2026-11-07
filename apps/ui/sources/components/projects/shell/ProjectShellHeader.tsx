import { PaneMainHideButton } from '@/components/appShell/panes/mainColumn/PaneMainColumnControls';
import { usePresentedDetailNavigationChrome } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import * as React from 'react';
import {
  Pressable,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HAPPIER_PAGE_METRICS,
  HAPPIER_SEGMENTED_METRICS,
  happierFocusRingStyle,
  happierPageTextMetrics,
  isHappierFocusVisible,
} from '@happier-dev/plugin-ui/presentation';
import { GROUPED_SURFACE_RADIUS_PX } from '@/components/ui/lists/pageListMetrics';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  HEADER_BAND_HORIZONTAL_PADDING_PX,
  HEADER_BAND_TITLE_TEXT,
} from '@/components/ui/layout/headerBand';
import {
  PageHeaderMenu,
  type PageHeaderMenuAction,
} from '@/components/ui/layout/PageHeaderEntityParts';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { buildNavigationPlacementMenu, buildPlacementReorderBinding, type NavigationPlacementItem } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { EntityFlatReorderList, EntityFlatReorderRow } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { resolveNavigationPlacements, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { useClaimedStackHeaderActions, useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';
import type { PluginRightSidebarLabelledCount } from '@/components/appShell/rightSidebar/rightSidebarPluginCount';

import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { useAtmospherePictureShown } from '@/components/atmosphere/atmosphereStage';

/** One page in the header's tabs (D44): the route's page id, its glyph and an optional quiet count. */
export type ProjectShellPage = Readonly<{
  id: string;
  title: string;
  icon: IconName;
  disabledReason: string | null;
  disabledReasonCode?: string;
  count?: string;
  /** Ordered semantic facts for the UI-owned paired-count composition. */
  counts?: readonly PluginRightSidebarLabelledCount[];
}>;

export { projectPageGlyph, projectPageLabel } from '../navigation/projectPageDisplay';

/** The checkout the page is looking at: its machine and branch, and the exact choices behind the chip. */
export type ProjectShellCheckout = Readonly<{
  machineName: string;
  machineIcon: IconName;
  /** The branch the checkout reported; null while it is unread (its machine stands in). */
  branch: string | null;
  /** Every exact checkout of this Project the viewer can open, the current one checked. */
  choices: readonly DropdownMenuItem[];
  onSelect: (choiceId: string) => void;
}>;

/**
 * Below this measured band width the header keeps its identity and tabs readable by dropping the
 * chip's machine name and New session's label (lab `p-overview` FIT, a 1180 window); the tabs then
 * fit themselves by their own measurement. Not a count of tabs or a viewport class: the band's box.
 */
const COMPACT_BAND_WIDTH_PX = 960;
/** The gap between the header's actions: neighbours' finger frames split it. */
const ACTIONS_GAP_PX = 6;

/**
 * Below this measured band width one row cannot hold the identity, the chip, the actions and even the
 * selected page's labelled tab (a 1440 window with a companion open leaves ~600): the page tabs take
 * their own row under the identity instead of collapsing into More alone. The lab's narrowest
 * one-row header (FIT, a 1180 window) is a band of about this width with all six labelled tabs.
 */
const TWO_ROW_BAND_WIDTH_PX = 720;

/** The key a Project's plugin tab lends its actions under and this header claims them by (D11). */
export function projectPageActionsKey(scopeId: string): string {
  return `project-page-actions:${scopeId}`;
}

/**
 * The Project page header (12s1, lab `p-overview` HOME/FIT): the Project's name, the checkout chip,
 * the six page tabs on one route-owned selection, then New session and the Project's `⋯`. Tabs that
 * no longer fit the measured band move behind More; Context stays reachable there (D44).
 */
export const ProjectShellHeader = React.memo(function ProjectShellHeader(
  props: Readonly<{
    projectName: string;
    checkout: ProjectShellCheckout | null;
    pages: readonly ProjectShellPage[];
    activePage: string;
    onSelectPage: (page: string) => void;
    overflowPages?: readonly ProjectShellPage[];
    orderedPageIds?: readonly string[];
    onCustomizeTabs?: () => void;
    /** The placement owner's catalog and writer; the header only presents its menu and reorder. */
    placement?: Readonly<{
      items: readonly NavigationPlacementItem[];
      preferences: NavigationPlacementPreferences;
      scope: EntityDragScopeV1 | null;
      onChange: (preferences: NavigationPlacementPreferences) => void | Promise<boolean>;
    }>;
    changeCount?: number;
    onNewSession: (() => void) | null;
    menuActions: readonly PageHeaderMenuAction[];
    /**
     * The key the shown page lends its actions under (`PageActionsLendScope`): a plugin tab's primary becomes this
     * header's + and its ⋯ rows join this header's ⋯, with New session moving there (D11).
     */
    pageActionsKey?: string;
    look?: React.ReactNode;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const environmentNavigation = usePresentedDetailNavigationChrome()?.pageKind === 'environment';
  const atmosphereBoundary = useAtmosphereBandBoundary();
  // Over atmosphere art (the picture band, or the planet behind the band) the page tabs sit on their
  // segmented track: legible through material, never through a halo or a pocket in the picture, and
  // never printed straight over the planet's dots (atmosphere DIRECTION, reading rules).
  const pictureShown = useAtmospherePictureShown();
  const overArt = atmosphereBoundary != null && (pictureShown || atmosphereBoundary.planet === true);
  // The picture band's room belongs to the band from its first paint (the owner says a picture is chosen),
  // never to the picture's arrival: the page below does not move when it lands.
  const pictureRoom = atmosphereBoundary?.pictureRoom === true;
  const height = useHeaderHeight();
  const maxWidthStyle = useLayoutMaxWidthStyle();
  const [bandWidth, setBandWidth] = React.useState<number | null>(null);
  const compact = bandWidth !== null && bandWidth < COMPACT_BAND_WIDTH_PX;
  const twoRows = bandWidth !== null && bandWidth < TWO_ROW_BAND_WIDTH_PX;
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      const width = event.nativeEvent.layout.width;
      setBandWidth((current) => (current === width ? current : width));
      atmosphereBoundary?.onLayout(event);
    },
    [atmosphereBoundary],
  );
  const renderTab = React.useCallback(
    (page: ProjectShellPage): SegmentedTab<string> => ({
        id: page.id,
        label: page.title,
        icon: (
          <Icon
            name={page.icon}
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
        ),
        disabled: page.disabledReason !== null,
        ...(page.disabledReason ? { unavailableReason: page.disabledReasonCode ? page.disabledReason
          : resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: page.disabledReason }).body } : {}),
        ...(page.count ? { count: page.count } : page.id === 'changes' && (props.changeCount ?? 0) > 0
          ? { count: String(props.changeCount) } : {}),
      }),
    [theme.colors.text.secondary, props.changeCount],
  );
  const tabs = React.useMemo(() => props.pages.map(renderTab), [props.pages, renderTab]);
  const overflowTabs = React.useMemo(() => props.overflowPages?.map(renderTab), [props.overflowPages, renderTab]);
  const testID = props.testID ?? 'project-shell-header';
  const pointer = useHoverCapablePrimaryPointer();
  // One + and one ⋯: the shown page's primary takes the +, and New session joins its ⋯ rows here.
  const pageActionsKey = props.pageActionsKey ?? null;
  const pagePrimary = useClaimedStackHeaderActions({ claimKey: pageActionsKey, drawsMenuRows: true });
  const pageMenuRows = useLentHeaderMenuRows({ claimKey: pageActionsKey });
  const pageOwnsPrimary = pagePrimary != null;
  const onNewSession = props.onNewSession;
  const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => {
    const newSession: readonly PageHeaderMenuAction[] = pageOwnsPrimary && onNewSession
      ? [{ id: 'newSession', title: t('projects.open.newSession'), testID: `${testID}.menu.newSession`, onSelect: onNewSession }] : [];
    return pageMenuRows === null && newSession.length === 0 ? props.menuActions
      : [...(pageMenuRows ?? []), ...newSession, ...props.menuActions];
  }, [onNewSession, pageMenuRows, pageOwnsPrimary, props.menuActions, testID]);
  const binding = React.useMemo(() => {
    const placement = props.placement;
    if (!placement) return null;
    const ordered = resolveNavigationPlacements(placement.items, placement.preferences).ordered;
    const tabIds = new Set(props.pages.map(page => page.id));
    // An opened More page joins the bar through SegmentedTabBar's existing selected-tab promotion.
    if (props.overflowPages?.some(page => page.id === props.activePage)) tabIds.add(props.activePage);
    const items = ordered.filter(item => tabIds.has(item.id));
    const ids = items.map(item => item.id);
    return buildPlacementReorderBinding({ scope: placement.scope, dragSurfaceId: 'projectTabBar.header', axis: 'horizontal',
      items, moveIdsOf: () => ids, orderedIds: ordered.map(item => item.id),
      preferences: placement.preferences, address: 'projectTabBar', onChange: placement.onChange });
  }, [props.placement, props.pages, props.overflowPages, props.activePage]);
  const wrapTab = React.useCallback((id: string, tab: React.ReactElement) => (
    <EntityFlatReorderRow id={id}>{() => tab}</EntityFlatReorderRow>
  ), []);
  const menuAnchorRef = React.useRef<unknown>(null);
  // DropdownMenu may deliver its selection after dismissal; retain the chosen tab beside its anchor.
  const menuPageRef = React.useRef<string | null>(null);
  const [menuPageId, setMenuPageId] = React.useState<string | null>(null);
  const openTabMenu = React.useCallback((id: string, anchor: React.ElementRef<typeof Pressable> | null) => {
    menuAnchorRef.current = anchor;
    menuPageRef.current = id;
    setMenuPageId(id);
  }, []);
  const closeTabMenu = React.useCallback((open: boolean) => { if (!open) setMenuPageId(null); }, []);
  const menuPage = props.placement?.items.find(item => item.id === menuPageId);
  const menu = menuPage && props.placement ? buildNavigationPlacementMenu({ item: menuPage,
    preferences: props.placement.preferences, onChange: props.placement.onChange, onCustomize: props.onCustomizeTabs }) : null;
  const selectTabMenu = React.useCallback((id: string) => {
    const placement = props.placement;
    const item = placement?.items.find(item => item.id === menuPageRef.current);
    setMenuPageId(null);
    if (placement && item) return buildNavigationPlacementMenu({ item, preferences: placement.preferences,
      onChange: placement.onChange, onCustomize: props.onCustomizeTabs }).onSelect(id);
  }, [props.placement, props.onCustomizeTabs]);

  const identityNode = (
    <View style={styles.identity}>
      <Icon
        name="folder"
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
      <Text
        numberOfLines={1}
        style={[styles.name, { color: theme.colors.text.primary }]}
        accessibilityRole="header"
      >
        {props.projectName}
      </Text>
    </View>
  );
  const chipNode = props.checkout ? (
    <ProjectCheckoutChip
      checkout={props.checkout}
      compact={compact}
      testID={`${testID}.checkout`}
    />
  ) : null;
  const pageTabBar = (
    <SegmentedTabBar
      presentation={overArt ? 'segmented' : 'plain'}
      glassTrack={overArt}
      // Page tabs keep their names on the track too: a segmented bar whose tabs all carry a glyph
      // would otherwise draw glyphs alone, whatever the room.
      iconPlacement="leading"
      segmentSizing="content"
      overflow={{ label: t('common.more'), testID: `${testID}.pages.more`, items: overflowTabs, orderedIds: props.orderedPageIds,
        actions: props.onCustomizeTabs ? [{ id: 'customize', label: t('navigationPlacement.customizeTabs'),
          icon: <Icon name="sliders-horizontal" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
          testID: `${testID}.pages.more.customize`, onPress: props.onCustomizeTabs }] : undefined }}
      tabs={tabs}
      activeTabId={props.activePage}
      onSelectTab={props.onSelectPage}
      accessibilityLabel={t('projects.pages.label')}
      testIDPrefix={`${testID}.pages`}
      wrapTab={binding && pointer ? wrapTab : undefined}
      onTabContextMenu={props.placement ? openTabMenu : undefined}
    />
  );
  const pageTabs = environmentNavigation ? null : <>
    {binding ? <EntityFlatReorderList binding={binding} axis="horizontal" testID={`${testID}.pages.reorder`}>{pageTabBar}</EntityFlatReorderList> : pageTabBar}
    {menu && menuPage ? <ContextMenu testID={`${testID}.pages.menu`} anchorRef={menuAnchorRef} open={menuPageId !== null}
      onOpenChange={closeTabMenu} items={menu.items} onSelect={selectTabMenu} separateCategories
      popoverAccessibilityLabel={menuPage.menuTitle ?? menuPage.title}
      header={<Text style={{ padding: theme.space.s12, color: theme.colors.text.secondary }}>{menuPage.menuTitle ?? menuPage.title}</Text>} /> : null}
  </>;
  const actionsNode = (
    <View style={styles.actions}>
      {props.look}
      {pageOwnsPrimary ? pagePrimary : props.onNewSession ? (
        compact ? (
          <IconButton
            testID={`${testID}.newSession`}
            iconName="plus"
            variant="plain"
            accessibilityLabel={t('projects.open.newSession')}
            tooltip={t('projects.open.newSession')}
            interactiveTargetGapPx={ACTIONS_GAP_PX}
            onPress={props.onNewSession}
          />
        ) : (
          <RoundButton
            testID={`${testID}.newSession`}
            size="small"
            display="secondary"
            title={t('projects.open.newSession')}
            leading={
              <Icon
                name="plus"
                size={ICON_SIZE.xs}
                color={theme.colors.text.primary}
              />
            }
            onPress={props.onNewSession}
          />
        )
      ) : null}
      {menuActions.length > 0 ? (
        <PageHeaderMenu actions={menuActions} testID={`${testID}.menu`} interactiveTargetGapPx={ACTIONS_GAP_PX} />
      ) : null}
      {/* "Hide project": the main column's own header holds it (lab ade-shell HB). */}
      <PaneMainHideButton testID={`${testID}.hideMain`} interactiveTargetGapPx={ACTIONS_GAP_PX} />
    </View>
  );

  return (
    <View
      testID={testID}
      ref={atmosphereBoundary?.ref}
      onLayout={onLayout}
      style={[
        styles.band,
        twoRows ? styles.bandTwoRows : null,
        maxWidthStyle,
        { minHeight: height, borderBottomColor: theme.colors.border.subtle },
        pictureRoom ? styles.bandOverPicture : null,
      ]}
    >
      {twoRows ? (
        <>
          <View style={styles.bandRow}>
            {identityNode}
            {chipNode}
            <View style={styles.grow} />
            {actionsNode}
          </View>
          {pageTabs ? <View style={styles.pagesRow}>{pageTabs}</View> : null}
        </>
      ) : (
        <>
          {identityNode}
          {chipNode}
          <View style={styles.tabs}>{pageTabs}</View>
          {actionsNode}
        </>
      )}
    </View>
  );
});

/**
 * The checkout chip: which machine and branch the whole page follows, and the exact choices behind it.
 * `row` is the phone's full-width field under the navigation bar (lab `p-overview` HOMEp).
 */
export const ProjectCheckoutChip = React.memo(function ProjectCheckoutChip(
  props: Readonly<{
    checkout: ProjectShellCheckout;
    compact: boolean;
    presentation?: 'chip' | 'row';
    testID: string;
  }>,
) {
  const row = props.presentation === 'row';
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);
  const branch = props.checkout.branch;
  const label = branch
    ? t('projects.checkouts.chipLabel', {
        machine: props.checkout.machineName,
        branch,
      })
    : props.checkout.machineName;
  return (
    <DropdownMenu
      testID={`${props.testID}.menu`}
      open={open}
      onOpenChange={setOpen}
      items={props.checkout.choices}
      selectedId={
        props.checkout.choices.find((choice) => choice.checked)?.id ?? null
      }
      onSelect={(id) => {
        setOpen(false);
        props.checkout.onSelect(id);
      }}
      placement="bottom"
      matchTriggerWidth={false}
      trigger={({ toggle }) => (
        <Pressable
          testID={props.testID}
          onPress={toggle}
          onFocus={(event) =>
            setFocusVisible(isHappierFocusVisible(event?.target))
          }
          onBlur={() => setFocusVisible(false)}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          style={({
            pressed,
            hovered,
          }: {
            pressed: boolean;
            hovered?: boolean;
          }) => [
            styles.chip,
            props.compact && !row ? styles.chipCompact : null,
            row ? styles.row : null,
            HAPPIER_FOCUS_RING_DELEGATED_STYLE,
            {
              borderColor: theme.colors.border.default,
              backgroundColor:
                open || hovered || pressed
                  ? theme.colors.surface.selected
                  : theme.colors.surface.base,
            },
            happierFocusRingStyle({
              visible: focusVisible,
              color: theme.colors.border.focus,
            }),
          ]}
        >
          {props.compact && branch ? null : (
            <>
              <Icon
                name={props.checkout.machineIcon}
                size={row ? ICON_SIZE.sm : ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.chipText,
                  row ? styles.rowText : null,
                  // Without a branch the machine is the chip's whole name.
                  {
                    color: branch
                      ? theme.colors.text.secondary
                      : theme.colors.text.primary,
                  },
                ]}
              >
                {row && branch
                  ? `${props.checkout.machineName} ·`
                  : props.checkout.machineName}
              </Text>
            </>
          )}
          {row || !branch ? null : (
            <Icon
              name="git-branch"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
          )}
          {branch ? (
            <Text
              numberOfLines={1}
              style={[
                styles.chipText,
                styles.chipBranch,
                row ? styles.rowText : null,
                { color: theme.colors.text.primary },
              ]}
            >
              {branch}
            </Text>
          ) : null}
          {row ? <View style={styles.grow} /> : null}
          <Icon
            name="caret-down"
            size={row ? ICON_SIZE.xs : 12}
            color={theme.colors.text.tertiary}
          />
        </Pressable>
      )}
    />
  );
});

/** The room a picture band opens above the header (lab `at2-project-pageH`). */
const PICTURE_BAND_TOP_INSET_PX = 128;

const styles = StyleSheet.create(() => ({
  band: {
    width: '100%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minWidth: 0,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 220,
  },
  name: {
    ...Typography.default('semiBold'),
    fontSize: HEADER_BAND_TITLE_TEXT.fontSize,
    flexShrink: 1,
  },
  tabs: { flex: 1, minWidth: 0, marginLeft: 4 },
  // Over a picture the band keeps the lab's proportion (about 220 px at 1440, lab at2-project-pageH):
  // the picture opens above the header, so the title and tabs sit at the band's foot on its dissolve
  // instead of the picture shrinking to a coloured stripe behind them.
  bandOverPicture: { paddingTop: PICTURE_BAND_TOP_INSET_PX },
  // Two rows: the identity row, then the page tabs on the band's own edges.
  bandTwoRows: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 0,
    paddingVertical: 4,
  },
  bandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    minHeight: 44,
  },
  pagesRow: { flexDirection: 'row', minWidth: 0, paddingBottom: 4 },
  grow: { flex: 1 },
  // The phone row is a field at the page control height (a finger reaches it through its own
  // press area), the content width, a card's radius.
  row: {
    height: HAPPIER_PAGE_METRICS.controlHeightPx,
    maxWidth: '100%',
    alignSelf: 'stretch',
    borderRadius: GROUPED_SURFACE_RADIUS_PX,
    paddingHorizontal: 14,
    gap: 8,
  },
  rowText: { ...Typography.default(), ...happierPageTextMetrics('rowTitle') },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ACTIONS_GAP_PX,
    flexShrink: 0,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height:
      HAPPIER_SEGMENTED_METRICS.plain.paddingVerticalPx * 2 +
      HAPPIER_SEGMENTED_METRICS.plain.labelSlotPx,
    paddingHorizontal: 9,
    borderRadius: HAPPIER_SEGMENTED_METRICS.plain.radiusPx,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: 320,
  },
  // A compact band gives its room to the page tabs first: a long branch ellipsizes before a tab moves
  // behind More (lab `p-overview` FIT keeps five labelled tabs beside a branch-only chip).
  chipCompact: { maxWidth: 180 },
  chipText: {
    ...Typography.default(),
    fontSize: HAPPIER_SEGMENTED_METRICS.plain.labelFontSizePx,
    flexShrink: 1,
  },
  chipBranch: { ...Typography.default('semiBold') },
}));
