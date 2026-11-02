import * as React from 'react';
import Animated, { useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { resolveCropView } from './markGeometry';
import type { AnnotatorPictureFrameProps } from './annotatorPictureFrameTypes';
import { useAnnotatorShownCrop } from './useImageAnnotator';

/**
 * Native twin of the web frame: an applied crop re-centres the picture in its unchanged box (MIS §3.6).
 * What lies outside the crop is covered by the canvas, because a View can't clip to an inner rectangle
 * while its own transform moves.
 */
export function AnnotatorPictureFrame(props: AnnotatorPictureFrameProps) {
  const crop = useAnnotatorShownCrop(props.annotator);
  const reducedMotion = useReducedMotionPreference();
  const image = props.annotator?.source;
  const { width, height } = props.size ?? { width: 0, height: 0 };
  const view = crop && image && width > 0 ? resolveCropView(crop, image, { width, height }) : null;
  const targetX = view ? view.x + ((view.scale - 1) * width) / 2 : 0;
  const targetY = view ? view.y + ((view.scale - 1) * height) / 2 : 0;
  const targetScale = view?.scale ?? 1;
  const duration = reducedMotion ? 0 : motionTokens.inPlaceMorph.frameMs;
  const easing = reanimatedMotionTokens.easing.standard;
  const x = useDerivedValue(() => withTiming(targetX, { duration, easing }), [duration, easing, targetX]);
  const y = useDerivedValue(() => withTiming(targetY, { duration, easing }), [duration, easing, targetY]);
  const scale = useDerivedValue(() => withTiming(targetScale, { duration, easing }), [duration, easing, targetScale]);
  const transform = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  const rounded = props.radius ? { borderRadius: props.radius, overflow: 'hidden' as const } : null;
  return <Animated.View style={[props.style, rounded, transform]}>{props.children}</Animated.View>;
}
