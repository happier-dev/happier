import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';

/**
 * The measured height of a stack of cards that stands above the composer's input in its column. Every such stack
 * reports through this one path; the composer's panel cap subtracts their sum (owner 2026-11-11).
 */
export function useMeasuredStackHeight(): readonly [
  number,
  (event: LayoutChangeEvent) => void,
] {
  const [height, setHeight] = React.useState(0);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = Math.max(0, Math.round(event.nativeEvent.layout.height));
    setHeight((current) => (Math.abs(current - next) > 1 ? next : current));
  }, []);
  return [height, onLayout] as const;
}
