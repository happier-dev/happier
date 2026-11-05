import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';

import {
  resolveScrollEdgeMaskStopPx,
  type HorizontalScrollEdgeMaskRamps,
} from './resolveScrollEdgeMaskStyle';

const CLEAR = 'rgba(0,0,0,0)';
const SOLID = 'black';
const LEFT = { x: 0, y: 0.5 } as const;
const RIGHT = { x: 1, y: 0.5 } as const;

/**
 * The native form of the horizontal edge mask (`resolveHorizontalScrollEdgeMaskStyle` is the web one):
 * it fades the rail's own content, so a cut chip goes away on a translucent surface where a painted fade
 * has no colour to cover it. The mask reads alpha only; black keeps a pixel.
 */
export function HorizontalScrollEdgeMask(
  props: Readonly<{
    ramps: HorizontalScrollEdgeMaskRamps | null;
    width: number;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
  }>,
) {
  return (
    <MaskedView
      style={props.style}
      maskElement={
        <HorizontalScrollEdgeMaskShape
          ramps={props.ramps}
          width={props.width}
        />
      }
    >
      {props.children}
    </MaskedView>
  );
}

export function HorizontalScrollEdgeMaskShape(
  props: Readonly<{
    ramps: HorizontalScrollEdgeMaskRamps | null;
    width: number;
  }>,
) {
  const { ramps, width } = props;
  // Before the rail is measured there is nothing to cut: keep every pixel rather than hide the chips.
  if (!ramps || !(width > 0))
    return <View style={[StyleSheet.absoluteFill, styles.solid]} />;
  const px = (stop: Parameters<typeof resolveScrollEdgeMaskStopPx>[0]) =>
    resolveScrollEdgeMaskStopPx(stop, width);
  const solidFrom = ramps.start ? px(ramps.start.solid) : 0;
  const solidUntil = ramps.end ? px(ramps.end.solid) : width;
  return (
    <View style={StyleSheet.absoluteFill}>
      {ramps.start ? (
        <LinearGradient
          testID="scroll-edge-mask-start"
          colors={[CLEAR, SOLID]}
          start={LEFT}
          end={RIGHT}
          style={[
            styles.ramp,
            {
              left: px(ramps.start.clear),
              width: Math.max(0, solidFrom - px(ramps.start.clear)),
            },
          ]}
        />
      ) : null}
      <View
        testID="scroll-edge-mask-solid"
        style={[
          styles.ramp,
          styles.solid,
          { left: solidFrom, width: Math.max(0, solidUntil - solidFrom) },
        ]}
      />
      {ramps.end ? (
        <LinearGradient
          testID="scroll-edge-mask-end"
          colors={[SOLID, CLEAR]}
          start={LEFT}
          end={RIGHT}
          style={[
            styles.ramp,
            {
              left: solidUntil,
              width: Math.max(0, px(ramps.end.clear) - solidUntil),
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  ramp: { position: 'absolute', top: 0, bottom: 0 },
  solid: { backgroundColor: SOLID },
});
