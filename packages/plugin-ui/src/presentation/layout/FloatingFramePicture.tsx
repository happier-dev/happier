import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';
import { HAPPIER_FLOATING_FRAME_METRICS } from './FloatingFrame.js';

export type FloatingFramePictureProps = Readonly<{
  /**
   * `true`: the picture is a floating frame's body (rounded, lifted, clipped). `false`: the same
   * element tree drawn flush in a pane, so a body that moves between a pane and a frame is never
   * remounted.
   */
  framed: boolean;
  /** The host's floating elevation for the picture (its shadow tokens); the picture has no card. */
  elevationStyle?: HappierPortableStyle;
  /**
   * The colour of the thin ring that says the person, not the Agent, drives the picture. Absent or
   * null: no ring.
   */
  drivenRingColor?: string | null;
  children: ReactNode;
  testID?: string;
}>;

const FILL: HappierPortableStyle = { flex: 1, minHeight: 0 };
const RADIUS = HAPPIER_FLOATING_FRAME_METRICS.bodyRadius;
const CLIP: HappierPortableStyle = { ...FILL, borderRadius: RADIUS, overflow: 'hidden' };
const RING: HappierPortableStyle = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  borderRadius: RADIUS,
  borderWidth: 2,
  pointerEvents: 'none',
};

/**
 * The material of a floating frame's body: the live picture itself, rounded to the frame's body
 * radius and lifted off what is behind it, never framed by a card or a backing. A thin ring marks
 * that the person drives it. Any `FloatingFrame` body uses this so every frame's picture reads the
 * same; the host supplies only its elevation and ring colour tokens.
 */
export function FloatingFramePicture(props: FloatingFramePictureProps): ReactElement {
  const { framed } = props;
  return (
    <View
      style={framed ? [FILL, { borderRadius: RADIUS }, props.elevationStyle] : FILL}
      testID={props.testID}
    >
      <View style={framed ? CLIP : FILL}>{props.children}</View>
      {framed && props.drivenRingColor ? (
        <View style={[RING, { borderColor: props.drivenRingColor }]} />
      ) : null}
    </View>
  );
}
