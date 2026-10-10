import { useId } from 'react';
import { Platform, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { HappierSurfaceGradient } from './material.js';

/** One native paint layer. Web draws the same stops on its existing surface element. */
export function HappierSurfaceGradientLayer(props: Readonly<{ gradient?: HappierSurfaceGradient | null; underlay?: HappierSurfaceGradient | null; borderRadius?: number }>) {
  const id = useId();
  if (Platform.OS === 'web' || (!props.gradient && !props.underlay)) return null;
  const paints = [props.underlay, props.gradient].filter((gradient): gradient is HappierSurfaceGradient => Boolean(gradient));
  return <Svg pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFillObject} width="100%" height="100%">
    <Defs>{paints.map((gradient, paint) => <LinearGradient key={paint} id={`${id}-${paint}`} x1={gradient.start?.x ?? 0.5} y1={gradient.start?.y ?? 0} x2={gradient.end?.x ?? 0.5} y2={gradient.end?.y ?? 1}>
      {gradient.colors.map((color, index) => <Stop key={index} offset={gradient.locations?.[index] ?? index / (gradient.colors.length - 1)} stopColor={color} />)}
    </LinearGradient>)}</Defs>
    {paints.map((_, paint) => <Rect key={paint} width="100%" height="100%" rx={props.borderRadius ?? 0} ry={props.borderRadius ?? 0} fill={`url(#${id}-${paint})`} />)}
  </Svg>;
}
