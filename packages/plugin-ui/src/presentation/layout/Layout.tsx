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
import {
  HappierRetainedScrollContextInternal,
  PluginUiScrollActivityProvider,
  type HappierRetainedScrollInternal,
} from '../../presentationHost/scrollActivity.js';
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
  /** Clip web descendants at the laid-out content edge so their overflow cannot add scroll range. */
  clipContentOverflow?: boolean;
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
const FOCUSABLE_CONTROL_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Whether a web scroll area's own content already gives the keyboard a way in. */
function scrollAreaHoldsControl(scrollView: ScrollView | null): boolean {
  if (Platform.OS !== 'web') return false;
  const node = (scrollView as unknown as { getScrollableNode?: () => { querySelector?: (selector: string) => unknown } | null } | null)
    ?.getScrollableNode?.();
  return typeof node?.querySelector === 'function' && node.querySelector(FOCUSABLE_CONTROL_SELECTOR) != null;
}

const HappierScrollAreaNestedContext = createContext(false);
const useNoPaneHeaderReporter = (): ((distancePx: number) => void) | null => null;
// React Native's ViewStyle omits this CSS value. RNW passes it through to the browser.
const webScrollContentClip = { overflow: 'clip' } as unknown as ViewStyle;

export function HappierScrollArea({
  children,
  accessibilityLabel,
  clipContentOverflow,
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
  const retainedRestore = useRef<{ offset: number; waitingForContent: boolean; waitForLayout: boolean } | null>(null);
  const leadHeightRef = useRef(0);
  // Under the pinned row the content is at least the rest of the viewport, so the row can stay just under the lead
  // whatever the selected tab holds: a short panel would otherwise clamp the scroll and drop the row back down.
  const [viewportHeightPx, setViewportHeightPx] = useState(0);
  const [rowHeightPx, setRowHeightPx] = useState(0);
  const selection = head?.selection;
  const lastSelection = useRef(selection);
  // A switch while the row is pinned brings the new tab in at its top, the row still pinned; above that, it stays put.
  useEffect(() => {
    const previousSelection = lastSelection.current;
    if (previousSelection === selection) return;
    lastSelection.current = selection;
    // Showing or hiding the pinned row during a layout handoff keeps the current tab's offset.
    if (previousSelection !== undefined && selection !== undefined
      && retainedRestore.current === null && offsetRef.current > leadHeightRef.current) {
      scrollSourceRef.current?.scrollTo({ y: leadHeightRef.current, animated: false });
    }
  }, [selection]);
  // A keyboard reaches a scroll area only through a focusable child; one whose content runs past it with none
  // (an empty state a few pixels taller than its card) takes focus itself while, and only while, it overflows.
  // On the web, content that already holds a control adds no tab stop (the browser's keyboard-focusable scrollers).
  const viewportRef = useRef({ width: 0, height: 0 });
  const contentRef = useRef({ width: 0, height: 0 });
  const createTracker = host?.createScrollActivityTracker;
  const tracker = useMemo(() => createTracker?.(scrollSourceRef, scrollProps.horizontal === true) ?? null,
    [createTracker, scrollProps.horizontal]);
  const retainedScroll = useMemo<HappierRetainedScrollInternal>(() => {
    const scrollToOffset = (offset: number) => {
      const scroller = scrollSourceRef.current;
      scroller?.scrollTo({ y: offset, animated: false });
      const webNode: unknown = Platform.OS === 'web' ? scroller?.getScrollableNode() : null;
      offsetRef.current = typeof HTMLElement !== 'undefined' && webNode instanceof HTMLElement ? webNode.scrollTop : offset;
      const request = retainedRestore.current;
      if (request !== null) {
        request.offset = offset;
        // An expanded row above a retained anchor can close before its new height reaches the virtualizer.
        // Keep the requested coordinate through that remeasurement even if the browser already clamped it.
        request.waitingForContent = Platform.OS === 'web'
          ? request.waitForLayout && offset - offsetRef.current > 0.5
          : offset > Math.max(0, contentRef.current.height - viewportRef.current.height);
      }
    };
    return {
      tracker,
      readOffset: (beforeLayoutChange = false) => {
        const request = retainedRestore.current;
        if (request?.waitingForContent) return request.offset;
        if (beforeLayoutChange && Platform.OS === 'web') {
          const node: unknown = scrollSourceRef.current?.getScrollableNode();
          if (typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) return Math.max(0, node.scrollTop);
        }
        return Math.max(0, offsetRef.current);
      },
      scrollToOffset,
      restoreOffset: (offset, waitForLayout = false) => {
        const request = { offset, waitingForContent: false, waitForLayout };
        retainedRestore.current = request;
        scrollToOffset(offset);
        return () => {
          if (retainedRestore.current === request) retainedRestore.current = null;
        };
      },
    };
  }, [tracker]);
  const [overflowing, setOverflowing] = useState(false);
  const axis = scrollProps.horizontal === true ? 'width' : 'height';
  const remeasureOverflow = () => {
    const next = viewportRef.current[axis] > 0 && contentRef.current[axis] > viewportRef.current[axis] + 0.5
      && !scrollAreaHoldsControl(scrollSourceRef.current);
    setOverflowing(previous => previous === next ? previous : next);
  };
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
      <HappierRetainedScrollContextInternal.Provider
        value={scrollProps.horizontal === true || scrollProps.scrollEnabled === false ? null : retainedScroll}
      >
      <ScrollView
        ref={scrollSourceRef}
        {...scrollProps}
        onScroll={event => {
          const offset = event.nativeEvent.contentOffset.y;
          const request = retainedRestore.current;
          if (Platform.OS === 'web' && request?.waitForLayout && offset !== offsetRef.current) {
            const node: unknown = scrollSourceRef.current?.getScrollableNode();
            // The tab can show its retained geometry for a frame before its content contracts.
            // A newly impossible coordinate is a clamp; movement in the new extent takes ownership.
            const lostExtent = !request.waitingForContent && typeof HTMLElement !== 'undefined'
              && node instanceof HTMLElement && request.offset > node.scrollHeight - node.clientHeight;
            request.waitingForContent = offset < request.offset && lostExtent;
            request.waitForLayout = request.waitingForContent || offset === request.offset;
          }
          offsetRef.current = offset;
          tracker?.onScroll(event); reportTop?.(offset); scrollProps.onScroll?.(event);
        }}
        onScrollBeginDrag={() => {
          const request = retainedRestore.current;
          if (request !== null) {
            request.waitingForContent = false;
            request.waitForLayout = false;
          }
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
          const request = retainedRestore.current;
          // A restore can arrive before the incoming content has its full extent.
          if (request?.waitingForContent && request.offset <= height - viewportRef.current.height) {
            retainedScroll.scrollToOffset?.(request.offset);
          }
          remeasureOverflow();
          tracker?.onContentSizeChange(width, height);
        }}
        {...(overflowing && scrollProps.scrollEnabled !== false ? { focusable: true } : {})}
        scrollEventThrottle={scrollProps.scrollEventThrottle ?? (reportTop ? 16 : undefined)}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={style}
        contentContainerStyle={[
          insetStyle,
          contentContainerStyle,
          Platform.OS === 'web' && clipContentOverflow ? webScrollContentClip : undefined,
        ]}
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
      </HappierRetainedScrollContextInternal.Provider>
      </HappierScrollAreaNestedContext.Provider>
      </PluginUiScrollActivityProvider>
    </PluginUiPopoverScrollSourceProvider>
  );
}
