import { create } from 'zustand';

export type VoiceContextSeenState = Readonly<{
  shownSessionIds: Readonly<Record<string, true>>;
  hasShownSession: (sessionId: string) => boolean;
  markSessionShown: (sessionId: string) => void;
  clearShownSessions: () => void;
}>;

function normalizeSessionId(value: string): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const useVoiceContextSeenStore = create<VoiceContextSeenState>((set, get) => ({
  shownSessionIds: {},
  hasShownSession: (sessionId) => {
    const id = normalizeSessionId(sessionId);
    if (!id) return false;
    return Boolean(get().shownSessionIds[id]);
  },
  markSessionShown: (sessionId) => {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    set((state) => ({ shownSessionIds: { ...state.shownSessionIds, [id]: true } }));
  },
  clearShownSessions: () => set(() => ({ shownSessionIds: {} })),
}));

