import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
  await resetVoiceSessionRuntimeStateForTests();
});

describe('voiceSessionStore', () => {
  it('mints one canonical attempt id per inactive-to-active start and keeps it through reconnect churn', async () => {
    vi.resetModules();
    const {
      getVoiceSessionAttemptId,
      setVoiceSessionSnapshot,
    } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
    const firstAttemptId = getVoiceSessionAttemptId();
    expect(firstAttemptId).toBeTypeOf('string');

    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
    expect(getVoiceSessionAttemptId()).toBe(firstAttemptId);

    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(getVoiceSessionAttemptId()).toBeNull();
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
    expect(getVoiceSessionAttemptId()).not.toBe(firstAttemptId);
  });

  it('mints a new attempt when the active control session changes without a disconnected publication', async () => {
    vi.resetModules();
    const { getVoiceSessionAttemptId, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
    const firstAttemptId = getVoiceSessionAttemptId();
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's2', status: 'connecting', mode: 'idle', canStop: true });
    expect(getVoiceSessionAttemptId()).not.toBe(firstAttemptId);
  });

  it('does not rerender subscribers when setVoiceSessionSnapshot receives an identical snapshot', async () => {
    vi.resetModules();

    const { useVoiceSessionSnapshot } = await import('./voiceSession');
    const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    let renders = 0;

    function Test() {
      useVoiceSessionSnapshot();
      renders += 1;
      return React.createElement('div');
    }

    const baseline = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected' as const,
      mode: 'idle' as const,
      canStop: false,
    };

    const snap = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    await act(async () => {
      setVoiceSessionSnapshot(baseline);
    });

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(React.createElement(Test))).tree;

    await act(async () => {
      setVoiceSessionSnapshot(snap);
    });
    const afterFirstSet = renders;

    await act(async () => {
      setVoiceSessionSnapshot(snap);
    });

    expect(renders).toBe(afterFirstSet);

    await act(async () => {
      tree.unmount();
    });
  });

  it('clears error fields when the next snapshot omits them', async () => {
    vi.resetModules();

    const { setVoiceSessionSnapshot, getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'error',
      mode: 'idle',
      canStop: true,
      errorCode: 'device_stt_start_failed',
      errorMessage: 'device_stt_start_failed',
      errorRecoveryAction: 'open_settings',
      errorPresentation: 'permission_required',
    });

    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const snap = getVoiceSessionSnapshot();
    expect(snap.errorCode).toBeUndefined();
    expect(snap.errorMessage).toBeUndefined();
    expect(snap.errorRecoveryAction).toBeUndefined();
    expect(snap.errorPresentation).toBeUndefined();
  });

  it('publishes reconnecting and interrupted presentation-only changes', async () => {
    vi.resetModules();
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const baseline = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connecting' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    setVoiceSessionSnapshot(baseline);
    setVoiceSessionSnapshot({ ...baseline, presentationState: 'reconnecting' });
    expect(getVoiceSessionSnapshot().presentationState).toBe('reconnecting');

    setVoiceSessionSnapshot({ ...baseline, presentationState: 'interrupted' });
    expect(getVoiceSessionSnapshot().presentationState).toBe('interrupted');
  });

  it('canonicalizes adapter and session ids when storing a snapshot', async () => {
    vi.resetModules();

    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: ' local_direct ',
      sessionId: ' session-1 ',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    expect(getVoiceSessionSnapshot().adapterId).toBe('local_direct');
    expect(getVoiceSessionSnapshot().sessionId).toBe('session-1');
  });

  it('prefers the lifecycle-controller snapshot over a stale published store snapshot', async () => {
    vi.resetModules();

    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');

    const controllerSnapshot = {
      adapterId: 'local_conversation',
      sessionId: 'runtime-session',
      status: 'connected' as const,
      mode: 'listening' as const,
      canStop: true,
    };

    await act(async () => {
      setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: 'stale-session',
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
      setVoiceSessionLifecycleController({
        dispose: async () => {},
        getConfiguredProviderId: () => 'local_conversation',
        rearmAfterCredentialAuthorityChange: vi.fn(() => {}),
        getSnapshot: () => controllerSnapshot,
        interrupt: vi.fn(async () => {}),
        bargeIn: vi.fn(async () => {}),
        sendContextUpdate: vi.fn(() => {}),
        setConfiguredProviderId: vi.fn(() => {}),
        setCurrentUiContextToolSetEnabled: vi.fn(() => {}),
        setMuted: vi.fn(async () => {}),
        suspendInput: vi.fn(async () => null),
        retry: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        subscribe: () => () => {},
        toggle: vi.fn(async () => {}),
      });
    });

    expect(getVoiceSessionSnapshot()).toEqual(controllerSnapshot);

    await act(async () => {
      setVoiceSessionLifecycleController(null);
    });
  });

  it('resets the voice session runtime globals between specs', async () => {
    vi.resetModules();

    const voiceSessionStoreModule = await import('./voiceSessionStore');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = voiceSessionStoreModule;
    const { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('./voiceAdapterRegistry');

    const activeSnapshot = {
      adapterId: 'local_direct',
      sessionId: 'runtime-session',
      status: 'connected' as const,
      mode: 'listening' as const,
      canStop: true,
    };
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    setVoiceSessionLifecycleController({
      dispose: async () => {},
      getConfiguredProviderId: () => 'local_direct',
      rearmAfterCredentialAuthorityChange: vi.fn(() => {}),
      getSnapshot: () => activeSnapshot,
      interrupt: vi.fn(async () => {}),
      bargeIn: vi.fn(async () => {}),
      sendContextUpdate: vi.fn(() => {}),
      setConfiguredProviderId: vi.fn(() => {}),
      setCurrentUiContextToolSetEnabled: vi.fn(() => {}),
      setMuted: vi.fn(async () => {}),
      suspendInput: vi.fn(async () => null),
      retry: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      subscribe: () => () => {},
      toggle: vi.fn(async () => {}),
    });
    registerVoiceAdapters([{
      id: 'local_direct',
      engineKind: 'local',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      toggle: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      setMuted: vi.fn(async () => {}),
      sendContextUpdate: vi.fn(() => {}),
      getSnapshot: () => activeSnapshot,
      subscribe: () => () => {},
    }]);

    expect(getVoiceSessionSnapshot()).toEqual(activeSnapshot);
    expect(getVoiceSessionLifecycleController()).not.toBeNull();
    expect(getVoiceAdapterRegistry().list()).toHaveLength(1);
    expect(voiceSessionStoreModule.resetVoiceSessionRuntimeStateForTests).toBeTypeOf('function');

    if (typeof voiceSessionStoreModule.resetVoiceSessionRuntimeStateForTests !== 'function') {
      return;
    }

    await voiceSessionStoreModule.resetVoiceSessionRuntimeStateForTests();

    expect(getVoiceSessionLifecycleController()).toBeNull();
    expect(getVoiceAdapterRegistry().list()).toHaveLength(0);
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });
});
