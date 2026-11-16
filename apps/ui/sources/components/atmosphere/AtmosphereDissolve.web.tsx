import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { orderedFadeMask } from './orderedFadeMask';
import { orderedDissolve } from './orderedDissolve';
import type { AtmosphereDissolveProps } from './atmosphereDissolve.types';
import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';

function maskUrl(mask: ReturnType<typeof orderedFadeMask>): string {
  const canvas = document.createElement('canvas');
  canvas.width = mask.width;
  canvas.height = mask.height;
  canvas
    .getContext('2d')
    ?.putImageData(new ImageData(mask.rgba, mask.width, mask.height), 0, 0);
  const url = `url(${canvas.toDataURL('image/png')})`;
  releaseCanvasBackingStore(canvas);
  return url;
}

/**
 * Brings the atmosphere in and takes it away. Arrival is a plain fade on the standard curve, any other
 * leaving a shorter fade on the exit curve; leaving on send is the brand's
 * ordered fade climbing the art (an alpha mask that moves up in whole lattice periods, so the dots
 * thin in place); under reduced motion both are a short cross-fade. Nothing runs at rest.
 */
export function AtmosphereDissolve(props: AtmosphereDissolveProps) {
  const ref = React.useRef<HTMLElement | null>(null);
  // A removed pane must not deliver an old send's completion into the shared stage.
  React.useLayoutEffect(() => {
    const node = ref.current;
    return () => node?.getAnimations().forEach(animation => animation.cancel());
  }, []);
  const onHidden = React.useRef(props.onHidden);
  onHidden.current = props.onHidden;
  const shown = React.useRef<boolean | null>(null);
  const { visible, leave, height, reducedMotion } = props;
  // Read only at the arrival it describes: changing it alone starts nothing.
  const arrive = React.useRef(props.arrive);
  arrive.current = props.arrive;
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previous = shown.current;
    shown.current = visible;
    if (previous === visible) return;
    node.getAnimations().forEach((animation) => animation.cancel());
    const timing = motionTokens.atmosphere;
    if (visible) {
      node.style.maskImage = '';
      node.style.webkitMaskImage = '';
      node.style.opacity = '1';
      // A surface's first frame keeps what it can already draw: only a later arrival fades in.
      if (previous === null || arrive.current === 'instant') return;
      node.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: reducedMotion
          ? timing.reducedCrossFadeMs
          : timing.readyFadeMs,
        easing: motionTokens.easingCss.standard,
      });
      return;
    }
    if (previous === null) {
      node.style.opacity = '0';
      return;
    }
    // Completion belongs to this departure, not a later send while the art stays hidden.
    const notifyHidden = onHidden.current;
    const done = () => {
      node.style.opacity = '0';
      notifyHidden?.();
    };
    if (reducedMotion || leave === 'fade' || height <= 0) {
      node.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: reducedMotion
          ? timing.reducedCrossFadeMs
          : timing.leaveFadeMs,
        easing: motionTokens.easingCss.exit,
        fill: 'forwards',
      }).onfinish = done;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const { mask, travel, steps } = orderedDissolve(height, dpr);
    node.style.maskImage = maskUrl(mask);
    node.style.webkitMaskImage = node.style.maskImage;
    node.style.maskRepeat = 'repeat-x';
    node.style.webkitMaskRepeat = 'repeat-x';
    node.style.maskSize = `${mask.cssWidth}px ${mask.cssHeight}px`;
    node.style.webkitMaskSize = node.style.maskSize;
    // Whole lattice periods keep each dot on its cell while the window climbs past it.
    node.animate(
      [
        { maskPosition: '0px 0px', webkitMaskPosition: '0px 0px' },
        {
          maskPosition: `0px ${-travel}px`,
          webkitMaskPosition: `0px ${-travel}px`,
        },
      ],
      {
        duration: timing.sendDissolveMs,
        easing: `steps(${steps}, end)`,
        fill: 'forwards',
      },
    ).onfinish = done;
  }, [visible, leave, height, reducedMotion]);
  return (
    <View
      ref={ref as unknown as React.Ref<View>}
      pointerEvents="none"
      aria-hidden
      style={props.style as StyleProp<ViewStyle>}
    >
      {props.children}
    </View>
  );
}
