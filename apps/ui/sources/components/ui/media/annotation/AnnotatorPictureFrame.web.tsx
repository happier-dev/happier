import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { resolveCropView } from './markGeometry';
import type { AnnotatorPictureFrameProps } from './annotatorPictureFrameTypes';
import { useAnnotatorShownCrop } from './useImageAnnotator';

/**
 * The picture's box under annotation. An applied crop re-centres the picture in the unchanged box
 * (MIS §3.6): containers don't resize with their content, and the browser's transition retargets from
 * the current frame, so entering and leaving Crop fly the same path. Without an annotator it's the plain
 * box, one element type throughout, so opening Annotate never remounts the picture.
 */
export function AnnotatorPictureFrame(props: AnnotatorPictureFrameProps) {
  const ref = React.useRef<View>(null);
  const crop = useAnnotatorShownCrop(props.annotator);
  const reducedMotion = useReducedMotionPreference();
  const { width, height } = props.size ?? { width: 0, height: 0 };
  const image = props.annotator?.source;
  const radius = props.radius ?? 0;
  const shown = React.useRef(crop);
  React.useLayoutEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;
    const moved = shown.current !== crop;
    shown.current = crop;
    const view = crop && image && width > 0 ? resolveCropView(crop, image, { width, height }) : null;
    node.style.transformOrigin = '0 0';
    node.style.transition = moved && !reducedMotion
      ? ['transform', 'clip-path'].map((property) => `${property} ${motionTokens.inPlaceMorph.frameMs}ms ${motionTokens.easingCss.standard}`).join(', ')
      : '';
    node.style.transform = view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : 'translate(0px, 0px) scale(1)';
    // The clip is drawn inside the scaled box, so its rounding is divided back to the on-screen radius.
    const round = radius > 0 && view ? ` round ${radius / view.scale}px` : '';
    node.style.clipPath = view ? `inset(${view.clip.top}px ${view.clip.right}px ${view.clip.bottom}px ${view.clip.left}px${round})` : '';
    if (moved && reducedMotion) node.animate({ opacity: [0, 1] }, { duration: motionTokens.inPlaceMorph.reducedCrossFadeMs });
  }, [crop, height, image, radius, reducedMotion, width]);
  return (
    <View ref={ref} style={[props.style as StyleProp<ViewStyle>, radius > 0 ? { borderRadius: radius, overflow: 'hidden' } : null]}>
      {props.children}
    </View>
  );
}
