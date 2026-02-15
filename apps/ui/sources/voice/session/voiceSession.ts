import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import { getVoiceAdapterRegistry } from './voiceAdapterRegistry';
import { createVoiceSessionManager } from './voiceSessionManager';
import { useVoiceSessionStore } from './voiceSessionStore';

export const voiceSessionManager = createVoiceSessionManager({
  resolveActiveAdapterId: () => {
    const settings: any = storage.getState().settings;
    return settings?.voice?.providerId ?? 'off';
  },
  getAdapter: (adapterId) => {
    const registry = getVoiceAdapterRegistry();
    return registry.get(adapterId) ?? null;
  },
});

export function useVoiceSessionSnapshot() {
  // In React 18+ concurrent rendering, selectors must return a cached value when the
  // underlying store hasn't changed. `useShallow` memoizes the slice so we don't
  // create a new object on every getSnapshot call (which can trigger infinite rerenders).
  return useVoiceSessionStore(
    useShallow((state) => ({
      adapterId: state.adapterId,
      sessionId: state.sessionId,
      status: state.status,
      mode: state.mode,
      canStop: state.canStop,
      errorCode: state.errorCode,
      errorMessage: state.errorMessage,
    }))
  );
}
