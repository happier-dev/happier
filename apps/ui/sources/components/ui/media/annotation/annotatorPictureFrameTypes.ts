import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { ImageAnnotator } from './types';

export type AnnotatorPictureFrameProps = Readonly<{
  annotator: ImageAnnotator | null;
  size: Readonly<{ width: number; height: number }> | undefined;
  style?: StyleProp<ViewStyle>;
  /** Corner radius of the picture; an applied crop keeps the same rounded corners. */
  radius?: number;
  children: React.ReactNode;
}>;
