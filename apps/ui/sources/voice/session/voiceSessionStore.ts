import { create } from 'zustand';

import type { VoiceSessionSnapshot } from './types';

type VoiceSessionState = VoiceSessionSnapshot & {
  setSnapshot: (snapshot: VoiceSessionSnapshot) => void;
};

const DEFAULT_SNAPSHOT: VoiceSessionSnapshot = {
  adapterId: null,
  sessionId: null,
  status: 'disconnected',
  mode: 'idle',
  canStop: false,
};

export const useVoiceSessionStore = create<VoiceSessionState>((set) => ({
  ...DEFAULT_SNAPSHOT,
  setSnapshot: (snapshot) =>
    set(() => ({
      ...snapshot,
      // Ensure optional error fields clear when omitted from a later snapshot.
      errorCode: snapshot.errorCode,
      errorMessage: snapshot.errorMessage,
    })),
}));

export function getVoiceSessionSnapshot(): VoiceSessionSnapshot {
  const { setSnapshot: _ignore, ...snapshot } = useVoiceSessionStore.getState();
  return snapshot;
}

export function setVoiceSessionSnapshot(snapshot: VoiceSessionSnapshot): void {
  useVoiceSessionStore.getState().setSnapshot(snapshot);
}
