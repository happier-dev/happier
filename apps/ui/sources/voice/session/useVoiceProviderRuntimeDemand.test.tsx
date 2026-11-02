import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { useVoiceSessionStore } = await import('./voiceSessionStore');
const { useVoiceProviderRuntimeDemand } = await import('./useVoiceProviderRuntimeDemand');

it('retains the live provider through selection changes and Off, then releases it when the attempt ends', async () => {
  const settings = storage.getState().settings;
  const snapshot = useVoiceSessionStore.getState();
  const select = (providerId: string | null) => storage.setState(state => ({
    settings: { ...state.settings, voiceSettingsV1: { ...state.settings.voiceSettingsV1, providerId } },
  }));
  select(null);
  useVoiceSessionStore.setState({ adapterId: null });
  const hook = await renderHook(useVoiceProviderRuntimeDemand);
  try {
    expect([...hook.getCurrent()]).toEqual([]);
    await act(async () => { select('test.voice/openai'); });
    expect([...hook.getCurrent()]).toEqual(['test.voice/openai']);
    await act(async () => { useVoiceSessionStore.setState({ adapterId: 'test.voice/openai' }); });
    await act(async () => { select('test.voice/next'); });
    expect([...hook.getCurrent()]).toEqual(['test.voice/next', 'test.voice/openai']);
    await act(async () => { select(null); });
    expect([...hook.getCurrent()]).toEqual(['test.voice/openai']);
    const retained = hook.getCurrent();
    await act(async () => { useVoiceSessionStore.setState({ status: 'connected' }); });
    expect(hook.getCurrent()).toBe(retained);
    await act(async () => { useVoiceSessionStore.setState({ adapterId: null }); });
    expect([...hook.getCurrent()]).toEqual([]);
  } finally {
    await hook.unmount();
    storage.setState({ settings });
    useVoiceSessionStore.setState(snapshot);
  }
});
