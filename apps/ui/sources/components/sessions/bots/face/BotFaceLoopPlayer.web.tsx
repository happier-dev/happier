import * as React from 'react';
import { View } from 'react-native';

import { useHostActivelyViewedLayoutEffect } from '@/utils/runtime/useHostActivelyViewed';

import type { BotFaceLook, BotFaceLoop } from './botFaceIdle';
import { botFaceLoopSteps, playBotFaceSteps } from './botFaceSteps';

/**
 * Plays a working face's loop on the compositor (Web Animations): each distinct drawing is painted once into its own
 * layer, and one stepped opacity animation per layer shows it for its frames (the layer track of `playBotFaceSteps`;
 * a pet face plays the offset track of the same timing). React renders the layers once; without the platform animation
 * the first drawing stays, as a still face.
 */
export function BotFaceLoopPlayer(props: Readonly<{
  loop: BotFaceLoop;
  seed: number;
  size: number;
  children: (look: BotFaceLook) => React.ReactNode;
}>) {
  const { loop, seed } = props;
  const layers = React.useRef<(unknown | null)[]>([]);
  // Nobody viewing the app: no compositor loop (the first drawing stays); viewing it again resumes in phase.
  useHostActivelyViewedLayoutEffect((viewed) => {
    if (!viewed) return;
    const steps = botFaceLoopSteps(loop, seed);
    const playing = loop.drawings.map((_, drawing) => playBotFaceSteps(layers.current[drawing], steps,
      step => ({ opacity: loop.frames[step]?.drawing === drawing ? 1 : 0 })));
    return () => playing.forEach(animation => animation?.cancel());
  }, [loop, seed]);
  return (
    <View style={{ width: props.size, height: props.size }}>
      {loop.drawings.map((look, drawing) => (
        <View key={drawing} ref={node => { layers.current[drawing] = node; }}
          pointerEvents="none" aria-hidden style={{ position: 'absolute', left: 0, top: 0, opacity: drawing === loop.frames[0]?.drawing ? 1 : 0 }}>
          {props.children(look)}
        </View>
      ))}
    </View>
  );
}
