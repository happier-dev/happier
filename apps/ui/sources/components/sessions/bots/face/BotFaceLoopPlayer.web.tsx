import * as React from 'react';
import { View } from 'react-native';

import { useHostActivelyViewedLayoutEffect } from '@/utils/runtime/useHostActivelyViewed';

import { botFaceLoopPhase, type BotFaceLook, type BotFaceLoop } from './botFaceIdle';

type Animator = { animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation };

/**
 * Plays a working face's loop on the compositor (Web Animations): each distinct drawing is painted once into its own
 * layer, and one stepped opacity animation per layer shows it for its frames. React renders the layers once; without
 * the platform animation the first drawing stays, as a still face.
 */
export function BotFaceLoopPlayer(props: Readonly<{
  loop: BotFaceLoop;
  seed: number;
  size: number;
  children: (look: BotFaceLook) => React.ReactNode;
}>) {
  const { loop, seed } = props;
  const layers = React.useRef<(Animator | null)[]>([]);
  // Nobody viewing the app: no compositor loop (the first drawing stays); viewing it again resumes in phase.
  useHostActivelyViewedLayoutEffect((viewed) => {
    if (!viewed) return;
    const { periodMs, frames } = loop;
    const phase = botFaceLoopPhase(loop, seed, Date.now());
    const playing = loop.drawings.map((_, drawing) => {
      const node = layers.current[drawing];
      if (!node?.animate) return null;
      const keyframes: Keyframe[] = frames.map(frame => ({ offset: frame.atMs / periodMs, opacity: frame.drawing === drawing ? 1 : 0, easing: 'step-end' }));
      keyframes.push({ offset: 1, opacity: frames.at(-1)?.drawing === drawing ? 1 : 0 });
      const animation = node.animate(keyframes, { duration: periodMs, iterations: Infinity });
      animation.currentTime = phase;
      return animation;
    });
    return () => playing.forEach(animation => animation?.cancel());
  }, [loop, seed]);
  return (
    <View style={{ width: props.size, height: props.size }}>
      {loop.drawings.map((look, drawing) => (
        <View key={drawing} ref={node => { layers.current[drawing] = node as unknown as Animator | null; }}
          pointerEvents="none" aria-hidden style={{ position: 'absolute', left: 0, top: 0, opacity: drawing === loop.frames[0]?.drawing ? 1 : 0 }}>
          {props.children(look)}
        </View>
      ))}
    </View>
  );
}
