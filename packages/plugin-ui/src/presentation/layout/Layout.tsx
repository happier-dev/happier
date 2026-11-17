import { Children, cloneElement, createContext, Fragment, isValidElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  View,
  type ViewStyle,
} from 'react-native';

/**
 * A drag of the content lets the keyboard go (following the finger on iOS), so a form opened with a field focused
 * never hides the rest of itself. Web keeps focus while scrolling.
 */
function scrollKeyboardDismissMode(): 'interactive' | 'on-drag' | undefined {
  return Platform.OS === 'ios' ? 'interactive' : Platform.OS === 'web' ? undefined : 'on-drag';
}

import type {
  HappierAlignment,
  HappierFocusable,
  HappierJustification,
  HappierKeyboardShouldPersistTaps,
  HappierLayoutChangeEvent,
  HappierScrollEvent,
  HappierStyleProp,
} from '../portableTypes.js';
import { PluginUiPopoverScrollSourceProvider, useOptionalPluginUiPresentationHost } from '../../presentationHost/context.js';
import { PluginUiScrollActivityProvider } from '../../presentationHost/scrollActivity.js';
import { useHappierPageChrome } from './pageChrome.js';
import { HappierColumnEdgeContext, useHappierColumnEdgePx } from './columnEdge.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';
import { HappierScrollHeadContextInternal } from './scrollHead.js';
import { resolveHappierUiPalette, useOptionalHappierUiPalette, useOptionalHappierUiTheme } from '../../environment/context.js';

// The semantic gap vocabulary is owned by the RN-free shared module so the
// public adapter and the host declarative renderer cannot disagree about it.
export {
  resolveHappierLayoutGap,
  type HappierLayoutGap,
  type HappierLayoutSpacing,
} from './layoutSemantics.js';

export type HappierStackProps = Readonly<{
  children?: ReactNode;
  /** Fill available space without imposing a minimum content width. */
  grow?: boolean;
  /** Private semantic focus binding supplied by the public layout adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  wrap?: boolean;
  align?: HappierAlignment;
  justify?: HappierJustification;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type HappierScreenProps = Readonly<{
  children?: ReactNode;
  /** Private semantic focus binding supplied by the public layout adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  testID?: string;
  style?: HappierStyleProp;
  safeAreaInsets?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
}>;

export type HappierScrollAreaProps = Readonly<{
  children?: ReactNode;
  horizontal?: boolean;
  scrollEnabled?: boolean;
  keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
  onScroll?: (event: HappierScrollEvent) => void;
  scrollEventThrottle?: number;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
  contentContainerStyle?: HappierStyleProp;
  safeAreaInsets?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
}>;

const screenBaseStyle: ViewStyle = { flex: 1, minWidth: 0 };
const stackBaseStyle: ViewStyle = { minWidth: 0 };
const stackGrowStyle: ViewStyle = { flex: 1, minWidth: 0 };
/**
 * A wrapping stack takes more lines rather than running past its container: it is never wider than the line it
 * sits on and gives way to its siblings, so a wrapping group nested in a row (an action row's source controls, a
 * pinned footer on a phone) wraps inside itself instead of keeping its one-line width past the pane's edge.
 */
const stackWrapStyle: ViewStyle = { flexShrink: 1, maxWidth: '100%' };

export function HappierScreen({ children, controlRef, onLayout, testID, style, safeAreaInsets }: HappierScreenProps) {
  const insetStyle: ViewStyle | undefined = safeAreaInsets
    ? {
        paddingTop: safeAreaInsets.top,
        paddingRight: safeAreaInsets.right,
        paddingBottom: safeAreaInsets.bottom,
        paddingLeft: safeAreaInsets.left,
      }
    : undefined;
  return (
    <View
      ref={controlRef}
      tabIndex={controlRef ? -1 : undefined}
      onLayout={onLayout}
      testID={testID}
      style={[screenBaseStyle, insetStyle, style]}
    >
      {children}
    </View>
  );
}

/**
 * A labelled control that keeps its own width in a column: a button reads as an operation beside the content, not
 * as a bar across it. A component opts in with `Component.happierInlineControl = true` (component metadata, so it
 * holds across separately bundled plugins, like `happierPageOperation`).
 */
export function isHappierInlineControl(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  const component = node.type;
  return (typeof component === 'function' || (typeof component === 'object' && component !== null))
    && 'happierInlineControl' in component && component.happierInlineControl === true;
}

const INLINE_CONTROL_SLOT_STYLE = Object.freeze({ alignItems: 'flex-start' as const });

/** Each labelled control of a stretching column, fragments included, in a slot that keeps its own width. */
function placeInlineControls(children: ReactNode): ReactNode {
  return Children.map(children, child => {
    if (isHappierInlineControl(child)) return <View style={INLINE_CONTROL_SLOT_STYLE}>{child}</View>;
    if (isValidElement(child) && child.type === Fragment) {
      const fragment = child as ReactElement<{ children?: ReactNode }>;
      return cloneElement(fragment, undefined, placeInlineControls(fragment.props.children));
    }
    return child;
  });
}

export function HappierStack({
  children,
  grow = false,
  direction = 'vertical',
  gap = 0,
  wrap = false,
  align,
  justify,
  controlRef,
  onLayout,
  testID,
  style,
}: HappierStackProps) {
  return (
    <View
      ref={controlRef}
      tabIndex={controlRef ? -1 : undefined}
      onLayout={onLayout}
      testID={testID}
      style={[
        stackBaseStyle,
        grow ? stackGrowStyle : undefined,
        wrap ? stackWrapStyle : undefined,
        {
          flexDirection: direction === 'horizontal' ? 'row' : 'column',
          gap,
          flexWrap: wrap ? 'wrap' : 'nowrap',
          alignItems: align,
          justifyContent: justify,
        },
        style,
      ]}
    >
      {/* A column left to its default keeps its blocks full width and its labelled controls (buttons) their own
          width, on its leading edge. A row, or a column the caller aligns (`align="stretch"` to fill a phone's
          action column), places them as it places everything else. */}
      {direction === 'horizontal' || align !== undefined ? children : placeInlineControls(children)}
    </View>
  );
}

/** Set inside a scroll area: a nested scroller is never the pane's primary body. */
const HappierScrollAreaNestedContext = createContext(false);
const useNoPaneHeaderReporter = (): ((distancePx: number) => void) | null => null;

export function HappierScrollArea({
  children,
  accessibilityLabel,
  testID,
  style,
  contentContainerStyle,
  safeAreaInsets,
  keyboardShouldPersistTaps = 'handled',
  ...scrollProps
}: HappierScrollAreaProps) {
  const scrollSourceRef = useRef<ScrollView | null>(null);
  const dismissMode = scrollKeyboardDismissMode();
  const host = useOptionalPluginUiPresentationHost();
  const pageChrome = useHappierPageChrome();
  const columnMaxWidthPx = scrollProps.horizontal === true ? undefined : pageChrome?.columnMaxWidthPx;
  // A scroll inside a column that already draws the edge (a detail's body, a menu on the page) adds none.
  const edgePx = useHappierColumnEdgePx() === 0 ? HAPPIER_PAGE_METRICS.sheetInsetPx : 0;
  // The outermost vertical scroll area is the surface's primary body: it drives the pane header's shade.
  const nested = useContext(HappierScrollAreaNestedContext);
  const usePaneHeaderReporter = host?.paneHeaderScroll?.useReporter ?? useNoPaneHeaderReporter;
  const paneHeaderReporter = usePaneHeaderReporter();
  const reportTop = !nested && scrollProps.horizontal !== true ? paneHeaderReporter : null;
  // The selected tab's page head (its lead and tab row, `HappierTabs` `lead`): the primary scroll area draws them first,
  // so the lead scrolls away and the row pins at the top of this one scroll (never a second scroll owner).
  const offeredHead = useContext(HappierScrollHeadContextInternal);
  const head = !nested && scrollProps.horizontal !== true ? offeredHead : null;
  const claimHead = head?.claim;
  useLayoutEffect(() => claimHead?.(), [claimHead]);
  const theme = useOptionalHappierUiTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? (theme === null ? null : resolveHappierUiPalette(theme));
  const offsetRef = useRef(0);
  const leadHeightRef = useRef(0);
  // Under the pinned row the content is at least the rest of the viewport, so the row can stay just under the lead
  // whatever the selected tab holds: a short panel would otherwise clamp the scroll and drop the row back down.
  const [viewportHeightPx, setViewportHeightPx] = useState(0);
  const [rowHeightPx, setRowHeightPx] = useState(0);
  const selection = head?.selection;
  const lastSelection = useRef(selection);
  // A switch while the row is pinned brings the new tab in at its top, the row still pinned; above that, it stays put.
  useEffect(() => {
    if (lastSelection.current === selection) return;
    lastSelection.current = selection;
    if (selection !== undefined && offsetRef.current > leadHeightRef.current) {
      scrollSourceRef.current?.scrollTo({ y: leadHeightRef.current, animated: false });
    }
  }, [selection]);
  // A keyboard reaches a scroll area only through a focusable child; one whose content runs past it with none
  // (an empty state a few pixels taller than its card) takes focus itself while, and only while, it overflows.
  const viewportRef = useRef({ width: 0, height: 0 });
  const contentRef = useRef({ width: 0, height: 0 });
  const [overflowing, setOverflowing] = useState(false);
  const axis = scrollProps.horizontal === true ? 'width' : 'height';
  const remeasureOverflow = () => {
    const next = viewportRef.current[axis] > 0 && contentRef.current[axis] > viewportRef.current[axis] + 0.5;
    setOverflowing(previous => previous === next ? previous : next);
  };
  const createTracker = host?.createScrollActivityTracker;
  const tracker = useMemo(() => createTracker?.(scrollSourceRef, scrollProps.horizontal === true) ?? null,
    [createTracker, scrollProps.horizontal]);
  const insetStyle: ViewStyle | undefined = safeAreaInsets
    ? {
        paddingTop: safeAreaInsets.top,
        paddingRight: safeAreaInsets.right,
        paddingBottom: safeAreaInsets.bottom,
        paddingLeft: safeAreaInsets.left,
      }
    : undefined;
  const column = (node: ReactNode) => columnMaxWidthPx === undefined ? node : (
    // The column also owns the page's sheet edge, so a plain block (a line of text, Markdown, a button, a
    // banner) stands on it instead of the column's side; sheets, page states and titles keep their own edges.
    <View style={{ alignSelf: 'center', width: '100%', maxWidth: columnMaxWidthPx, paddingHorizontal: edgePx }}>
      {edgePx === 0 ? node : <HappierColumnEdgeContext.Provider value={edgePx}>{node}</HappierColumnEdgeContext.Provider>}
    </View>
  );
  return (
    <PluginUiPopoverScrollSourceProvider scrollSourceRef={scrollSourceRef}>
      <PluginUiScrollActivityProvider tracker={tracker}>
      <HappierScrollAreaNestedContext.Provider value={true}>
      <ScrollView
        ref={scrollSourceRef}
        {...scrollProps}
        onScroll={event => {
          offsetRef.current = event.nativeEvent.contentOffset.y;
          tracker?.onScroll(event); reportTop?.(event.nativeEvent.contentOffset.y); scrollProps.onScroll?.(event);
        }}
        {...(head === null ? {} : { stickyHeaderIndices: [1] })}
        onLayout={event => {
          if (head !== null) setViewportHeightPx(event.nativeEvent.layout.height);
          viewportRef.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
          remeasureOverflow();
          tracker?.onLayout(event); scrollProps.onLayout?.(event);
        }}
        onContentSizeChange={(width: number, height: number) => {
          contentRef.current = { width, height };
          remeasureOverflow();
          tracker?.onContentSizeChange(width, height);
        }}
        {...(overflowing && scrollProps.scrollEnabled !== false ? { focusable: true } : {})}
        scrollEventThrottle={scrollProps.scrollEventThrottle ?? (reportTop ? 16 : undefined)}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={style}
        contentContainerStyle={[insetStyle, contentContainerStyle]}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        {...(dismissMode === undefined ? {} : { keyboardDismissMode: dismissMode })}
      >
        {head === null ? null : column(<View onLayout={(event) => { leadHeightRef.current = event.nativeEvent.layout.height; }}>{head.lead}</View>)}
        {head === null ? null : (
          <View style={palette === null ? undefined : { backgroundColor: palette.page }}
            onLayout={(event) => { setRowHeightPx(event.nativeEvent.layout.height); }}
            {...(testID === undefined ? {} : { testID: `${testID}:pinned-row` })}>{column(head.strip)}</View>
        )}
        {/* A page's scroll owns its column: every block (a banner, a card, a state), not only the
            sections that centre themselves, sits on the column the page header uses (R-APP-4). */}
        {head === null ? column(children) : (
          <View style={{ minHeight: Math.max(0, viewportHeightPx - rowHeightPx) }}
            {...(testID === undefined ? {} : { testID: `${testID}:pinned-content` })}>{column(children)}</View>
        )}
      </ScrollView>
      </HappierScrollAreaNestedContext.Provider>
      </PluginUiScrollActivityProvider>
    </PluginUiPopoverScrollSourceProvider>
  );
}
