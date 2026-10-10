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
  it('publishes changes to the applied voice and clears it when the attempt is no longer connected', async () => {
    const store = await import('./voiceSessionStore');
    const snapshot = { adapterId: 'realtime', sessionId: 's1', status: 'connected' as const, mode: 'listening' as const, canStop: true };
    store.setVoiceSessionSnapshot(snapshot);
    const first = store.getVoiceSessionSnapshot();
    const inUseVoice = { providerContributionId: 'happier.openai/realtime', settingFieldPath: 'voice', value: 'coral', displayName: 'Coral' };
    store.setVoiceSessionSnapshot({ ...snapshot, inUseVoice });
    expect(store.getVoiceSessionSnapshot()).not.toBe(first);
    expect(store.getVoiceSessionSnapshot()).toHaveProperty('inUseVoice', inUseVoice);
    store.setVoiceSessionSnapshot({ ...snapshot, inUseVoice, status: 'disconnected', canStop: false });
    expect(store.getVoiceSessionSnapshot().inUseVoice).toBeUndefined();
  });
  it('retains the last ended exact conversation independently of later binding removal or route changes', async () => {
    const store = await import('./voiceSessionStore');
    const conversationSessionAddress = { serverId: 'home-a', sessionId: 'conversation' };
    const targetSessionAddress = { serverId: 'home-a', sessionId: 'coding-session' };
    const accountScope = { serverId: 'home-a', accountId: 'account-a' };
    const conversationScope = { kind: 'session_root' as const, sessionRootId: 'coding-session' };
    store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 'control', status: 'connected', mode: 'listening', canStop: true }, {
      adapterId: 'local_direct', controlSessionId: 'control', conversationSessionId: 'conversation',
      conversationSessionAddress, targetSessionAddress, transcriptMode: 'native_session', updatedAt: 1,
    }, { accountScope, conversationScope });
    store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()).toMatchObject({
      conversationSessionAddress, targetSessionAddress, accountScope, conversationScope,
      transcriptMode: 'native_session', reason: { kind: 'disconnected' },
    });
    store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()?.conversationSessionAddress).toEqual(conversationSessionAddress);
  });
  it('records an attempt that ended cleanly, never a failure, and forgets it at the next start or on dismiss', async () => {
    const store = await import('./voiceSessionStore');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const seen: unknown[] = [];
      const unsubscribe = store.subscribeToVoiceSessionEndedAttempt(() => seen.push(store.getVoiceSessionEndedAttempt()));
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();
      const attemptId = store.getVoiceSessionAttemptId();
      now.mockReturnValue(253_000);
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionEndedAttempt()).toEqual({ attemptId, sessionId: 's1', adapterId: 'local_direct', startedAt: 1_000, endedAt: 253_000,
        reason: { kind: 'disconnected' }, conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null,
        accountScope: null, conversationScope: null });
      expect(seen).toHaveLength(1);

      // A new start replaces the ended fact; a failure is its own state, not "ended".
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's2', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's2', status: 'error', mode: 'idle', canStop: false });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();

      // Provider recovery may carry its failure on a disconnected snapshot.
      // That is still a failure, never a clean End/approval-after-End moment.
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 'failed-disconnect', status: 'connected', mode: 'listening', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
        errorCode: 'microphone_permission_denied', errorPresentation: 'permission_required' });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();

      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's3', status: 'connected', mode: 'listening', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionEndedAttempt()).not.toBeNull();
      store.dismissVoiceSessionEndedAttempt();
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();
      unsubscribe();
    } finally { now.mockRestore(); }
  });

  it('keeps one observed attempt start time through reconnect and resets it only for a new attempt', async () => {
    const store = await import('./voiceSessionStore');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBe(1000);
      now.mockReturnValue(5000);
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', presentationState: 'reconnecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBe(1000);
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBeNull();
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBe(5000);
    } finally { now.mockRestore(); }
  });

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
        observeSyncedConversationMessages: () => {},
        commitInput: async () => {},
        beginHoldToTalk: (await import('./voiceSessionManager')).createVoiceSessionManager({}).beginHoldToTalk,
        finishHoldToTalk: async () => false,
        getAttemptTargetSessionAddress: () => null,
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
        dismissFailedAttempt: vi.fn(async () => {}),
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
      observeSyncedConversationMessages: () => {},
      commitInput: async () => {},
      beginHoldToTalk: (await import('./voiceSessionManager')).createVoiceSessionManager({}).beginHoldToTalk,
      finishHoldToTalk: async () => false,
      getAttemptTargetSessionAddress: () => null,
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
      dismissFailedAttempt: vi.fn(async () => {}),
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

describe('voiceSessionStore continuation arrival', () => {
  it('marks only the current live attempt as arrived from another device, for that attempt\'s life', async () => {
    const store = await import('./voiceSessionStore');
    const notified: Array<string | null> = [];
    const unsubscribe = store.subscribeToVoiceSessionEndedAttempt(() => notified.push(store.getVoiceSessionArrivedAttemptId()));
    try {
      store.setVoiceSessionSnapshot({ adapterId: 'service', sessionId: 'control', status: 'connected', mode: 'listening', canStop: true });
      const attemptId = store.getVoiceSessionAttemptId();
      store.recordVoiceSessionArrival('service', 'other-control');
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
      store.recordVoiceSessionArrival('service', 'control');
      expect(store.getVoiceSessionArrivedAttemptId()).toBe(attemptId);
      expect(notified).toEqual([attemptId]);
      store.setVoiceSessionSnapshot({ adapterId: 'service', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
      // A terminal attempt cannot be marked, and the next start begins unmarked.
      store.recordVoiceSessionArrival('service', 'control');
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
      store.setVoiceSessionSnapshot({ adapterId: 'service', sessionId: 'control-2', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
