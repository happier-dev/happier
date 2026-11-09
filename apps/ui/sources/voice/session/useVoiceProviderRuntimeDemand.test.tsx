import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { useVoiceSessionStore } = await import('./voiceSessionStore');
const { useVoiceProviderRuntimeDemand } = await import('./useVoiceProviderRuntimeDemand');
const { voiceSessionManager } = await import('./voiceSession');

it('keeps saved selection descriptor-only and admits the selected handoff only while an attempt can stop', async () => {
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
    expect([...hook.getCurrent()]).toEqual([]);
    await act(async () => { useVoiceSessionStore.setState({ adapterId: 'test.voice/openai', status: 'connecting', canStop: true }); });
    await act(async () => { select('test.voice/next'); });
    expect([...hook.getCurrent()]).toEqual(['test.voice/openai', 'test.voice/next']);
    await act(async () => { useVoiceSessionStore.setState({ status: 'error', canStop: false }); });
    expect([...hook.getCurrent()]).toEqual(['test.voice/openai']);
    await act(async () => { useVoiceSessionStore.setState({ status: 'connecting', canStop: true }); });
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

it.each(['stop', 'toggle'] as const)('admits first Start demand without a mounted controller and cancels it through %s', async (cancel) => {
  const settings = storage.getState().settings;
  const snapshot = useVoiceSessionStore.getState();
  storage.setState(state => ({ settings: { ...state.settings, voiceSettingsV1: {
    ...state.settings.voiceSettingsV1, providerId: 'test.voice/openai',
  } } }));
  useVoiceSessionStore.setState({ adapterId: null });
  const hook = await renderHook(useVoiceProviderRuntimeDemand);
  let starting: Promise<void> | undefined;
  try {
    expect([...hook.getCurrent()]).toEqual([]);
    await act(async () => { starting = voiceSessionManager.toggle(null); });
    expect([...hook.getCurrent()]).toEqual(['test.voice/openai']);
    expect(voiceSessionManager.getSnapshot()).toMatchObject({
      adapterId: 'test.voice/openai', status: 'connecting', canStop: true,
    });
    const { getVoiceSessionPresentedAttemptId } = await import('./voiceSessionStore');
    expect(getVoiceSessionPresentedAttemptId()).not.toBeNull();
    await act(async () => {
      storage.setState(state => ({ settings: { ...state.settings, voiceSettingsV1: {
        ...state.settings.voiceSettingsV1, providerId: 'test.voice/next',
      } } }));
    });
    expect([...hook.getCurrent()]).toEqual(['test.voice/openai', 'test.voice/next']);
    await act(async () => {
      if (cancel === 'stop') await voiceSessionManager.stop('');
      else await voiceSessionManager.toggle(null);
      await starting;
    });
    expect([...hook.getCurrent()]).toEqual([]);
    expect(voiceSessionManager.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
  } finally {
    await voiceSessionManager.stop('');
    await starting;
    await hook.unmount();
    storage.setState({ settings });
    useVoiceSessionStore.setState(snapshot);
  }
});

it('settles a failed runtime load visibly and permits Retry without a mounted controller', async () => {
  const settings = storage.getState().settings;
  const snapshot = useVoiceSessionStore.getState();
  const { rejectVoiceSessionRuntimeRequest } = await import('./voiceSessionLifecycleControllerStore');
  storage.setState(state => ({ settings: { ...state.settings, voiceSettingsV1: {
    ...state.settings.voiceSettingsV1, providerId: 'test.voice/openai',
  } } }));
  useVoiceSessionStore.setState({ adapterId: null, status: 'disconnected', canStop: false });
  const hook = await renderHook(useVoiceProviderRuntimeDemand);
  try {
    let starting!: Promise<void>;
    await act(async () => { starting = voiceSessionManager.toggle(null); });
    await act(async () => {
      // RuntimeHost reports this external module-load failure through the demand owner.
      rejectVoiceSessionRuntimeRequest(new Error('Module transport unavailable'));
      await starting;
    });
    expect(voiceSessionManager.getSnapshot()).toMatchObject({
      status: 'error', canStop: false, errorRecoveryAction: 'retry',
    });
    await act(async () => { starting = voiceSessionManager.retry(voiceSessionManager.getSnapshot().sessionId!); });
    expect(voiceSessionManager.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
    await act(async () => { await voiceSessionManager.stop(''); await starting; });
    expect(voiceSessionManager.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
  } finally {
    await hook.unmount();
    storage.setState({ settings });
    useVoiceSessionStore.setState(snapshot);
  }
});

it('admits a newly selected provider through an already ready terminal owner before React rerenders', async () => {
  const settings = storage.getState().settings;
  const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
  const { setVoiceSessionLifecycleController, acknowledgeVoiceSessionRuntimeReady } = await import('./voiceSessionLifecycleControllerStore');
  const { resetVoiceSessionRuntimeStateForTests, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
  await resetVoiceSessionRuntimeStateForTests();
  const lifecycle = createVoiceSessionLifecycleController();
  setVoiceSessionLifecycleController(lifecycle);
  acknowledgeVoiceSessionRuntimeReady(true);
  const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
  const select = (providerId: string) => storage.setState(state => ({ settings: { ...state.settings,
    voiceSettingsV1: { ...state.settings.voiceSettingsV1, providerId },
  } }));
  try {
    select('test.voice/first');
    await voiceSessionManager.toggle(null);
    expect(voiceSessionManager.getSnapshot()).toMatchObject({ adapterId: 'test.voice/first', canStop: false });
    select('test.voice/second');
    await voiceSessionManager.toggle(null);
    expect(lifecycle.getConfiguredProviderId()).toBe('test.voice/second');
    expect(voiceSessionManager.getSnapshot()).toMatchObject({ adapterId: 'test.voice/second', canStop: false });
  } finally {
    unsubscribe();
    await lifecycle.dispose();
    await resetVoiceSessionRuntimeStateForTests();
    storage.setState({ settings });
  }
});
