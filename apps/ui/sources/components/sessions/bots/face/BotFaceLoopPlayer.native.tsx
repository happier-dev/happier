import * as React from 'react';
import { View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';

import type { BotFaceLook, BotFaceLoop } from './botFaceIdle';
import { botFaceLoopSteps, startBotFaceSteps } from './botFaceSteps';

/**
 * Plays a working face's loop on the UI thread (Reanimated): each distinct drawing is painted once into its own layer,
 * and one shared value steps through the frames (the layer track of `startBotFaceSteps`; a pet face plays the offset
 * track of the same timing). React renders the layers once.
 */
export function BotFaceLoopPlayer(props: Readonly<{
  loop: BotFaceLoop;
  seed: number;
  size: number;
  children: (look: BotFaceLook) => React.ReactNode;
}>) {
  const { loop, seed } = props;
  const step = useSharedValue(0);
  // Nobody viewing the app: the UI-thread loop stops on its current drawing; viewing it again resumes in phase.
  useHostActivelyViewedEffect((viewed) => {
    if (!viewed) return;
    startBotFaceSteps(step, botFaceLoopSteps(loop, seed));
    return () => cancelAnimation(step);
  }, [loop, seed, step]);
  const shown = React.useMemo(() => loop.frames.map(frame => frame.drawing), [loop]);
  return (
    <View style={{ width: props.size, height: props.size }}>
      {loop.drawings.map((look, drawing) => (
        <BotFaceLoopLayer key={drawing} step={step} shown={shown} drawing={drawing}>{props.children(look)}</BotFaceLoopLayer>
      ))}
    </View>
  );
}

function BotFaceLoopLayer(props: Readonly<{ step: SharedValue<number>; shown: readonly number[]; drawing: number; children: React.ReactNode }>) {
  const { step, shown, drawing } = props;
  const style = useAnimatedStyle(() => ({ opacity: (shown[step.get()] ?? shown[0]) === drawing ? 1 : 0 }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0 }, style]}>{props.children}</Animated.View>;
}
