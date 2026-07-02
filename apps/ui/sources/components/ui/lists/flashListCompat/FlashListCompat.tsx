import * as React from 'react';
import { FlatList, type FlatListProps, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { resolveFlashListRuntime, type FlashListCompatComponent } from './resolveFlashListRuntime';

export type FlashListRef<T> = Readonly<{
  scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }) => void | Promise<void>;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
  getScrollableNode?: () => unknown;
  clearLayoutCacheOnUpdate?: () => void;
  getFirstVisibleIndex?: () => number;
  computeVisibleIndices?: () => { startIndex: number; endIndex: number };
  getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
  getAbsoluteLastScrollOffset?: () => number;
}>;

export type FlashListPropsCompat<T> = FlatListProps<T> & Readonly<{
  estimatedItemSize?: number;
  drawDistance?: number;
  overrideItemLayout?: (layout: unknown, item: T, index: number, maxColumns?: number, extraData?: unknown) => void;
  getItemType?: (item: T, index: number, extraData?: unknown) => string | number | undefined;
  initialScrollIndexParams?: Readonly<{ viewOffset?: number }>;
  onStartReached?: () => void;
  onStartReachedThreshold?: number;
  onLoad?: (info: { elapsedTimeInMs: number }) => void;
  overrideProps?: Record<string, unknown>;
}>;

export type FlashListMappingKey = string | number | bigint;

export type FlashListMappingHelper = Readonly<{
  getMappingKey: (key: FlashListMappingKey, index: number) => FlashListMappingKey;
}>;

export type FlashListLayoutStateSetter<T> = (value: T | ((current: T) => T)) => void;

export type FlashListLayoutCommitObserverProps = Readonly<{
  children?: React.ReactNode;
  onCommitLayoutEffect?: () => void;
}>;

type FlashListSupportModule = Readonly<{
  LayoutCommitObserver?: React.ComponentType<FlashListLayoutCommitObserverProps>;
  useLayoutState?: <T>(initialValue: T) => readonly [T, FlashListLayoutStateSetter<T>];
  useMappingHelper?: () => FlashListMappingHelper;
  useRecyclingState?: <T>(
    initialValue: T,
    dependencies: readonly unknown[],
    onReset?: () => void,
    skipParentLayout?: boolean,
  ) => readonly [T, FlashListLayoutStateSetter<T>];
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
    initialScrollIndexParams: _initialScrollIndexParams,
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
    onLoad?.({ elapsedTimeInMs: 0 });
  }, [onLoad]);

  return <FlatList {...restProps} ref={ref as never} onScroll={forwardedOnScroll} />;
}) as unknown as FlashListCompatComponent;

function loadFlashListModule(): unknown {
  return require('@shopify/flash-list') as typeof import('@shopify/flash-list');
}

const runtime = resolveFlashListRuntime(loadFlashListModule, FallbackFlashListBase);
const supportModule = runtime.usingFallback ? null : loadFlashListModule() as FlashListSupportModule;

export const FlashList = (runtime.usingFallback ? FallbackFlashListBase : runtime.Component) as FlashListCompatComponent;
export const flashListRuntime = runtime;

function FallbackLayoutCommitObserver(props: FlashListLayoutCommitObserverProps) {
  React.useLayoutEffect(() => {
    props.onCommitLayoutEffect?.();
  });
  return <>{props.children}</>;
}

function fallbackUseLayoutState<T>(initialValue: T): readonly [T, FlashListLayoutStateSetter<T>] {
  return React.useState(initialValue);
}

function fallbackUseMappingHelper(): FlashListMappingHelper {
  return {
    getMappingKey: (key) => key,
  };
}

function fallbackUseRecyclingState<T>(
  initialValue: T,
  dependencies: readonly unknown[],
  onReset?: () => void,
): readonly [T, FlashListLayoutStateSetter<T>] {
  const generationRef = React.useRef(0);
  const dependencyKey = React.useMemo(() => {
    generationRef.current += 1;
    return generationRef.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  const [state, setState] = React.useState(initialValue);

  React.useEffect(() => {
    setState(initialValue);
    onReset?.();
  }, [dependencyKey, initialValue, onReset]);

  return [state, setState];
}

export const LayoutCommitObserver = supportModule?.LayoutCommitObserver ?? FallbackLayoutCommitObserver;
export const useLayoutState = supportModule?.useLayoutState ?? fallbackUseLayoutState;
export const useMappingHelper = supportModule?.useMappingHelper ?? fallbackUseMappingHelper;
export const useRecyclingState = supportModule?.useRecyclingState ?? fallbackUseRecyclingState;
