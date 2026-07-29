import { create } from 'zustand';
import type { BundledVoiceProviderDiagnosticEvent } from '@happier-dev/bundled-voice-runtime-contract';

import { randomUUID } from '@/platform/randomUUID';

const MAX_VOICE_QA_ENTRIES = 500;

export type VoiceQaProvider = 'local_voice_agent' | 'realtime_conversation';
export type VoiceQaStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error';
export type VoiceQaEntryKind = 'system' | 'user' | 'assistant' | 'provider.event' | 'error';

export type VoiceQaEntry = Readonly<{
  id: string;
  ts: number;
  kind: VoiceQaEntryKind;
  text: string;
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
  appendRealtimeProviderEvent: (event: BundledVoiceProviderDiagnosticEvent) => void;
}>;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function createProviderEventSummary(event: BundledVoiceProviderDiagnosticEvent): string {
  return [
    `provider=${event.providerId}`,
    `event=${event.eventType}`,
    `bytes=${event.payloadBytes ?? 'unknown'}`,
    `class=${event.redactionClass}`,
  ].join(' ');
}

function createEntry(kind: VoiceQaEntryKind, text: string): VoiceQaEntry {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind,
    text,
  };
}

function appendEntry(state: VoiceQaState, entry: VoiceQaEntry): VoiceQaState {
  const retainedEntries = state.entries.length >= MAX_VOICE_QA_ENTRIES
    ? state.entries.slice(-(MAX_VOICE_QA_ENTRIES - 1))
    : state.entries;
  return {
    ...state,
    entries: [...retainedEntries, entry],
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
  appendRealtimeProviderEvent: (event) =>
    set((state) => {
      if (state.provider !== 'realtime_conversation') return state;
      return appendEntry(state, createEntry('provider.event', createProviderEventSummary(event)));
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
