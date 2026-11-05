import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import { Button, IconButton } from './Button.js';
import type { CollectionHeaderSlots } from './Collection.js';
import { Select, type SelectOption } from './Form.js';
import { Icon } from './Icon.js';
import { Row, Stack } from './Layout.js';
import { Menu, SheetMenu, type MenuGroup, type MenuItem, type MenuRadioGroup } from './Overlay.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { HappierTextActionEdgeContext } from '../presentation/interaction/textActionEdge.js';
import { Status } from './Status.js';
import type { TextTone } from './Text.js';

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

/** The list's freshness, said in words. A `muted` tone is the healthy, quiet state. */
export type CollectionToolbarFreshness = Readonly<{
  tone: TextTone;
  label: string;
  pulsing?: boolean;
  indicator?: boolean;
}>;

export type CollectionToolbarProps = Readonly<{
  /** The Collection's own pieces from a `header` render; omitted outside a Collection (the page could not be read). */
  slots?: CollectionHeaderSlots;
  /** Which lens the reader looks through (a saved-view picker). It leads the controls at every width. */
  lens?: ReactNode;
  /**
   * What narrows and orders the list. On a wide page `render()` stands in the row (a Filters menu, an Order
   * picker). On a phone they fold behind one round Filters button, counted, that opens `sheet` as the shared bottom
   * sheet: the same grouped rows the wide Filters menu offers (checkbox groups; Order as a radio group), applying
   * as they are touched, with a quiet Clear and one primary "Show N results" pinned under them.
   */
  refine?: Readonly<{
    label: string;
    /** How many narrowings are in force; said in the folded button's name and drawn as its count. */
    activeCount?: number;
    render: () => ReactNode;
    sheet: Readonly<{
      /** Named groups of `checkbox` and `radio` rows, drawn with their names, as the wide menu draws them. */
      groups: readonly MenuGroup[];
      /** The controlled choice of each radio group (Order). */
      radioGroups?: readonly MenuRadioGroup[];
      onSelect: (id: string) => void;
      /** Offered only while something is narrowed. */
      clear?: Readonly<{ label: string; onPress: () => void }>;
      /** The one primary control ("Show 12 results"); it only closes the sheet, since every choice already applied. */
      showResultsLabel: string;
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
 * Wide: one calm row — the page's name, the search, the lens and the narrowing controls lead; the freshness,
 * Refresh, ⋯ and the arrangement switch trail.
 *
 * Phone (lab `merged-list-phone`): the search with two round buttons beside it — Filters (narrowing and order, as
 * one form) and ⋯ (Refresh carrying the freshness, then the page's actions) — and one row with the lens on the
 * left and the arrangement switch on the right. A healthy list stays quiet there; a list that is refreshing or
 * not current says so in that row, so it is never only inside a menu.
 */
export function CollectionToolbar(props: CollectionToolbarProps): ReactElement {
  const provided = useContext(CollectionToolbarCompactContext);
  const chrome = useHappierPageChromeInternal();
  const compact = provided ?? chrome?.showsTitle === true;
  return compact ? <CompactToolbar {...props} /> : <WideToolbar {...props} />;
}

function WideToolbar(props: CollectionToolbarProps): ReactElement {
  const { slots, freshness, refresh } = props;
  const chrome = useHappierPageChromeInternal();
  const fit = useContext(CollectionToolbarOverflowContext);
  const { spacing } = usePluginTheme();
  const rowRef = useRef<ComponentRef<typeof View>>(null);
  const leadRef = useRef<ComponentRef<typeof View>>(null);
  const trailRef = useRef<ComponentRef<typeof View>>(null);
  // A delivered layout event can describe a box before its siblings settled. Read all three current widths
  // together, including every control in both clusters, rather than mixing independently cached heights.
  // The leading cluster grows into its line's free room: when the trailing cluster wraps, the lead fills that
  // line and their widths plus the shared gap exceed the row. Controls may still wrap inside either cluster.
  const measure = () => {
    const row = rowRef.current;
    const lead = leadRef.current;
    const trail = trailRef.current;
    if (row === null || lead === null || trail === null) return;
    const widths: Partial<Record<'row' | 'lead' | 'trail', number>> = {};
    // In-window measurement preserves fractional web widths; `measure` rounds each box independently.
    const read = (name: keyof typeof widths, box: ComponentRef<typeof View>) => box.measureInWindow((_x, _y, width) => {
      widths[name] = width;
      const { row: rowWidth, lead: leadWidth, trail: trailWidth } = widths;
      if (rowWidth === undefined || leadWidth === undefined || trailWidth === undefined || rowWidth <= 0) return;
      if (leadWidth + trailWidth + spacing.small > rowWidth) fit?.overflow(rowWidth);
      else fit?.width(rowWidth);
    });
    read('row', row);
    read('lead', lead);
    read('trail', trail);
  };
  // It leads with the add glyph the folded toolbar's round "+" shows, so the one primary reads the same at every width.
  const primary = props.primary === undefined ? null : <PrimaryControl primary={props.primary} folded={false} />;
  return (
    <View
      ref={rowRef}
      style={[wideRowStyle, { gap: spacing.small, justifyContent: 'space-between' }]}
      onLayout={measure}
      testID={props.testID}
    >
      <View ref={leadRef} style={[wideRowStyle, leadStyle, { gap: spacing.small }]}
        onLayout={measure}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:lead` })}>
        {slots?.title ?? null}
        {slots?.search ?? null}
        {props.lens ?? null}
        {props.refine?.render() ?? null}
        {slots?.selection ?? null}
        {props.accessory ?? null}
      </View>
      {/* It wraps too: a narrow window would otherwise push the arrangement switch off the right edge. Bounded by
          the toolbar's width, or a wrapping row sized to its content never has a reason to wrap. */}
      <View ref={trailRef} style={[wideRowStyle, trailStyle, { gap: spacing.xsmall }]}
        onLayout={measure}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:trail` })}>
        {freshness == null ? null : (
          <Status
            tone={freshness.tone}
            pulsing={freshness.pulsing}
            indicator={freshness.indicator}
            label={freshness.label}
          />
        )}
        {refresh === undefined ? null : (
          <IconButton
            icon={<Icon name="refresh" />}
            accessibilityLabel={refresh.label}
            busy={refresh.busy}
            disabled={refresh.disabled}
            onPress={refresh.onPress}
          />
        )}
        <MoreMenu {...props} folded={false} />
        <Views views={props.views} compact={false} />
        {/* The host's page actions take the primary in their place, as a page header's actions do (route
            controls, then the page's own, then the column's Hide last). */}
        {slots?.pageActions != null && chrome?.renderNavigationActions !== undefined
          ? chrome.renderNavigationActions(primary)
          : <>{slots?.pageActions ?? null}{primary}</>}
      </View>
    </View>
  );
}

function CompactToolbar(props: CollectionToolbarProps): ReactElement {
  const { slots, freshness, refine } = props;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const fit = useContext(CollectionToolbarOverflowContext);
  // The widths the folded row can still see of what the wide row draws: the lens as drawn here, and the sizes of
  // the rest. When any of them gets smaller the wide row may fit again (`CollectionToolbarFitReport.shrank`).
  const [widths, setWidths] = useState<Partial<Record<'title' | 'lens' | 'selection' | 'accessory' | 'pageActions', number>>>({});
  const measured = (slot: keyof typeof widths, content: ReactNode, style: HappierPortableStyle = compactLensStyle) => content == null ? null : (
    <View style={style} onLayout={(event) => {
      const width = Math.round(event.nativeEvent.layout.width);
      setWidths((previous) => previous[slot] === width ? previous : { ...previous, [slot]: width });
    }}>{content}</View>
  );
  const wideContent = [
    props.lens == null ? 0 : widths.lens ?? 0,
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
    const sizes = contentKey.split(',').map(Number);
    const previous = seen.current;
    seen.current = sizes;
    if (previous !== null && sizes.some((size, index) => size < previous[index]!)) fit?.shrank();
  }, [contentKey, fit]);
  const search = slots?.search ?? null;
  const filters =
    refine === undefined ? null : (
      <SheetMenu
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        trigger={refine.label}
        triggerIcon="filter"
        triggerAppearance="well"
        triggerCount={refine.activeCount}
        triggerAccessibilityLabel={
          refine.activeCount
            ? `${refine.label}: ${refine.activeCount}`
            : refine.label
        }
        groups={refine.sheet.groups}
        radioGroups={refine.sheet.radioGroups ?? []}
        showGroupLabels
        onSelect={refine.sheet.onSelect}
        sheet={{
          title: refine.label,
          footer: (
            <Row gap="small" align="center" justify="flex-end" style={sheetFooterStyle}>
              {refine.sheet.clear === undefined ? null : (
                <Button title={refine.sheet.clear.label} variant="plain" onPress={refine.sheet.clear.onPress} />
              )}
              <Button title={refine.sheet.showResultsLabel} variant="primary" onPress={() => setFiltersOpen(false)} />
            </Row>
          ),
        }}
      />
    );
  const buttons = (
    <>
      {filters}
      <MoreMenu {...props} folded />
      {props.primary === undefined ? null : <PrimaryControl primary={props.primary} folded />}
    </>
  );
  // Healthy is quiet here: the words stay one tap away, under Refresh in ⋯.
  const said =
    freshness == null || freshness.tone === 'muted' ? null : freshness;
  const head = slots?.title != null || search !== null;
  // Select is an action on the list, as Filters and ⋯ are: it ends the search row, where the search gives way to it,
  // and never shares the lens row, whose segmented lens and switch leave it no room on a phone (it wrapped mid-word).
  const selection = measured('selection', slots?.selection, compactSelectionStyle);
  // Ending the search row, its words stand on the toolbar's trailing edge, as the switch below ends on it.
  const trailingSelection = selection === null ? null
    : <HappierTextActionEdgeContext.Provider value="end">{selection}</HappierTextActionEdgeContext.Provider>;
  return (
    <Stack gap="small" testID={props.testID} onLayout={(event) => fit?.width(event.nativeEvent.layout.width)}>
      {head ? (
        <Row gap="small" align="center">
          {measured('title', slots?.title)}
          {search}
          {buttons}
          {trailingSelection}
        </Row>
      ) : null}
      <Row gap="small" align="center">
        {/* A transient accessory wraps under the lens instead of covering it. */}
        <Row gap="small" wrap align="center" style={compactLeadStyle}>
          {measured('lens', props.lens, compactLensStyle)}
          {head ? null : selection}
          {measured('accessory', props.accessory)}
        </Row>
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
        <Views views={props.views} compact />
        {head ? null : buttons}
        {measured('pageActions', slots?.pageActions)}
      </Row>
    </Stack>
  );
}

function PrimaryControl(props: Readonly<{ primary: NonNullable<CollectionToolbarProps['primary']>; folded: boolean }>): ReactElement {
  const { primary, folded } = props;
  const [open, setOpen] = useState(false);
  const testID = primary.testID === undefined ? {} : { testID: primary.testID };
  if (primary.menu !== undefined) {
    return (
      <Menu open={open} onOpenChange={setOpen} placement="bottom" trigger={primary.label} triggerIcon="add"
        triggerAppearance={folded ? 'well' : 'primary'} triggerAccessibilityLabel={primary.label}
        items={primary.menu.items} onSelect={primary.menu.onSelect} {...testID} />
    );
  }
  return folded
    ? <IconButton icon={<Icon name="add" />} appearance="well" accessibilityLabel={primary.label} onPress={primary.onPress} {...testID} />
    : <Button title={primary.label} variant="primary" icon={<Icon name="add" size="small" />} onPress={primary.onPress} {...testID} />;
}

function MoreMenu(
  props: CollectionToolbarProps & Readonly<{ folded: boolean }>,
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
          ...(freshness == null ? {} : { subtitle: freshness.label }),
          ...(refresh.disabled === true || refresh.busy === true
            ? { disabled: true }
            : {}),
        };
  const items = [
    ...(refreshItem === null ? [] : [refreshItem]),
    ...(more?.items ?? []),
  ];
  if (items.length === 0) return null;
  const label = more?.label ?? refresh?.label ?? '';
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerIcon="more"
      {...(folded ? { triggerAppearance: 'well' as const } : {})}
      triggerAccessibilityLabel={label}
      items={items}
      onSelect={(id) => {
        if (id === REFRESH_ITEM_ID) refresh?.onPress();
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
  flexShrink: 1,
  flexBasis: 'auto',
  minWidth: 0,
};
// It keeps the toolbar's trailing edge when it wraps below the leading controls (a list narrowed beside a detail
// pane): freshness, Refresh, the switch and Run on stay where the eye finds them, never stranded on the left.
const trailStyle: HappierPortableStyle = { maxWidth: '100%', minWidth: 0, marginLeft: 'auto', justifyContent: 'flex-end' };
const compactLensStyle: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
/** A control's words never break inside the folded toolbar; search gives way. */
const compactSelectionStyle: HappierPortableStyle = { flexShrink: 0 };
const compactLeadStyle: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
/** The sheet's quiet Clear and its one primary end the footer together. */
const sheetFooterStyle: HappierPortableStyle = { flexGrow: 1 };
/** The space between the lens and the switch; a freshness that needs saying ends there, truncating first. */
const compactFreshnessStyle: HappierPortableStyle = {
  flex: 1,
  minWidth: 0,
  alignItems: 'flex-end',
};
