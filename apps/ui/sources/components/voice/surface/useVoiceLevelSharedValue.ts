import * as React from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import {
  voiceRuntimeLevelStore,
  type VoiceRuntimeLevelChannel,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';

export type VoiceLevelSharedValues = Readonly<{
  level: SharedValue<number>;
  sourceActive: SharedValue<number>;
}>;

/**
 * UI-only bridge from the React-free runtime meter to a Reanimated value.
 * Updates mutate the shared value directly and never enter React state.
 */
export function useVoiceLevelSharedValue(channel: VoiceRuntimeLevelChannel): VoiceLevelSharedValues {
  const initial = voiceRuntimeLevelStore.getSnapshot();
  const level = useSharedValue(channel === 'input' ? initial.inputLevel : initial.outputLevel);
  const sourceActive = useSharedValue(
    (channel === 'input' ? initial.inputSourceActive : initial.outputSourceActive) ? 1 : 0,
  );

  React.useEffect(() => voiceRuntimeLevelStore.subscribe(channel, (next) => {
    level.set(next.level);
    sourceActive.set(next.sourceActive ? 1 : 0);
  }), [channel, level, sourceActive]);

  return React.useMemo(() => Object.freeze({ level, sourceActive }), [level, sourceActive]);
}
