import { create } from 'zustand';

export type LocalVoiceStatus = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

export type LocalVoiceState = {
  status: LocalVoiceStatus;
  sessionId: string | null;
  error: string | null;
};

const useLocalVoiceStore = create<LocalVoiceState>(() => ({
  status: 'idle',
  sessionId: null,
  error: null,
}));

export function getLocalVoiceState(): LocalVoiceState {
  return useLocalVoiceStore.getState();
}

export const useLocalVoiceStatus = () => useLocalVoiceStore((state) => state.status);

export function subscribeLocalVoiceState(listener: () => void): () => void {
  return useLocalVoiceStore.subscribe(() => listener());
}

export function patchLocalVoiceState(patch: Partial<LocalVoiceState>): void {
  useLocalVoiceStore.setState((state) => ({ ...state, ...patch }));
}

export function setIdleStateUnlessRecording(sessionId: string): void {
  const current = getLocalVoiceState();
  if (current.status === 'recording' && current.sessionId === sessionId) {
    return;
  }
  // A completed voice turn returns to an idle (ready) state, but we keep the active sessionId
  // until the user explicitly hangs up.
  // Preserve any existing error so the UI can surface it until the user retries.
  patchLocalVoiceState({ status: 'idle', sessionId });
}

