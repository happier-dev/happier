import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import {
  HappierHorizontalScrollEdgeMask,
  HappierHorizontalScrollEdgeMaskShape,
  type HappierHorizontalScrollEdgeMaskNativeHost,
  type HappierHorizontalScrollEdgeMaskProps,
} from '@happier-dev/plugin-ui/presentation';

const NATIVE_MASK_HOST: HappierHorizontalScrollEdgeMaskNativeHost = {
  renderMask: ({ style, ...input }) => <MaskedView {...input} style={style as StyleProp<ViewStyle>} />,
  renderGradient: ({ style, ...input }) => <LinearGradient {...input} style={style as StyleProp<ViewStyle>} />,
};

/** Native renderer binding; all mask geometry and composition belong to plugin-ui. */
export function HorizontalScrollEdgeMask(props: Omit<HappierHorizontalScrollEdgeMaskProps, 'nativeHost'>) {
  return <HappierHorizontalScrollEdgeMask {...props} nativeHost={NATIVE_MASK_HOST} />;
}

export function HorizontalScrollEdgeMaskShape(props: Pick<HappierHorizontalScrollEdgeMaskProps, 'ramps' | 'width'>) {
  return <HappierHorizontalScrollEdgeMaskShape {...props} renderGradient={NATIVE_MASK_HOST.renderGradient} />;
}
