import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { createBuiltinVoiceAdapters } from '@/voice/adapters/registerBuiltinVoiceAdapters';

import { getVoiceAdapterRegistry, registerVoiceAdapters } from './voiceAdapterRegistry';
import { setVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceSessionSnapshot } from './types';

export function VoiceSessionRuntime(): React.ReactElement | null {
  const voice = useSetting('voice') as any;
  const providerId = voice?.providerId ?? 'off';
  const [registered, setRegistered] = React.useState(false);

  // Ensure adapters are registered before the user can interact with voice controls.
  React.useLayoutEffect(() => {
    registerVoiceAdapters(createBuiltinVoiceAdapters());
    setRegistered(true);
  }, []);

  const computeSnapshot = React.useCallback((): VoiceSessionSnapshot => {
    const registry = getVoiceAdapterRegistry();
    const adapters = registry.list();
    const snapshots = adapters.map((adapter) => adapter.getSnapshot());

    const preferred =
      providerId !== 'off'
        ? snapshots.find((snap) => snap.adapterId === providerId && snap.status !== 'disconnected')
        : null;
    const active = preferred ?? snapshots.find((snap) => snap.status !== 'disconnected') ?? null;
    return active ?? {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };
  }, [providerId]);

  const publishSnapshot = React.useCallback(() => {
    setVoiceSessionSnapshot(computeSnapshot());
  }, [computeSnapshot]);

  React.useEffect(() => {
    if (!registered) return;
    publishSnapshot();
  }, [publishSnapshot, registered]);

  React.useEffect(() => {
    if (!registered) return;
    const registry = getVoiceAdapterRegistry();
    const adapters = registry.list();
    const unsubs = adapters
      .map((adapter) => adapter.subscribe?.(publishSnapshot) ?? null)
      .filter((u): u is () => void => typeof u === 'function');
    return () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // ignore
        }
      }
    };
  }, [publishSnapshot, registered]);

  return null;
}
