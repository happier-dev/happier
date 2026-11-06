import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { HappierStyleProp } from '../portableTypes.js';
import { resolveHorizontalScrollEdgeMaskRampsStyle, resolveScrollEdgeMaskStopPx, type HorizontalScrollEdgeMaskRamps } from './scrollEdgeMask.js';

export type HappierHorizontalScrollEdgeMaskGradient = Readonly<{
  testID: string;
  colors: readonly [string, string];
  start: Readonly<{ x: number; y: number }>;
  end: Readonly<{ x: number; y: number }>;
  style: HappierStyleProp;
}>;

export type HappierHorizontalScrollEdgeMaskNativeHost = Readonly<{
  renderMask: (input: Readonly<{ style?: HappierStyleProp; maskElement: React.ReactElement; children: React.ReactNode }>) => React.ReactNode;
  renderGradient: (input: HappierHorizontalScrollEdgeMaskGradient) => React.ReactNode;
}>;

export type HappierHorizontalScrollEdgeMaskProps = Readonly<{
  ramps: HorizontalScrollEdgeMaskRamps | null;
  width: number;
  style?: HappierStyleProp;
  children: React.ReactNode;
  nativeHost?: HappierHorizontalScrollEdgeMaskNativeHost;
}>;

/** Fade the rail's own pixels; its platform adapter supplies only the native mask and gradient leaves. */
export function HappierHorizontalScrollEdgeMask(props: HappierHorizontalScrollEdgeMaskProps) {
  if (Platform.OS !== 'web' && props.nativeHost) {
    return <>{props.nativeHost.renderMask({
      style: props.style,
      maskElement: <HappierHorizontalScrollEdgeMaskShape ramps={props.ramps} width={props.width}
        renderGradient={props.nativeHost.renderGradient} />,
      children: props.children,
    })}</>;
  }
  return <View style={[props.style, Platform.OS === 'web' ? resolveHorizontalScrollEdgeMaskRampsStyle(props.ramps) : null]}>{props.children}</View>;
}

/** The native alpha shape, using the same ramp stops as the web CSS mask. */
export function HappierHorizontalScrollEdgeMaskShape(props: Readonly<{
  ramps: HorizontalScrollEdgeMaskRamps | null;
  width: number;
  renderGradient: HappierHorizontalScrollEdgeMaskNativeHost['renderGradient'];
}>) {
  const { ramps, width } = props;
  if (!ramps || !(width > 0)) return <View style={[StyleSheet.absoluteFill, styles.solid]} />;
  const px = (stop: Parameters<typeof resolveScrollEdgeMaskStopPx>[0]) => resolveScrollEdgeMaskStopPx(stop, width);
  const solidFrom = ramps.start ? px(ramps.start.solid) : 0;
  const solidUntil = ramps.end ? px(ramps.end.solid) : width;
  return <View style={StyleSheet.absoluteFill}>
    {ramps.start ? props.renderGradient({
      testID: 'scroll-edge-mask-start', colors: [CLEAR, SOLID], start: LEFT, end: RIGHT,
      style: [styles.ramp, { left: px(ramps.start.clear), width: Math.max(0, solidFrom - px(ramps.start.clear)) }],
    }) : null}
    <View testID="scroll-edge-mask-solid" style={[styles.ramp, styles.solid,
      { left: solidFrom, width: Math.max(0, solidUntil - solidFrom) }]} />
    {ramps.end ? props.renderGradient({
      testID: 'scroll-edge-mask-end', colors: [SOLID, CLEAR], start: LEFT, end: RIGHT,
      style: [styles.ramp, { left: solidUntil, width: Math.max(0, px(ramps.end.clear) - solidUntil) }],
    }) : null}
  </View>;
}

const CLEAR = 'rgba(0,0,0,0)';
const SOLID = 'black';
const LEFT = { x: 0, y: 0.5 } as const;
const RIGHT = { x: 1, y: 0.5 } as const;
const styles = StyleSheet.create({
  ramp: { position: 'absolute', top: 0, bottom: 0 },
  solid: { backgroundColor: SOLID },
});
