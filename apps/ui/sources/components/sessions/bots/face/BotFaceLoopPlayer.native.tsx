import * as React from 'react';
import { View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';

import { botFaceLoopPhase, type BotFaceLook, type BotFaceLoop } from './botFaceIdle';

/**
 * Plays a working face's loop on the UI thread (Reanimated): each distinct drawing is painted once into its own layer,
 * and one shared value steps through the frames. React renders the layers once.
 */
export function BotFaceLoopPlayer(props: Readonly<{
  loop: BotFaceLoop;
  seed: number;
  size: number;
  children: (look: BotFaceLook) => React.ReactNode;
}>) {
  const { loop, seed } = props;
  const shown = useSharedValue(-1);
  React.useEffect(() => {
    const { periodMs, frames } = loop;
    const n = frames.length;
    const hold = (k: number) => (k + 1 < n ? frames[k + 1]!.atMs : periodMs) - frames[k]!.atMs;
    const phase = botFaceLoopPhase(loop, seed, Date.now());
    let k0 = 0;
    while (k0 + 1 < n && frames[k0 + 1]!.atMs <= phase) k0++;
    shown.set(frames[k0]!.drawing);
    if (n > 1) {
      // Switch to frame k after holding frame k − 1; the first hold is what is left of the current frame.
      const to = (k: number, ms: number) => withDelay(ms, withTiming(frames[k % n]!.drawing, { duration: 0 }));
      const cycle = frames.map((_, j) => to(k0 + 2 + j, hold((k0 + 1 + j) % n)));
      const rest = (frames[k0 + 1]?.atMs ?? periodMs) - phase;
      shown.set(withSequence(to(k0 + 1, rest), withRepeat(withSequence(...cycle), -1)));
    }
    return () => cancelAnimation(shown);
  }, [loop, seed, shown]);
  return (
    <View style={{ width: props.size, height: props.size }}>
      {loop.drawings.map((look, drawing) => (
        <BotFaceLoopLayer key={drawing} shown={shown} drawing={drawing}>{props.children(look)}</BotFaceLoopLayer>
      ))}
    </View>
  );
}

function BotFaceLoopLayer(props: Readonly<{ shown: SharedValue<number>; drawing: number; children: React.ReactNode }>) {
  const { shown, drawing } = props;
  const style = useAnimatedStyle(() => ({ opacity: shown.get() === drawing ? 1 : 0 }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0 }, style]}>{props.children}</Animated.View>;
}
