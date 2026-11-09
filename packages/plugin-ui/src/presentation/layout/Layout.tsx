import { Children, cloneElement, createContext, Fragment, isValidElement, useContext, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import {
  ScrollView,
  View,
  type ViewStyle,
} from 'react-native';

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
  return (
    <PluginUiPopoverScrollSourceProvider scrollSourceRef={scrollSourceRef}>
      <PluginUiScrollActivityProvider tracker={tracker}>
      <HappierScrollAreaNestedContext.Provider value={true}>
      <ScrollView
        ref={scrollSourceRef}
        {...scrollProps}
        onScroll={event => { tracker?.onScroll(event); reportTop?.(event.nativeEvent.contentOffset.y); scrollProps.onScroll?.(event); }}
        onLayout={event => { tracker?.onLayout(event); scrollProps.onLayout?.(event); }}
        onContentSizeChange={tracker?.onContentSizeChange}
        scrollEventThrottle={scrollProps.scrollEventThrottle ?? (reportTop ? 16 : undefined)}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={style}
        contentContainerStyle={[insetStyle, contentContainerStyle]}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      >
        {/* A page's scroll owns its column: every block (a banner, a card, a state), not only the
            sections that centre themselves, sits on the column the page header uses (R-APP-4). */}
        {columnMaxWidthPx === undefined ? children : (
          // The column also owns the page's sheet edge, so a plain block (a line of text, Markdown, a button, a
          // banner) stands on it instead of the column's side; sheets, page states and titles keep their own edges.
          <View style={{ alignSelf: 'center', width: '100%', maxWidth: columnMaxWidthPx, paddingHorizontal: edgePx }}>
            {edgePx === 0 ? children : <HappierColumnEdgeContext.Provider value={edgePx}>{children}</HappierColumnEdgeContext.Provider>}
          </View>
        )}
      </ScrollView>
      </HappierScrollAreaNestedContext.Provider>
      </PluginUiScrollActivityProvider>
    </PluginUiPopoverScrollSourceProvider>
  );
}
