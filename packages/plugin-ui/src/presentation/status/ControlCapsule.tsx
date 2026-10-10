import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierLayoutChangeEvent, HappierPortableStyle } from '../portableTypes.js';
import type { HappierCapsuleHost } from './capsuleHost.js';

/** The capsule's height (a floating frame's controls band) and the padding around its controls. */
export const HAPPIER_CONTROL_CAPSULE_METRICS = Object.freeze({
  height: 32,
  padding: 3,
  gap: 2,
});

/** The visible square of a control that sits in the capsule. */
export const HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE =
  HAPPIER_CONTROL_CAPSULE_METRICS.height - HAPPIER_CONTROL_CAPSULE_METRICS.padding * 2;

export type HappierControlCapsuleProps = Readonly<{
  children: ReactNode;
  host: HappierCapsuleHost;
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  testID: string;
}>;

const BOX_STYLE: HappierPortableStyle = {
  height: HAPPIER_CONTROL_CAPSULE_METRICS.height,
  justifyContent: 'center',
};

const BACKING_STYLE: HappierPortableStyle = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  pointerEvents: 'none',
};

const ROW_STYLE: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: HAPPIER_CONTROL_CAPSULE_METRICS.gap,
  paddingHorizontal: HAPPIER_CONTROL_CAPSULE_METRICS.padding,
};

/**
 * A group of controls on the floating material, for a floating frame's `controls` slot (a source
 * switch, Expand and Close). The material is a backing behind the row, not a clip around it, so a
 * control's press target may overhang the band (a 44 px tall touch target around a 26 px button)
 * without the capsule or the band growing.
 */
export function HappierControlCapsule(props: HappierControlCapsuleProps): ReactElement {
  const { host } = props;
  return (
    <View style={BOX_STYLE} onLayout={props.onLayout} testID={props.testID}>
      <View style={BACKING_STYLE}>
        <host.Surface elevation="low" fill testID={`${props.testID}-material`}>{null}</host.Surface>
      </View>
      <View style={ROW_STYLE}>{props.children}</View>
    </View>
  );
}
