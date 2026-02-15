import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { VoiceActivityEvent } from './voiceActivityEvents';

export type VoiceActivityState = Readonly<{
  eventsBySessionId: Record<string, ReadonlyArray<VoiceActivityEvent>>;
  maxEventsPerSession: number;

  clearSession: (sessionId: string) => void;
  append: (event: VoiceActivityEvent) => void;
  replaceSessionEvents: (sessionId: string, events: ReadonlyArray<VoiceActivityEvent>) => void;
}>;

function clampMaxEvents(value: number | null | undefined): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  // Allow small caps for tests; production defaults to 200.
  return Math.max(1, Math.min(1000, n || 200));
}

function createInitializer(opts?: Readonly<{ maxEventsPerSession?: number }>) {
  const maxEventsPerSession = clampMaxEvents(opts?.maxEventsPerSession);
  return (set: any): VoiceActivityState => ({
    eventsBySessionId: {},
    maxEventsPerSession,

    clearSession: (sessionId) => {
      const normalized = String(sessionId).trim();
      if (!normalized) return;
      set((state: VoiceActivityState) => {
        if (!state.eventsBySessionId[normalized]) return state as any;
        return {
          ...state,
          eventsBySessionId: {
            ...state.eventsBySessionId,
            [normalized]: [],
          },
        } as any;
      });
    },
    append: (event) => {
      set((state: VoiceActivityState) => {
        const sid = event.sessionId;
        const existing = state.eventsBySessionId[sid] ?? [];
        const next = [...existing, event];
        const capped =
          next.length > state.maxEventsPerSession ? next.slice(next.length - state.maxEventsPerSession) : next;
        return {
          ...state,
          eventsBySessionId: {
            ...state.eventsBySessionId,
            [sid]: capped,
          },
        } as any;
      });
    },
    replaceSessionEvents: (sessionId, events) => {
      const normalized = String(sessionId).trim();
      if (!normalized) return;
      const nextEvents = Array.isArray(events) ? events : [];
      set((state: VoiceActivityState) => {
        const capped =
          nextEvents.length > state.maxEventsPerSession
            ? nextEvents.slice(nextEvents.length - state.maxEventsPerSession)
            : nextEvents;
        return {
          ...state,
          eventsBySessionId: {
            ...state.eventsBySessionId,
            [normalized]: capped,
          },
        } as any;
      });
    },
  });
}

export function createVoiceActivityStore(opts?: Readonly<{ maxEventsPerSession?: number }>) {
  return createStore<VoiceActivityState>(createInitializer(opts));
}

// Default global store for UI usage.
export const useVoiceActivityStore = create<VoiceActivityState>(createInitializer());
