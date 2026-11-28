import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import { useHappierUiAccessibility } from '../environment/context.js';
import { HAPPIER_SEGMENTED_METRICS } from '../presentation/form/SegmentedChoice.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import { HappierStatus } from '../presentation/status/Status.js';
import { HappierText } from '../presentation/text/Text.js';
import { useHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Button, IconButton } from './Button.js';
import type { CollectionHeaderSlots } from './Collection.js';
import { Select, type SelectOption } from './Form.js';
import { Icon } from './Icon.js';
import { Row } from './Layout.js';
import { ListCollectionSearchActionContext } from './listCollectionHeader.js';
import { HappierTextActionEdgeContext } from '../presentation/interaction/textActionEdge.js';
import {
  Menu, SheetMenu, type MenuGroup, type MenuItem, type MenuRadioGroup, type SheetMenuContentControls,
} from './Overlay.js';
import { Status } from './Status.js';
import type { TextTone } from './Text.js';
import { usePluginTheme } from './PluginUiProvider.js';

/**
 * Whether the Collection around a toolbar is phone-narrow. Collection provides it from its measured width (and,
 * before the first measurement, from the host's phone navigation header), so the toolbar composes once, for the
 * width it is actually drawn at.
 *
 * @internal Provided only by `Collection`.
 */
export const CollectionToolbarCompactContext = createContext<boolean | null>(
  null,
);

/**
 * How the toolbar tells Collection whether its one wide row fits. Widths are the toolbar row's own, from its layout.
 *
 * `width`: the room the toolbar has, wide or folded, so a folded toolbar learns when the window gives it enough again.
 *
 * `overflow`: the trailing controls wrapped under the leading ones at this width. Collection then folds at that width
 * (and anything narrower), measured from the page's real controls rather than from a guessed width.
 *
 * `shrank`: while folded, something the wide row draws got smaller (a shorter view name or freshness, a selection or
 * accessory gone). What the row needed is no longer known, so Collection forgets it and the wide row measures itself
 * again; if it still does not fit it reports `overflow` and folds, so nothing flips back and forth.
 *
 * @internal Provided only by `Collection`.
 */
export type CollectionToolbarFitReport = Readonly<{
  width: (widthPx: number) => void;
  overflow: (widthPx: number) => void;
  shrank: () => void;
}>;
export const CollectionToolbarOverflowContext = createContext<CollectionToolbarFitReport | null>(null);

/**
 * A phone main screen's large title takes the folded toolbar's page actions (⋯ and +) onto its own line, beside the
 * Machine and the magnifier, as core's `MainScreenHeader` draws them. The toolbar lends what it would have drawn on
 * its search line; the title line draws whatever was lent last. `collapsesSearch`: the search sits behind the title
 * line's magnifier, so its filters open from the field once it is open, never from a round button beside it.
 *
 * @internal Provided only by `Collection`.
 */
export type CollectionTitleLineLend = Readonly<{
  collapsesSearch: boolean;
  set: (actions: ReactNode) => void;
  subscribe: (listener: () => void) => () => void;
  read: () => ReactNode;
}>;
export const CollectionTitleLineLendContext = createContext<CollectionTitleLineLend | null>(null);

export function createCollectionTitleLineLend(collapsesSearch: boolean): CollectionTitleLineLend {
  let lent: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    collapsesSearch,
    set: (actions) => {
      if (actions === lent) return;
      lent = actions;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    read: () => lent,
  };
}

/** The title line's place for what the toolbar lent it. */
export function CollectionTitleLineLent(props: Readonly<{ lend: CollectionTitleLineLend }>): ReactNode {
  return useSyncExternalStore(props.lend.subscribe, props.lend.read, props.lend.read);
}

/** The list's freshness, said in words. A `muted` tone is the healthy, quiet state. */
export type CollectionToolbarFreshness = Readonly<{
  tone: TextTone;
  label: string;
  pulsing?: boolean;
  indicator?: boolean;
  action?: ReactNode;
  /** The existing More item that carries this label when folded, instead of Refresh. */
  foldedItemId?: string;
}>;

export type CollectionToolbarProps = Readonly<{
  /** The Collection's own pieces from a `header` render; omitted outside a Collection (the page could not be read). */
  slots?: CollectionHeaderSlots;
  /** Which lens the reader looks through (a saved-view picker). It leads the controls at every width. */
  lens?: ReactNode;
  /**
   * A short choice that scopes what the lens shows (whose tasks), as one segmented control. It leads the lens on the
   * wide row. Folded it stands beside the lens where the line holds both and the arrangement switch, and otherwise takes
   * the line under them, so the switch never ends up on a line of its own.
   */
  scope?: ReactNode;
  /**
   * What narrows and orders the list (lab `spfield` B). The filters open from one funnel at the end of the search
   * field, at every width: `sheet` is the page's narrowing form, anchored under the field on a wide page and the
   * shared bottom sheet on a phone. What is on is said by the Collection's token line under the toolbar, never by
   * chips at rest. `render()` is the wide row's other narrowing controls (an Order picker); folded they join ⋯ as
   * `foldedChoices`. A page without a search keeps `render()` on the wide row and a round, counted Filters button
   * when folded.
   */
  refine?: Readonly<{
    label: string;
    /** How many narrowings are in force; said in the funnel's name, and drawn as a count only on a round button. */
    activeCount?: number;
    render?: () => ReactNode;
    /**
     * `render()` is the whole narrowing control, standing in the wide row (a short scope switch): the funnel then
     * appears only when the toolbar folds, so the same filter never has two controls on one row.
     */
    inline?: boolean;
    sheet: Readonly<{
      /** The narrowing form (a condition editor). It applies its own edits and closes the sheet through `close`. */
      render: (controls: SheetMenuContentControls) => ReactNode;
      /** `none` when the form leads with its own title and Clear, so the sheet draws no title band over it. */
      header?: 'none';
    }>;
    /** The wide row's pickers beside Filters (Order), as named radio groups that end the folded ⋯. */
    foldedChoices?: Readonly<{
      groups: readonly MenuGroup[];
      radioGroups: readonly MenuRadioGroup[];
      onSelect: (id: string) => void;
    }>;
  }>;
  /** A transient page control beside the lens ("Done" while organizing). */
  accessory?: ReactNode;
  /**
   * The page's one primary action ("New task"). On a wide page it is the primary button that ends the row, after the
   * page's own controls and Run on; on a phone it is a round "+" beside Filters and ⋯, named by `label`.
   */
  primary?: Readonly<{ label: string; testID?: string } & (
    | { onPress: () => unknown; menu?: undefined }
    /** The action needs one choice first (Run workflow: which workflow): the primary opens it as a menu. */
    | { menu: Readonly<{ items: readonly MenuItem[]; onSelect: (id: string) => void }>; onPress?: undefined }
  )>;
  freshness?: CollectionToolbarFreshness | null;
  refresh?: Readonly<{
    label: string;
    busy?: boolean;
    disabled?: boolean;
    onPress: () => void;
  }>;
  /** The page's rare actions, behind ⋯. On a phone Refresh (with the freshness under it) leads this menu. */
  more?: Readonly<{
    label: string;
    items: readonly MenuItem[];
    onSelect: (id: string) => void;
  }>;
  /** The Collection's arrangements (List | Board). It ends the controls at every width. */
  views?: Readonly<{
    label: string;
    value: string;
    options: readonly SelectOption[];
    onChange: (value: string) => void;
  }>;
  testID?: string;
}>;

const REFRESH_ITEM_ID = 'happier-collection-toolbar:refresh';

/**
 * The one toolbar above a Collection (lab `cbar`), composed for the width it is drawn at.
 *
 * Wide: one calm row — the page's name, the search (its filter funnel at its end), the lens and the wide row's
 * other narrowing controls lead; the freshness, Refresh, ⋯ and the arrangement switch trail.
 *
 * Phone (lab `merged-list-phone`, `spfield` B): the search, its funnel at its end opening the filters as the bottom
 * sheet, with ⋯ beside it (Refresh carrying the freshness, the page's actions, then Order), then Select where the
 * list can select —
 * and one row with the lens on the left and the arrangement switch on the right. A healthy list stays quiet there; a list that is refreshing or
 * not current says so in that row, so it is never only inside a menu. A scope that does not fit in that row takes the
 * line under it. A lens that leaves the switch too little room
 * gives it the next line, still on the trailing edge; a page name that would leave the search less than its readable
 * width takes the line above the search.
 */
export function CollectionToolbar(props: CollectionToolbarProps): ReactElement {
  const provided = useContext(CollectionToolbarCompactContext);
  const chrome = useHappierPageChromeInternal();
  const compact = provided ?? chrome?.showsTitle === true;
  const lend = useContext(CollectionTitleLineLendContext);
  const lending = compact && lend !== null;
  // Folded under a large title, ⋯ and + stand on the title line, drawn there as core's title-line controls are: plain.
  const lent = !lending ? null : (
    <>
      {props.refine === undefined || lend.collapsesSearch || props.slots?.search != null ? null
        : <FilterFunnel refine={props.refine} inField={false} />}
      <MoreMenu {...props} folded plain />
      {props.primary === undefined ? null : <PrimaryControl primary={props.primary} folded plain />}
    </>
  );
  useLayoutEffect(() => { lend?.set(lent); });
  useLayoutEffect(() => () => lend?.set(null), [lend]);
  // One component and one tree for both widths: the search stays one element at one place (the first row's `search`
  // child), so a person typing keeps focus and caret while the window crosses the breakpoint. Two component types
  // here remounted the field on every fold (QA-COLLECTION r159).
  const wide = useWideToolbar(props, !compact);
  const folded = useCompactToolbar(props, compact, lending);
  const search = props.slots?.search == null ? null
    : <SearchWithFunnel key="search" search={props.slots.search} refine={props.refine} folded={compact} />;
  return compact ? folded(search) : wide(search);
}

/**
 * The one control that opens the page's filters: the funnel at the search field's end (`inField`), or, folded on a
 * page without a search, a round counted button beside ⋯. Anchored on a wide page, the shared bottom sheet on a phone.
 */
function FilterFunnel(props: Readonly<{ refine: NonNullable<CollectionToolbarProps['refine']>; inField: boolean }>): ReactElement {
  const { refine } = props;
  const [open, setOpen] = useState(false);
  const named = refine.activeCount ? `${refine.label}: ${refine.activeCount}` : refine.label;
  return (
    <SheetMenu
      open={open}
      onOpenChange={setOpen}
      trigger={refine.label}
      triggerIcon="filter"
      // Secondary ink, like the field's own search glyph: the toolbar's primary ("+") alone draws in full ink.
      triggerTextTone="secondary"
      {...(props.inField ? {} : { triggerAppearance: 'well' as const, triggerCount: refine.activeCount })}
      triggerAccessibilityLabel={named}
      placement="bottom"
      sheet={{ title: refine.label, ...(refine.sheet.header === undefined ? {} : { header: refine.sheet.header }) }}
      content={refine.sheet.render}
    />
  );
}

/**
 * The search slot with the filter funnel at its end, when the page's filters open from it at this width. The field
 * always sits under the provider, so its place in the tree never changes as the funnel comes and goes.
 */
function SearchWithFunnel(props: Readonly<{ search: ReactNode; refine: CollectionToolbarProps['refine']; folded: boolean }>): ReactNode {
  const funnel = props.refine === undefined || (props.refine.inline === true && !props.folded)
    ? null
    : <FilterFunnel refine={props.refine} inField />;
  return (
    <ListCollectionSearchActionContext.Provider value={funnel}>
      {props.search}
    </ListCollectionSearchActionContext.Provider>
  );
}

/** The wide row's state; its render takes the search element so the field keeps its place at every width. */
function useWideToolbar(props: CollectionToolbarProps, active: boolean): (search: ReactNode) => ReactElement {
  const { slots, freshness, refresh } = props;
  const chrome = useHappierPageChromeInternal();
  // On a host page the ⋯ goes to the host with the primary, so a header above the page that claims the page's
  // actions (a Project's header) draws both and this row draws neither; unclaimed, the host draws them here.
  const hostActions = slots?.pageActions != null && chrome?.renderNavigationActions !== undefined;
  const fit = useContext(CollectionToolbarOverflowContext);
  const theme = usePluginTheme();
  const { spacing } = theme;
  const { textScale } = useHappierUiAccessibility();
  const freshnessType = useHappierTypeRoleStyle('meta', theme);
  // A healthy freshness ("Updated just now") or a read in flight ("Refreshing") is the first thing the one row gives up:
  // its words go (Refresh still says them, and spins while it reads) before the toolbar folds, at the row width that needed it and
  // anything narrower, never cut to "R…". Words that warn are never given up.
  const quietable = freshness != null && freshness.action == null
    && (freshness.tone === 'muted' || freshness.pulsing === true);
  const viewOptions = props.views?.options;
  const canDropViewLabels = freshness != null && !quietable && viewOptions !== undefined
    && viewOptions.length > 0 && viewOptions.every((option) => option.icon !== undefined);
  const viewsKey = canDropViewLabels ? JSON.stringify([textScale, props.views?.value, viewOptions.map(({ label, icon }) => [label, icon])]) : null;
  const [viewLabelFit, setViewLabelFit] = useState<{ key: string; savings: number } | null>(null);
  const viewLabelSavings = viewsKey !== null && viewLabelFit?.key === viewsKey ? viewLabelFit.savings : 0;
  const hasFreshnessAction = freshness != null && freshness.action != null;
  const freshnessKey = hasFreshnessAction ? JSON.stringify([freshness.label, freshness.indicator, textScale, freshnessType]) : null;
  const [freshnessFit, setFreshnessFit] = useState<{ key: string; naturalWidth: number; width: number } | null>(null);
  const constrainedFreshness = freshnessKey !== null && freshnessFit?.key === freshnessKey ? freshnessFit : null;
  const naturalRow = canDropViewLabels || hasFreshnessAction;
  const [quietBelowPx, setQuietBelowPx] = useState<number | null>(null);
  // Folded, the wide row is not drawn: what it learned about its width starts over when it is drawn again.
  useEffect(() => {
    if (!active && quietBelowPx !== null) setQuietBelowPx(null);
  }, [active, quietBelowPx]);
  const quiet = quietable && quietBelowPx !== null;
  const rowRef = useRef<ComponentRef<typeof View>>(null);
  const leadRef = useRef<ComponentRef<typeof View>>(null);
  const trailRef = useRef<ComponentRef<typeof View>>(null);
  const viewsRef = useRef<ComponentRef<typeof View>>(null);
  const freshnessRef = useRef<ComponentRef<typeof View>>(null);
  // A delivered layout event can describe a box before its siblings settled. Read all three current widths
  // together, including every control in both clusters, rather than mixing independently cached heights.
  // The leading cluster grows into its line's free room: when the trailing cluster wraps, the lead fills that
  // line and their widths plus the shared gap exceed the row. Controls may still wrap inside either cluster.
  const measure = (beforePaint = false) => {
    const row = rowRef.current;
    const lead = leadRef.current;
    const trail = trailRef.current;
    if (row === null || lead === null || trail === null) return;
    const views = viewsKey !== null && viewLabelSavings === 0 ? viewsRef.current : null;
    const freshnessBox = freshnessKey === null ? null : freshnessRef.current;
    const widths: Partial<Record<'row' | 'lead' | 'trail' | 'views' | 'freshness', number>> = {};
    const heights: Partial<Record<'lead' | 'trail', number>> = {};
    // In-window measurement preserves fractional web widths; `measure` rounds each box independently.
    const record = (name: keyof typeof widths, width: number, height: number) => {
      widths[name] = width;
      if (name === 'lead' || name === 'trail') heights[name] = height;
      const { row: rowWidth, lead: leadWidth, trail: trailWidth, views: viewsWidth, freshness: freshnessWidth } = widths;
      const { lead: leadHeight, trail: trailHeight } = heights;
      if (rowWidth === undefined || leadWidth === undefined || trailWidth === undefined || rowWidth <= 0
        || leadHeight === undefined || trailHeight === undefined || (views !== null && viewsWidth === undefined)
        || (freshnessBox !== null && freshnessWidth === undefined)) return;
      // A cluster can fit its share of the row by breaking onto a second line (a pane-narrowed page): twice the height
      // of the other cluster is a wrapped row just as a trailing group below the lead is, and it folds the same way.
      const wrapped = Math.min(leadHeight, trailHeight) > 0 && Math.max(leadHeight, trailHeight) >= Math.min(leadHeight, trailHeight) * 1.5;
      const need = leadWidth + trailWidth + spacing.small;
      if (naturalRow) {
        // Refresh is already a glyph. Try icon-backed arrangements before taking any width from the freshness
        // words. The author's scope and primary keep their labels and the recovery action keeps its own width.
        const { trackPaddingPx, segmentMinWidthPx, labelSlotPx, segmentPaddingHorizontalPx } = HAPPIER_SEGMENTED_METRICS;
        const iconTrackWidth = 2 * trackPaddingPx + (viewOptions?.length ?? 0)
          * Math.max(segmentMinWidthPx, labelSlotPx.default + 2 * segmentPaddingHorizontalPx);
        const savings = viewsWidth === undefined ? viewLabelSavings : Math.max(0, viewsWidth - iconTrackWidth);
        const naturalFreshnessWidth = constrainedFreshness?.naturalWidth ?? freshnessWidth ?? 0;
        const fullNeed = need + viewLabelSavings + naturalFreshnessWidth - (freshnessWidth ?? 0);
        const compactViews = savings > 0 && fullNeed > rowWidth;
        const excess = Math.max(0, fullNeed - (compactViews ? savings : 0) - rowWidth);
        const labelWidth = naturalFreshnessWidth - excess;
        // A truncated status still needs room for words alongside its dot, on the same line.
        const readableWidth = Math.min(naturalFreshnessWidth, (Number(freshnessType.lineHeight) || 0) * textScale);
        if (wrapped || labelWidth < readableWidth) {
          fit?.overflow(rowWidth);
          return;
        }
        if (viewsKey !== null && compactViews && viewLabelSavings === 0) setViewLabelFit({ key: viewsKey, savings });
        if (!compactViews && viewLabelSavings > 0) setViewLabelFit(null);
        if (freshnessKey !== null && excess > 0 && constrainedFreshness?.width !== labelWidth) {
          setFreshnessFit({ key: freshnessKey, naturalWidth: naturalFreshnessWidth, width: labelWidth });
        } else if (excess === 0 && constrainedFreshness !== null) {
          setFreshnessFit(null);
        }
        fit?.width(rowWidth);
      } else if (wrapped || need > rowWidth) {
        if (quietable && !quiet) setQuietBelowPx(rowWidth);
        else fit?.overflow(rowWidth);
      } else {
        if (quiet && rowWidth > quietBelowPx!) setQuietBelowPx(null);
        fit?.width(rowWidth);
      }
    };
    const read = (name: keyof typeof widths, box: ComponentRef<typeof View>) => {
      if (beforePaint && 'getBoundingClientRect' in box && typeof box.getBoundingClientRect === 'function') {
        const { width, height } = box.getBoundingClientRect();
        record(name, width, height);
      } else {
        box.measureInWindow((_x, _y, width, height) => record(name, width, height));
      }
    };
    read('row', row);
    read('lead', lead);
    read('trail', trail);
    if (views !== null) read('views', views);
    if (freshnessBox !== null) read('freshness', freshnessBox);
  };
  // Giving up the words can leave every box its size (a row wrapped over several lines still fills them), so no
  // layout event follows: the row measures itself again once they are gone, and folds if it still does not fit.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const attentionLabel = naturalRow ? freshness?.label ?? null : null;
  useLayoutEffect(() => {
    if (active && attentionLabel !== null) measureRef.current(true);
  }, [active, attentionLabel, freshnessKey, viewsKey]);
  useEffect(() => {
    if (quiet) measureRef.current();
  }, [quiet]);
  // It leads with the add glyph the folded toolbar's round "+" shows, so the one primary reads the same at every width.
  const primary = props.primary === undefined ? null : <PrimaryControl primary={props.primary} folded={false} />;
  const onLayout = () => measure();
  const clusterStyle = naturalRow ? naturalClusterStyle : wideRowStyle;
  return (search) => (
    <View
      ref={rowRef}
      style={[wideRowStyle, naturalRow ? { flexWrap: 'nowrap' } : null, { gap: spacing.small, justifyContent: 'space-between' }]}
      onLayout={onLayout}
      testID={props.testID}
    >
      <View key="lead" ref={leadRef} style={[clusterStyle, leadStyle, viewLabelSavings > 0 || constrainedFreshness !== null ? { flexGrow: 0 } : null, { gap: spacing.small }]}
        onLayout={onLayout}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:lead` })}>
        {slots?.title ?? null}
        {search}
        {props.scope ?? null}
        {props.lens ?? null}
        {props.refine?.render?.() ?? null}
        {slots?.selection ?? null}
        {props.accessory ?? null}
      </View>
      {/* It wraps too: a narrow window would otherwise push the arrangement switch off the right edge. Bounded by
          the toolbar's width, or a wrapping row sized to its content never has a reason to wrap. */}
      <View key="trail" ref={trailRef} style={[clusterStyle, trailStyle, { gap: spacing.xsmall }]}
        onLayout={onLayout}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:trail` })}>
        {freshness == null || quiet ? null : hasFreshnessAction ? (
          <View style={[naturalClusterStyle, { gap: spacing.xsmall }]}>
            <View ref={freshnessRef} style={{ maxWidth: constrainedFreshness?.width }}>
              <HappierStatus
                theme={theme}
                tone={freshness.tone}
                isPulsing={freshness.pulsing}
                indicator={freshness.indicator}
                label={<HappierText variant="meta" numberOfLines={1}>{freshness.label.replace(/\.$/u, '')}</HappierText>}
                accessibilityLabel={freshness.label}
              />
            </View>
            <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <HappierText variant="meta" tone="secondary">·</HappierText>
            </View>
            <View style={{ flexShrink: 0 }}>{freshness.action}</View>
          </View>
        ) : (
          <Status tone={freshness.tone} pulsing={freshness.pulsing} indicator={freshness.indicator} label={freshness.label} />
        )}
        {refresh === undefined ? null : (
          <IconButton
            icon={<Icon name="refresh" />}
            accessibilityLabel={quiet ? `${refresh.label}, ${freshness!.label}` : refresh.label}
            busy={refresh.busy}
            disabled={refresh.disabled}
            onPress={refresh.onPress}
          />
        )}
        {hostActions ? null : <MoreMenu {...props} folded={false} />}
        {props.views === undefined ? null : (
          <View ref={viewsRef} testID={props.testID === undefined ? undefined : `${props.testID}:views`}>
            <Views views={props.views} compact={viewLabelSavings > 0} />
          </View>
        )}
        {/* The host's page actions take the primary in their place, as a page header's actions do (route
            controls, then the page's own, then the column's Hide last). */}
        {hostActions
          ? chrome?.renderNavigationActions?.(primary, undefined, {
            menu: props.more === undefined ? null : <MoreMenu {...props} folded={false} />,
            items: props.more?.items ?? [],
            onSelect: (id) => props.more?.onSelect(id),
            ...(props.primary === undefined ? {} : { primary: props.primary }),
          })
          : <>{slots?.pageActions ?? null}{primary}</>}
      </View>
    </View>
  );
}

/** The folded toolbar's state; its render takes the search element so the field keeps its place at every width. */
function useCompactToolbar(props: CollectionToolbarProps, active: boolean, lending: boolean): (search: ReactNode) => ReactElement {
  const { slots, freshness, refine } = props;
  const fit = useContext(CollectionToolbarOverflowContext);
  const { spacing } = usePluginTheme();
  const { textScale } = useHappierUiAccessibility();
  // The widths the folded row can still see of what the wide row draws: the lens as drawn here, and the sizes of
  // the rest. When any of them gets smaller the wide row may fit again (`CollectionToolbarFitReport.shrank`).
  // `buttons` (the round Filters, ⋯ and +) is the search line's own, for the room it leaves the search.
  const [widths, setWidths] = useState<Partial<Record<'title' | 'lens' | 'scope' | 'views' | 'selection' | 'accessory' | 'pageActions' | 'buttons', number>>>({});
  const [stackWidth, setStackWidth] = useState<number | null>(null);
  const measured = (slot: keyof typeof widths, content: ReactNode, style: HappierPortableStyle = compactLensStyle) => content == null ? null : (
    <View style={style} onLayout={(event) => {
      const width = Math.round(event.nativeEvent.layout.width);
      setWidths((previous) => previous[slot] === width ? previous : { ...previous, [slot]: width });
    }}>{content}</View>
  );
  const wideContent = [
    props.lens == null ? 0 : widths.lens ?? 0,
    props.scope == null ? 0 : widths.scope ?? 0,
    slots?.title == null ? 0 : widths.title ?? 0,
    slots?.pageActions == null ? 0 : widths.pageActions ?? 0,
    freshness == null ? 0 : freshness.label.length,
    props.refresh === undefined ? 0 : 1,
    slots?.selection == null ? 0 : widths.selection ?? 0,
    props.accessory == null ? 0 : widths.accessory ?? 0,
    refine === undefined ? 0 : refine.label.length + String(refine.activeCount ?? '').length,
    props.primary === undefined ? 0 : props.primary.label.length,
    props.more === undefined ? 0 : 1,
    props.views === undefined ? 0 : props.views.options.reduce((sum, option) => sum + String(option.label).length, 0),
  ];
  const seen = useRef<readonly number[] | null>(null);
  const contentKey = wideContent.join(',');
  useEffect(() => {
    // Unfolded, nothing here is drawn: the folded row measures afresh when it folds again.
    if (!active) {
      seen.current = null;
      setWidths((previous) => Object.keys(previous).length === 0 ? previous : {});
      setStackWidth(null);
      return;
    }
    const sizes = contentKey.split(',').map(Number);
    const previous = seen.current;
    seen.current = sizes;
    if (previous !== null && sizes.some((size, index) => size < previous[index]!)) fit?.shrank();
  }, [active, contentKey, fit]);
  return (search) => {
    // With a search the funnel ends the field; without one it stays a round button beside ⋯.
    const filters = refine === undefined || search !== null ? null : <FilterFunnel refine={refine} inField={false} />;
    // MoreMenu draws nothing without items or folded choices; an empty wrapper would add a gap of its own.
    const hasMore = props.refresh !== undefined || (props.more?.items.length ?? 0) > 0 || refine?.foldedChoices !== undefined;
    // Lent to the large title's line, they are drawn there rather than here.
    const buttons = lending || (filters === null && !hasMore && props.primary === undefined) ? null : (
      <>
        {filters}
        <MoreMenu {...props} folded />
        {props.primary === undefined ? null : <PrimaryControl primary={props.primary} folded />}
      </>
    );
    // Healthy is quiet here, and so is a read in flight (the wide row gives it up first too): the words stay one tap
    // away, under Refresh in ⋯, instead of being cut to a letter beside the switch. Only a list that is not current speaks.
    const said =
      freshness == null || freshness.tone === 'muted' || freshness.pulsing === true ? null : freshness;
    const head = slots?.title != null || search !== null;
    // The page's name and the search share the search line while the field keeps a readable width beside it; a list
    // narrowed beside a detail pane would leave it a few letters ("Searc"), so the name takes the line above instead.
    // Judged from the name's own width and the round buttons', never the field's, so it settles and never flips.
    const headItems = [widths.title, widths.buttons, slots?.selection == null ? undefined : widths.selection]
      .filter((width): width is number => width !== undefined);
    const titleAlone = slots?.title != null && search !== null && stackWidth !== null && widths.title !== undefined
      && stackWidth - headItems.reduce((sum, width) => sum + width, 0) - spacing.small * headItems.length
        < HAPPIER_PAGE_METRICS.toolbarSearchMinWidthPx * textScale;
    const title = measured('title', slots?.title, compactTitleStyle);
    // The scope shares the lens line while that line also holds the arrangement switch and the route controls. Judged
    // from each control's own width, as the title is, so it settles and never flips; unmeasured, it starts under the line.
    const lensItems = [widths.lens, widths.scope, widths.accessory, widths.views, widths.pageActions]
      .filter((width): width is number => width !== undefined && width > 0);
    const scopeBesideLens = stackWidth !== null && widths.scope !== undefined
      && lensItems.reduce((sum, width) => sum + width, 0) + spacing.small * lensItems.length <= stackWidth;
    const scope = measured('scope', props.scope, compactScopeStyle);
    // Select is an action on the list, as Filters and ⋯ are: it ends the search row, where the search gives way to it,
    // and never shares the lens row, whose segmented lens and switch leave it no room on a phone (it wrapped mid-word).
    const selection = measured('selection', slots?.selection, compactSelectionStyle);
    // Ending the search row, its words stand on the toolbar's trailing edge, as the switch below ends on it.
    const trailingSelection = selection === null ? null
      : <HappierTextActionEdgeContext.Provider value="end">{selection}</HappierTextActionEdgeContext.Provider>;
    return (
      <View testID={props.testID} style={[compactStackStyle, { gap: spacing.small }]}
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          fit?.width(width);
          setStackWidth((previous) => previous === width ? previous : width);
        }}>
        {titleAlone ? <View key="title" style={compactTitleLineStyle}>{title}</View> : null}
        {head ? (
          <View key="lead" style={[compactHeadRowStyle, { gap: spacing.small }]}>
            {titleAlone ? null : title}
            {search}
            {buttons === null ? null : measured('buttons', buttons, { ...compactButtonsStyle, gap: spacing.small })}
            {trailingSelection}
          </View>
        ) : null}
        {/* A lens wider than its share of the line (a segmented lens and its saved views at 308) gives the switch
            the next line, still on the trailing edge, instead of the switch being drawn over it. */}
        <Row key="lens" gap="small" align="center" wrap>
          {/* A transient accessory (an Action picker while selecting) that does not fit beside the lens takes the line
              under it, rather than the lens shrinking under the accessory drawn over it. */}
          <Row gap="small" wrap align="center" style={compactLeadStyle}>
            {measured('lens', props.lens, compactLensStyle)}
            {scopeBesideLens ? scope : null}
            {head ? null : selection}
            {measured('accessory', props.accessory)}
          </Row>
          <View style={[compactTrailStyle, { gap: spacing.small }]}>
            <View style={compactFreshnessStyle}>
              {said === null ? null : (
                <Status
                  tone={said.tone}
                  pulsing={said.pulsing}
                  indicator={said.indicator}
                  label={said.label}
                  presentation="inline"
                />
              )}
            </View>
            {measured('views', props.views === undefined ? null : <Views views={props.views} compact />, compactViewsStyle)}
            {head ? null : buttons}
            {/* The host's route controls (Run on) and the column's Hide stay one line, as they end the wide row. */}
            {measured('pageActions', slots?.pageActions, compactPageActionsStyle)}
          </View>
        </Row>
        {scope === null || scopeBesideLens ? null : <View key="scope" style={compactTitleLineStyle}>{scope}</View>}
      </View>
    );
  };
}

function PrimaryControl(props: Readonly<{ primary: NonNullable<CollectionToolbarProps['primary']>; folded: boolean; plain?: boolean }>): ReactElement {
  const { primary, folded } = props;
  const plain = props.plain === true;
  const [open, setOpen] = useState(false);
  const testID = primary.testID === undefined ? {} : { testID: primary.testID };
  if (primary.menu !== undefined) {
    return (
      <Menu open={open} onOpenChange={setOpen} placement="bottom" trigger={primary.label} triggerIcon="add"
        triggerAppearance={plain ? 'text' : folded ? 'well' : 'primary'} triggerAccessibilityLabel={primary.label}
        items={primary.menu.items} onSelect={primary.menu.onSelect} {...testID} />
    );
  }
  return plain
    ? <IconButton icon={<Icon name="add" />} accessibilityLabel={primary.label} onPress={primary.onPress} {...testID} />
    : folded
    ? <IconButton icon={<Icon name="add" />} appearance="well" accessibilityLabel={primary.label} onPress={primary.onPress} {...testID} />
    : <Button title={primary.label} variant="primary" icon={<Icon name="add" size="small" />} onPress={primary.onPress} {...testID} />;
}

function MoreMenu(
  props: CollectionToolbarProps & Readonly<{ folded: boolean; plain?: boolean }>,
): ReactElement | null {
  const [open, setOpen] = useState(false);
  const { more, refresh, freshness, folded } = props;
  const refreshItem: MenuItem | null =
    !folded || refresh === undefined
      ? null
      : {
          id: REFRESH_ITEM_ID,
          label: refresh.label,
          icon: 'refresh',
          ...(freshness == null || freshness.foldedItemId !== undefined ? {} : { subtitle: freshness.label }),
          ...(refresh.disabled === true || refresh.busy === true
            ? { disabled: true }
            : {}),
        };
  const items = [
    ...(refreshItem === null ? [] : [refreshItem]),
    ...(more?.items ?? []).map((item) => folded && freshness?.foldedItemId === item.id
      ? { ...item, subtitle: freshness.label }
      : item),
  ];
  // Folded, the wide row's pickers (Order) end the menu as named radio groups.
  const choices = folded ? props.refine?.foldedChoices : undefined;
  if (items.length === 0 && choices === undefined) return null;
  const label = more?.label ?? refresh?.label ?? '';
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerIcon="more"
      // Secondary ink: on the same glass as "+", the primary is told apart by its full ink, not by a fill.
      triggerTextTone="secondary"
      {...(folded && props.plain !== true ? { triggerAppearance: 'well' as const } : {})}
      triggerAccessibilityLabel={label}
      items={items}
      {...(choices === undefined ? {} : { groups: choices.groups, radioGroups: choices.radioGroups, showGroupLabels: true })}
      onSelect={(id) => {
        if (id === REFRESH_ITEM_ID) refresh?.onPress();
        else if (choices?.groups.some((group) => group.items.some((item) => item.id === id))) choices.onSelect(id);
        else more?.onSelect(id);
      }}
    />
  );
}

function Views(
  props: Readonly<{ views: CollectionToolbarProps['views']; compact: boolean }>,
): ReactElement | null {
  const { views } = props;
  if (views === undefined) return null;
  return (
    <Select
      label={views.label}
      presentation="segmented"
      compact={props.compact}
      value={views.value}
      options={views.options}
      onChange={(value) => {
        if (typeof value === 'string') views.onChange(value);
      }}
    />
  );
}

const wideRowStyle: HappierPortableStyle = {
  flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
  flexShrink: 1, maxWidth: '100%', minWidth: 0,
};
/** The leading controls take the toolbar's free width and wrap inside it. */
// Sized by content (name, search, lens, filters), not from zero: where that and the trailing controls do not fit on
// one line (a narrow window), the trailing controls wrap below and the search keeps the row.
const leadStyle: HappierPortableStyle = {
  flexGrow: 1,
  flexBasis: 'auto',
};
// It keeps the toolbar's trailing edge when it wraps below the leading controls (a list narrowed beside a detail
// pane): freshness, Refresh, the switch and Run on stay where the eye finds them, never stranded on the left.
const trailStyle: HappierPortableStyle = { marginLeft: 'auto', justifyContent: 'flex-end' };
// The warning fit compares the clusters' one-line widths against the row; wrapping or stretching a cluster
// first would lose the amount the layout is short by.
const naturalClusterStyle: HappierPortableStyle = { flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', flexShrink: 0 };
/** The folded toolbar's two lines, as a vertical stack (a View, so the search keeps one place at every width). */
const compactStackStyle: HappierPortableStyle = { minWidth: 0, flexDirection: 'column', flexWrap: 'nowrap' };
/** The folded toolbar's search line, as a centred horizontal stack. */
const compactHeadRowStyle: HappierPortableStyle = { minWidth: 0, flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center' };
const compactLeadStyle: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
const compactLensStyle: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
/** The page's name or switch keeps its words whole beside the search, which gives way instead. */
const compactTitleStyle: HappierPortableStyle = { flexShrink: 0 };
/** The scope keeps its words whole; the line it stands on is chosen so it fits. */
const compactScopeStyle: HappierPortableStyle = { flexShrink: 0 };
/** The arrangement switch is never squeezed by what ends its line. */
const compactViewsStyle: HappierPortableStyle = { flexShrink: 0 };
/** A line of its own (the name above the search, the scope under the lens): a row, so the control keeps its own width. */
const compactTitleLineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', minWidth: 0 };
/** The search line's round buttons, kept whole beside the field. */
const compactButtonsStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', flexShrink: 0 };
// The route controls (Run on) truncate on their own, so a tight row takes its room from them before the lens.
const compactPageActionsStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 100, minWidth: 0 };
/** A control's words never break inside the folded toolbar; the search beside it gives way instead. */
const compactSelectionStyle: HappierPortableStyle = { flexShrink: 0 };
/**
 * The switch and what ends the lens line, kept together on the trailing edge: sized by its controls, so it takes the
 * next line when the lens leaves it too little, and it fills whatever room the lens leaves on a shared line.
 */
const compactTrailStyle: HappierPortableStyle = {
  flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
  flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0, marginLeft: 'auto',
};
/** The space between the lens and the switch; a freshness that needs saying ends there, truncating first. */
const compactFreshnessStyle: HappierPortableStyle = {
  flex: 1,
  minWidth: 0,
  alignItems: 'flex-end',
};
