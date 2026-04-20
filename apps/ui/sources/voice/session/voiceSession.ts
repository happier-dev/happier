import * as React from 'react';
import { createVoiceSessionManager } from './voiceSessionManager';
import { getVoiceSessionLifecycleController } from './voiceSessionLifecycleControllerStore';
import { getVoiceSessionSnapshot, subscribeToVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceSessionSnapshot } from './types';

export const voiceSessionManager = createVoiceSessionManager({
  getLifecycleController: () => getVoiceSessionLifecycleController(),
});

export function useVoiceSessionSnapshot(): VoiceSessionSnapshot {
  return React.useSyncExternalStore(
    subscribeToVoiceSessionSnapshot,
    getVoiceSessionSnapshot,
    getVoiceSessionSnapshot,
  );
}
