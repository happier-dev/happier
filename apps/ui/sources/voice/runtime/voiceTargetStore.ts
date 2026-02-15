import { create } from 'zustand';

export type VoiceAssistantScope = 'session' | 'global';

export type VoiceTargetState = Readonly<{
  scope: VoiceAssistantScope;
  primaryActionSessionId: string | null;
  trackedSessionIds: ReadonlyArray<string>;
  lastFocusedSessionId: string | null;
  setScope: (scope: VoiceAssistantScope) => void;
  setPrimaryActionSessionId: (sessionId: string | null) => void;
  setTrackedSessionIds: (sessionIds: ReadonlyArray<string>) => void;
  addTrackedSessionId: (sessionId: string) => void;
  removeTrackedSessionId: (sessionId: string) => void;
  setLastFocusedSessionId: (sessionId: string | null) => void;
}>;

function normalizeSessionId(value: string | null): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTrackedSessionIds(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const id = normalizeSessionId(raw);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out;
}

export const useVoiceTargetStore = create<VoiceTargetState>((set) => ({
  scope: 'global',
  primaryActionSessionId: null,
  trackedSessionIds: [],
  lastFocusedSessionId: null,
  setScope: (scope) => set(() => ({ scope })),
  setPrimaryActionSessionId: (sessionId) => set(() => ({ primaryActionSessionId: normalizeSessionId(sessionId) })),
  setTrackedSessionIds: (sessionIds) => set(() => ({ trackedSessionIds: normalizeTrackedSessionIds(sessionIds) })),
  addTrackedSessionId: (sessionId) =>
    set((state) => ({ trackedSessionIds: normalizeTrackedSessionIds([...state.trackedSessionIds, sessionId]) })),
  removeTrackedSessionId: (sessionId) =>
    set((state) => ({
      trackedSessionIds: state.trackedSessionIds.filter((id) => id !== normalizeSessionId(sessionId)),
    })),
  setLastFocusedSessionId: (sessionId) => set(() => ({ lastFocusedSessionId: normalizeSessionId(sessionId) })),
}));
