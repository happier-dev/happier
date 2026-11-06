import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { HappierResizeHandle } from '../layout/resize/HappierResizeHandle.js';
import { useResizableListDetailGeometry, type HappierCollectionRailSizingProps } from './useResizableListDetailGeometry.js';

import type { HappierLayoutChangeEvent, HappierStyleProp } from '../portableTypes.js';
import {
  HappierCollectionDetailWidthContext,
  HappierCollectionLayoutContext,
  resolveHappierCollectionLayoutState,
} from './collectionLayout.js';
import {
  type HappierListDetailLayoutState,
} from './listDetailGeometry.js';

export type { HappierListDetailLayoutState } from './listDetailGeometry.js';

export type HappierListDetailLayoutProps = HappierCollectionRailSizingProps & Readonly<{
  labels?: Readonly<{ resize: string; resizeHint?: string; resizeValue?: (px: number) => string }>;
  /** Receives the same measured layout used by the panes; null before measurement. */
  list: ReactNode | ((layout: HappierListDetailLayoutState | null) => ReactNode);
  detail: ReactNode;
  /** Keep a route outlet mounted while no detail is selected. Defaults to detail != null. */
  detailActive?: boolean;
  /**
   * A quiet stand-in for the detail pane while nothing is selected. Where both
   * panes fit it holds the split, so the first selection fills a pane that is
   * already there instead of reflowing the list under the pointer. Where they
   * do not fit the list stays the page and this is not shown.
   */
  idleDetail?: ReactNode;
  /** Which pane remains visible when both panes cannot fit. Defaults to detail. */
  stackedPane?: 'list' | 'detail';
  /** Minimum readable pane widths, including the caller's own text scaling and insets. */
  minListWidth: number;
  minDetailWidth: number;
  /** Preferred share of available pane width, from zero to one, clamped by both minima. */
  preferredListRatio: number;
  gap?: number;
  testID?: string;
  listTestID?: string;
  detailTestID?: string;
  style?: HappierStyleProp;
  listStyle?: HappierStyleProp;
  detailStyle?: HappierStyleProp;
}>;

const fillStyle: ViewStyle = { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' };
const hiddenStyle: ViewStyle = { display: 'none' };
/** The divider's drawn width; the handle grows its own target to the pointer floor around it. */
const SEAM_HANDLE_WIDTH_PX = 10;

/**
 * The Collection's `split` geometry: a measured composition, not a selection or navigation owner.
 * Both pane hosts keep their identity across split/stacked transitions. Inactive content stays
 * mounted but has no layout, pointer target or accessibility presence.
 *
 * It is also the one owner of the Collection's layout mode: everything inside reads it through
 * `useHappierCollectionLayout`, in the same render that measured it.
 */
export function HappierListDetailLayout({
  list,
  detail,
  detailActive = detail != null,
  idleDetail,
  stackedPane = 'detail',
  minListWidth,
  minDetailWidth,
  preferredListRatio,
  gap = 0,
  testID,
  listTestID,
  detailTestID,
  style,
  listStyle,
  detailStyle,
  labels,
  ...sizing
}: HappierListDetailLayoutProps): ReactElement {
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setAvailableWidth((current) => current === width ? current : width);
  }, []);
  const { layout, resize } = useResizableListDetailGeometry({
    ...sizing, availableWidth, minListWidth, minDetailWidth, preferredListRatio, gap,
  });
  const idle = !detailActive && idleDetail !== undefined && idleDetail !== null && layout?.mode === 'split';
  const collectionLayout = useMemo(() => resolveHappierCollectionLayoutState(layout, detailActive || idle), [detailActive, idle, layout]);
  const split = (detailActive || idle) && layout?.mode === 'split' ? layout : null;
  const listVisible = !detailActive || split !== null || stackedPane === 'list';
  const detailVisible = idle || (detailActive && (split !== null || stackedPane === 'detail'));

  return (
    <HappierCollectionLayoutContext.Provider value={collectionLayout}>
      <View testID={testID} onLayout={onLayout} style={[fillStyle, { flexDirection: 'row', gap }, style]}>
        <View
          testID={listTestID}
          aria-hidden={!listVisible || undefined}
          accessibilityElementsHidden={!listVisible}
          importantForAccessibility={listVisible ? 'auto' : 'no-hide-descendants'}
          style={[fillStyle, listStyle, { flex: split?.listRatio ?? 1 }, !listVisible && hiddenStyle]}
        >
          {typeof list === 'function' ? list(layout) : list}
        </View>
        {split && resize.canResize && labels && availableWidth !== null ? <HappierResizeHandle
          // It resizes the list's trailing edge and its target reaches past that seam over the detail, so it sits in this
          // row, outside the list pane's clip, and after the list in focus order.
          axis="x" edge="end" labels={{ label: labels.resize, hint: labels.resizeHint, value: labels.resizeValue }}
          testID={testID ? `${testID}-resize-handle` : undefined}
          interactionProps={Platform.OS === 'web' ? resize.webHandleProps : resize.panHandlers}
          accessibilityHandleProps={resize.accessibilityHandleProps}
          showIndicator={false}
          active={resize.dragging}
          style={{
            position: 'absolute', top: 0, bottom: 0, width: SEAM_HANDLE_WIDTH_PX, zIndex: 1000,
            left: (availableWidth - gap) * split.listRatio - SEAM_HANDLE_WIDTH_PX,
          }}
        /> : null}
        <View
          testID={detailTestID}
          aria-hidden={!detailVisible || undefined}
          accessibilityElementsHidden={!detailVisible}
          importantForAccessibility={detailVisible ? 'auto' : 'no-hide-descendants'}
          style={[fillStyle, detailStyle, { flex: split ? 1 - split.listRatio : 1 }, !detailVisible && hiddenStyle]}
        >
          <HappierCollectionDetailWidthContext.Provider value={layout?.mode === 'split' ? layout.detailWidthPx : null}>
            {idle ? idleDetail : detail}
          </HappierCollectionDetailWidthContext.Provider>
        </View>
      </View>
    </HappierCollectionLayoutContext.Provider>
  );
}
