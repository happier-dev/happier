import * as React from 'react';

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

import { resolveLocalVoiceAdapterSettings, type LocalVoiceSettingsInput } from './localVoiceSettings';

// One message is read at a time; starting another (or pressing the active one) stops the first.
const playbackController = createVoicePlaybackController();
const listeners = new Set<() => void>();
let activeKey: string | null = null;

function setActiveKey(next: string | null): void {
  activeKey = next;
  for (const listener of listeners) listener();
}

export function getReadAloudActiveKey(): string | null {
  return activeKey;
}

export function useReadAloudActiveKey(): string | null {
  const subscribe = React.useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return React.useSyncExternalStore(subscribe, getReadAloudActiveKey, () => null);
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
  playbackController.interrupt();
  if (wasActive) {
    setActiveKey(null);
    return true;
  }

  setActiveKey(params.key);
  const { config } = resolveLocalVoiceAdapterSettings(params.settings);
  try {
    return await speakAssistantText({
      text: params.text,
      settings: params.settings,
      networkTimeoutMs: resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000),
      registerPlaybackStopper: playbackController.registerStopper,
      onSpeaking: () => {},
    });
  } finally {
    if (activeKey === params.key) setActiveKey(null);
  }
}
