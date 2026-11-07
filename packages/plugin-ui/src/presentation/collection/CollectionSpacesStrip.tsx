import { memo, useCallback, useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';

/** One saved space on a strip; the list's title names the selected one, so a tab's words are its glyph's name. */
export type HappierCollectionSpacesStripItem = Readonly<{
  id: string;
  /** The tab's name for hover and assistive technology (with its shortcut, when one is bound). */
  label: string;
  /** Absent on any item, every tab shows its words: a half-iconic strip reads as broken. */
  icon?: ReactNode;
  disabled?: boolean;
}>;

/** The tab bar a strip draws: the host's sliding bar, or the public `Tabs` page strip. */
export type HappierCollectionSpacesStripTabsInput = Readonly<{
  testIDPrefix: string;
  accessibilityLabel: string;
  items: readonly HappierCollectionSpacesStripItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onTabLayout: (id: string, place: Readonly<{ x: number; width: number }>) => void;
  wrapTab?: (id: string, tab: ReactElement) => ReactNode;
}>;

/** What fades an overflowing strip at the edge that hides more; a native mask needs the host's own dependency. */
export type HappierCollectionSpacesStripEdgeMask = Readonly<{
  /** Replaces the scroller's own style: a wrapper that masks natively takes its place in the row. */
  scrollerStyle?: StyleProp<ViewStyle>;
  wrapScroller: (scroller: ReactElement) => ReactElement;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onViewportLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
}>;

const NO_EDGE_MASK: HappierCollectionSpacesStripEdgeMask = {
  wrapScroller: (scroller) => scroller,
  onScroll: () => undefined,
  onViewportLayout: () => undefined,
  onContentSizeChange: () => undefined,
};
const useNoEdgeMask = (): HappierCollectionSpacesStripEdgeMask => NO_EDGE_MASK;

/** Layout roles of the strip; a tab held out of view stops this far from an edge that fades. */
export const HAPPIER_COLLECTION_SPACES_STRIP_METRICS = { gapPx: 2, minHeightPx: 36, fadePx: 16 } as const;

/**
 * How far an overflowing strip scrolls to show a tab: nowhere while it is in view, else just enough. An edge that
 * fades because more spaces hide past it (`edgeInsetPx`) counts as out of view, so the tab shown never sits half
 * faded; an end of the strip has no fade, so the first and last tabs still sit flush there.
 */
export function resolveHappierCollectionSpaceStripRevealX(
  tab: Readonly<{ x: number; width: number }>,
  viewport: Readonly<{ x: number; width: number }>,
  fade: Readonly<{ edgeInsetPx: number; contentWidth: number }> = { edgeInsetPx: 0, contentWidth: Number.POSITIVE_INFINITY },
): number | null {
  if (viewport.width <= 0) return null;
  const maxX = Math.max(0, fade.contentWidth - viewport.width);
  const clamp = (x: number) => Math.min(maxX, Math.max(0, x));
  const leadingInset = viewport.x > 0 ? fade.edgeInsetPx : 0;
  const trailingInset = viewport.x < maxX ? fade.edgeInsetPx : 0;
  const right = tab.x + tab.width;
  const target = tab.x < viewport.x + leadingInset
    ? clamp(tab.x - fade.edgeInsetPx)
    : right > viewport.x + viewport.width - trailingInset
      ? clamp(right - viewport.width + fade.edgeInsetPx)
      : null;
  return target === null || target === viewport.x ? null : target;
}

/** The space a swipe or relative command moves to, in the entity's own order; null at either end. */
export function neighbourHappierCollectionSpaceId(
  spaces: readonly Readonly<{ id: string }>[],
  selectedId: string,
  direction: -1 | 1,
): string | null {
  const index = spaces.findIndex((space) => space.id === selectedId);
  return index < 0 ? null : (spaces[index + direction]?.id ?? null);
}

const stripStyle: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: HAPPIER_COLLECTION_SPACES_STRIP_METRICS.gapPx,
  minHeight: HAPPIER_COLLECTION_SPACES_STRIP_METRICS.minHeightPx,
};
const scrollerStyle: ViewStyle = { flexGrow: 0, flexShrink: 1, minWidth: 0 };

/**
 * The spaces strip (lab `clspaces`), for every collection that keeps saved views: one tab per saved space, then the
 * add control. When spaces outgrow the column the strip scrolls sideways, the add control staying in reach, and the
 * selected space stays in view however it was chosen (shortcut, swipe, title menu, a new space). Selection, focus
 * and arrow keys belong to the tab bar; drag belongs to `wrapList`/`wrapTab`. Layout facts live in refs: scrolling and
 * measuring never re-render the strip.
 */
export const HappierCollectionSpacesStrip = memo(function HappierCollectionSpacesStrip(props: Readonly<{
  testIDPrefix: string;
  accessibilityLabel: string;
  items: readonly HappierCollectionSpacesStripItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderTabs: (input: HappierCollectionSpacesStripTabsInput) => ReactNode;
  /** A stable hook for one mount: the host's edge fade, or none. */
  useEdgeMask?: () => HappierCollectionSpacesStripEdgeMask;
  reducedMotion?: boolean;
  /** The drag layer around the tabs, when the list can be reordered. */
  wrapList?: (tabs: ReactNode) => ReactNode;
  wrapTab?: (id: string, tab: ReactElement) => ReactNode;
  /** The add control, after the scrolling tabs. */
  add?: ReactNode;
}>) {
  const { selectedId } = props;
  const reducedMotion = props.reducedMotion === true;
  const mask = (props.useEdgeMask ?? useNoEdgeMask)();
  const scrollRef = useRef<ScrollView>(null);
  const tabPlaces = useRef(new Map<string, Readonly<{ x: number; width: number }>>());
  const viewport = useRef({ x: 0, width: 0 });
  const contentWidth = useRef(Number.POSITIVE_INFINITY);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // The first reveal lands instantly: nothing moves on arrival.
  const settled = useRef(false);
  const revealSelected = useCallback(() => {
    const place = tabPlaces.current.get(selectedIdRef.current);
    if (!place || viewport.current.width <= 0) return;
    const x = resolveHappierCollectionSpaceStripRevealX(place, viewport.current, {
      edgeInsetPx: HAPPIER_COLLECTION_SPACES_STRIP_METRICS.fadePx,
      contentWidth: contentWidth.current,
    });
    if (x !== null) {
      scrollRef.current?.scrollTo({ x, animated: settled.current && !reducedMotion });
      viewport.current = { ...viewport.current, x };
    }
    settled.current = true;
  }, [reducedMotion]);
  useEffect(revealSelected, [selectedId, revealSelected]);
  const { onContentSizeChange: maskContentSizeChange, onScroll: maskScroll, onViewportLayout: maskViewportLayout } = mask;
  const handleContentSizeChange = useCallback((width: number, height: number) => {
    contentWidth.current = width;
    maskContentSizeChange(width, height);
  }, [maskContentSizeChange]);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    viewport.current = { ...viewport.current, x: event.nativeEvent.contentOffset.x };
    maskScroll(event);
  }, [maskScroll]);
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    viewport.current = { ...viewport.current, width: event.nativeEvent.layout.width };
    maskViewportLayout(event);
    revealSelected();
  }, [maskViewportLayout, revealSelected]);
  const handleTabLayout = useCallback((id: string, place: Readonly<{ x: number; width: number }>) => {
    tabPlaces.current.set(id, { x: place.x, width: place.width });
    if (id === selectedIdRef.current) revealSelected();
  }, [revealSelected]);
  const { renderTabs, testIDPrefix, accessibilityLabel, items, onSelect, wrapTab } = props;
  // An element kept across fade and viewport changes: only a change of the tabs themselves redraws the bar.
  const tabs = useMemo(() => renderTabs({
    testIDPrefix,
    accessibilityLabel,
    items,
    selectedId,
    onSelect,
    onTabLayout: handleTabLayout,
    ...(wrapTab === undefined ? {} : { wrapTab }),
  }), [accessibilityLabel, handleTabLayout, items, onSelect, renderTabs, selectedId, testIDPrefix, wrapTab]);
  // The title already names the sole view; creation remains available in its title menu.
  if (items.length < 2) return null;
  return (
    <View testID={props.testIDPrefix} style={stripStyle}>
      {mask.wrapScroller(
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={mask.scrollerStyle === undefined ? scrollerStyle : mask.scrollerStyle}
          scrollEventThrottle={32}
          onScroll={handleScroll}
          onLayout={handleViewportLayout}
          onContentSizeChange={handleContentSizeChange}
        >
          {props.wrapList ? props.wrapList(tabs) : tabs}
        </ScrollView>,
      )}
      {props.add}
    </View>
  );
});
