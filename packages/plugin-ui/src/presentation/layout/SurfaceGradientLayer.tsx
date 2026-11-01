import { useId } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Svg, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { HappierSurfaceGradient } from './material.js';
import { happierSvgGradientStop } from './svgGradientStop.js';

/** One native paint layer. Web draws the same stops on its existing surface element. */
export function HappierSurfaceGradientLayer(props: Readonly<{ gradient?: HappierSurfaceGradient | null; underlay?: HappierSurfaceGradient | null; borderRadius?: number }>) {
  const id = useId();
  if (Platform.OS === 'web' || (!props.gradient && !props.underlay)) return null;
  const paints = [props.underlay, props.gradient].filter((gradient): gradient is HappierSurfaceGradient => Boolean(gradient));
  const radius = props.borderRadius ?? 0;
  const stops = (gradient: HappierSurfaceGradient) => gradient.colors.map((color, index) => <Stop key={index} offset={gradient.locations?.[index] ?? index / (gradient.colors.length - 1)} {...happierSvgGradientStop(color)} />);
  const full = paints.filter(gradient => !gradient.band);
  return <>
    {full.length > 0 ? <Svg pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFillObject} width="100%" height="100%">
      <Defs>{full.map((gradient, paint) => <LinearGradient key={paint} id={`${id}-${paint}`} x1={gradient.start?.x ?? 0.5} y1={gradient.start?.y ?? 0} x2={gradient.end?.x ?? 0.5} y2={gradient.end?.y ?? 1}>{stops(gradient)}</LinearGradient>)}</Defs>
      {full.map((_, paint) => <Rect key={paint} width="100%" height="100%" rx={radius} ry={radius} fill={`url(#${id}-${paint})`} />)}
    </Svg> : null}
    {paints.map((gradient, paint) => {
      const band = gradient.band;
      if (!band) return null;
      // A band is its own strip at the edge: the stops span the strip in pixels, and the surface's
      // corners round only the edge it sits on (the far corners fall outside the strip).
      return <Svg key={`band-${paint}`} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, right: 0, height: band.height, [band.edge]: 0 }} width="100%" height={band.height}>
        <Defs><LinearGradient id={`${id}-band-${paint}`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={band.height}>{stops(gradient)}</LinearGradient></Defs>
        <Rect width="100%" y={band.edge === 'bottom' ? -radius : 0} height={band.height + radius} rx={radius} ry={radius} fill={`url(#${id}-band-${paint})`} />
      </Svg>;
    })}
  </>;
}
