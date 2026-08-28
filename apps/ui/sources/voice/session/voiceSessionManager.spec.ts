import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSessionManager } from './voiceSessionManager';
import { setVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import type { VoiceSessionSnapshot } from './types';

function createLifecycleControllerStub(
  snapshot: VoiceSessionSnapshot = {
    adapterId: 'local_direct',
    sessionId: 's1',
    status: 'connected' as const,
    mode: 'listening' as const,
    canStop: true,
  },
): VoiceSessionLifecycleController {
  return {
    dispose: vi.fn(async () => {}),
    getConfiguredProviderId: vi.fn(() => 'local_direct'),
    rearmAfterCredentialAuthorityChange: vi.fn(() => {}),
    getSnapshot: vi.fn(() => snapshot),
    bargeIn: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    sendContextUpdate: vi.fn(() => {}),
    setConfiguredProviderId: vi.fn(() => {}),
    setCurrentUiContextToolSetEnabled: vi.fn(() => {}),
    setMuted: vi.fn(async () => {}),
    suspendInput: vi.fn(async () => null),
    retry: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    toggle: vi.fn(async () => {}),
  };
}

describe('voiceSessionManager', () => {
  beforeEach(() => {
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('routes commands through the lifecycle controller', async () => {
    const lifecycleController = createLifecycleControllerStub();
    const mgr = createVoiceSessionManager({
      getLifecycleController: () => lifecycleController,
    });

    await mgr.toggle('toggle-session');
    await mgr.retry('retry-session');
    await mgr.stop('stop-session');
    await mgr.interrupt('interrupt-session');
    await mgr.bargeIn('barge-session');
    await mgr.setMuted('mute-session', true);
    mgr.sendContextUpdate('context-session', 'hello');

    expect(lifecycleController.toggle).toHaveBeenCalledWith('toggle-session');
    expect(lifecycleController.retry).toHaveBeenCalledWith('retry-session');
    expect(lifecycleController.stop).toHaveBeenCalledWith('stop-session');
    expect(lifecycleController.interrupt).toHaveBeenCalledWith('interrupt-session');
    expect(lifecycleController.bargeIn).toHaveBeenCalledWith('barge-session');
    expect(lifecycleController.setMuted).toHaveBeenCalledWith('mute-session', true);
    expect(lifecycleController.sendContextUpdate).toHaveBeenCalledWith('context-session', 'hello');
  });

  it('returns the lifecycle-controller snapshot when available', () => {
    const lifecycleSnapshot = {
      adapterId: 'local_conversation',
      sessionId: 'runtime-session',
      status: 'connected' as const,
      mode: 'speaking' as const,
      canStop: true,
      micMuted: true,
    };
    const mgr = createVoiceSessionManager({
      getLifecycleController: () => createLifecycleControllerStub(lifecycleSnapshot),
    });

    expect(mgr.getSnapshot()).toEqual(lifecycleSnapshot);
  });

  it('does not fall back to direct adapter ownership when no lifecycle controller is installed', async () => {
    const mgr = createVoiceSessionManager({
      getLifecycleController: () => null,
    });

    await mgr.toggle('s1');
    await mgr.retry('s1');
    await mgr.stop('s1');
    await mgr.interrupt('s1');
    await mgr.bargeIn('s1');
    await mgr.setMuted('s1', true);
    mgr.sendContextUpdate('s1', 'hello');

    expect(mgr.getSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });
});
