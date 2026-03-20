import { create } from 'zustand';

import { randomUUID } from '@/platform/randomUUID';

export type VoiceQaProvider = 'local_voice_agent' | 'realtime_elevenlabs';
export type VoiceQaStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error';
export type VoiceQaEntryKind = 'system' | 'user' | 'assistant' | 'provider.raw' | 'error';

export type VoiceQaEntry = Readonly<{
  id: string;
  ts: number;
  kind: VoiceQaEntryKind;
  text: string;
  raw?: string;
}>;

type VoiceQaState = Readonly<{
  provider: VoiceQaProvider | null;
  sessionId: string | null;
  targetSessionId: string | null;
  runtimeSessionId: string | null;
  status: VoiceQaStatus;
  entries: ReadonlyArray<VoiceQaEntry>;
  begin: (
    provider: VoiceQaProvider,
    sessionId: string,
    options?: Readonly<{ targetSessionId?: string | null; runtimeSessionId?: string | null }>,
  ) => void;
  setStatus: (status: VoiceQaStatus) => void;
  setResolvedSessions: (params: Readonly<{ targetSessionId?: string | null; runtimeSessionId?: string | null }>) => void;
  clear: () => void;
  appendSystem: (text: string) => void;
  appendUser: (text: string) => void;
  appendAssistant: (text: string) => void;
  appendError: (text: string) => void;
  appendRealtimeProviderPayload: (payload: unknown) => void;
}>;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractProviderSummary(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object') return safeStringify(payload);

  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();
  const out: string[] = [];

  while (queue.length > 0 && out.length < 3) {
    const next = queue.shift();
    if (!next || typeof next !== 'object') continue;
    if (seen.has(next)) continue;
    seen.add(next);

    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
      if (typeof value === 'string') {
        const normalized = value.trim();
        if (!normalized) continue;
        if (/(text|message|transcript|content|reply|utterance)/i.test(key)) {
          out.push(`${key}: ${normalized}`);
          if (out.length >= 3) break;
        }
      } else if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  if (out.length > 0) return out.join('\n');
  return safeStringify(payload);
}

function createEntry(kind: VoiceQaEntryKind, text: string, raw?: string): VoiceQaEntry {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind,
    text,
    ...(raw ? { raw } : {}),
  };
}

function appendEntry(state: VoiceQaState, entry: VoiceQaEntry): VoiceQaState {
  return {
    ...state,
    entries: [...state.entries, entry],
  };
}

export const useVoiceQaStore = create<VoiceQaState>((set) => ({
  provider: null,
  sessionId: null,
  targetSessionId: null,
  runtimeSessionId: null,
  status: 'idle',
  entries: [],
  begin: (provider, sessionId, options) =>
    set((state) => ({
      ...state,
      provider,
      sessionId: sessionId.trim(),
      targetSessionId: normalizeText(options?.targetSessionId) || null,
      runtimeSessionId: normalizeText(options?.runtimeSessionId) || null,
      status: 'starting',
    })),
  setStatus: (status) =>
    set((state) => ({
      ...state,
      status,
    })),
  setResolvedSessions: ({ targetSessionId, runtimeSessionId }) =>
    set((state) => ({
      ...state,
      targetSessionId: normalizeText(targetSessionId) || null,
      runtimeSessionId: normalizeText(runtimeSessionId) || null,
    })),
  clear: () =>
    set((state) => ({
      ...state,
      entries: [],
    })),
  appendSystem: (text) =>
    set((state) => {
      const normalized = normalizeText(text);
      if (!normalized) return state;
      return appendEntry(state, createEntry('system', normalized));
    }),
  appendUser: (text) =>
    set((state) => {
      const normalized = normalizeText(text);
      if (!normalized) return state;
      return appendEntry(state, createEntry('user', normalized));
    }),
  appendAssistant: (text) =>
    set((state) => {
      const normalized = normalizeText(text);
      if (!normalized) return state;
      return appendEntry(state, createEntry('assistant', normalized));
    }),
  appendError: (text) =>
    set((state) => {
      const normalized = normalizeText(text);
      if (!normalized) return state;
      return appendEntry(state, createEntry('error', normalized));
    }),
  appendRealtimeProviderPayload: (payload) =>
    set((state) => {
      if (state.provider !== 'realtime_elevenlabs') return state;
      const raw = safeStringify(payload);
      const text = extractProviderSummary(payload);
      return appendEntry(state, createEntry('provider.raw', text, raw));
    }),
}));

export function resetVoiceQaStoreForTests(): void {
  useVoiceQaStore.setState({
    provider: null,
    sessionId: null,
    targetSessionId: null,
    runtimeSessionId: null,
    status: 'idle',
    entries: [],
  });
}
