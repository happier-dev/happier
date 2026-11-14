import * as React from 'react';

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { localVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

import { resolveLocalVoiceAdapterSettings, type LocalVoiceSettingsInput } from './localVoiceSettings';

// One message is read at a time; starting another (or pressing the active one) stops the first.
// Playback goes through the shared local-voice controller so it never overlaps a live voice reply.
const listeners = new Set<() => void>();
let activeKey: string | null = null;
// Identifies the current run, so a stopped run that finishes late cannot clear a newer one.
let activeRun = 0;

function setActive(next: string | null): void {
  activeKey = next;
  for (const listener of listeners) listener();
}

export function getReadAloudActiveKey(): string | null {
  return activeKey;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether this message is the one being read; other messages' hooks keep their value and do not rerender. */
export function useIsReadingAloud(key: string): boolean {
  return React.useSyncExternalStore(subscribe, () => activeKey === key, () => false);
}

/**
 * Reads one transcript message aloud with the configured local TTS provider, or stops it when it
 * is already the one playing. Resolves `false` only when the provider failed.
 */
export async function toggleReadAloud(params: Readonly<{
  key: string;
  text: string;
  settings: LocalVoiceSettingsInput;
}>): Promise<boolean> {
  const wasActive = activeKey === params.key;
  activeRun += 1;
  const run = activeRun;
  localVoicePlaybackController.interrupt();
  if (wasActive) {
    setActive(null);
    return true;
  }

  setActive(params.key);
  const { config } = resolveLocalVoiceAdapterSettings(params.settings);
  try {
    return await speakAssistantText({
      text: params.text,
      settings: params.settings,
      networkTimeoutMs: resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000),
      registerPlaybackStopper: localVoicePlaybackController.registerStopper,
      onSpeaking: () => {},
    });
  } finally {
    if (activeRun === run) setActive(null);
  }
}
