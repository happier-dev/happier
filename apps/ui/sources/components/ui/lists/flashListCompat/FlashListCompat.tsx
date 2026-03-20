import * as React from 'react';
import { FlatList, type FlatListProps, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { resolveFlashListRuntime, type FlashListCompatComponent } from './resolveFlashListRuntime';

export type FlashListRef<T> = Readonly<{
  scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number }) => void | Promise<void>;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
  getScrollableNode?: () => unknown;
  clearLayoutCacheOnUpdate?: () => void;
}>;

export type FlashListPropsCompat<T> = FlatListProps<T> & Readonly<{
  estimatedItemSize?: number;
  drawDistance?: number;
  overrideItemLayout?: (layout: unknown, item: T, index: number, maxColumns?: number, extraData?: unknown) => void;
  getItemType?: (item: T, index: number, extraData?: unknown) => string | number | undefined;
  onStartReached?: () => void;
  onStartReachedThreshold?: number;
  onLoad?: (info: unknown) => void;
  overrideProps?: Record<string, unknown>;
}>;

const FallbackFlashListBase = React.forwardRef(function FallbackFlashListInner<T>(
  props: FlashListPropsCompat<T>,
  ref: React.ForwardedRef<FlashListRef<T>>,
) {
  const {
    estimatedItemSize: _estimatedItemSize,
    drawDistance: _drawDistance,
    overrideItemLayout: _overrideItemLayout,
    getItemType: _getItemType,
    onStartReached,
    onStartReachedThreshold,
    onLoad,
    overrideProps: _overrideProps,
    onScroll,
    ...restProps
  } = props;

  const startReachedRef = React.useRef(false);
  const forwardedOnScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScroll?.(event);
    if (!onStartReached) return;

    const thresholdRatio =
      typeof onStartReachedThreshold === 'number' && Number.isFinite(onStartReachedThreshold)
        ? Math.max(0, onStartReachedThreshold)
        : 0;
    const thresholdPx = Math.max(1, thresholdRatio * 100);
    const offsetY = event.nativeEvent.contentOffset?.y ?? 0;

    if (offsetY <= thresholdPx) {
      if (!startReachedRef.current) {
        startReachedRef.current = true;
        onStartReached();
      }
      return;
    }

    startReachedRef.current = false;
  }, [onScroll, onStartReached, onStartReachedThreshold]);

  React.useEffect(() => {
    onLoad?.({ fallback: true });
  }, [onLoad]);

  return <FlatList {...restProps} ref={ref as never} onScroll={forwardedOnScroll} />;
}) as unknown as FlashListCompatComponent;

function loadFlashListModule(): unknown {
  return require('@shopify/flash-list') as typeof import('@shopify/flash-list');
}

const runtime = resolveFlashListRuntime(loadFlashListModule, FallbackFlashListBase);

export const FlashList = (runtime.usingFallback ? FallbackFlashListBase : runtime.Component) as FlashListCompatComponent;
export const flashListRuntime = runtime;
