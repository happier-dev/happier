import { describe, expect, it, vi } from 'vitest';

import { createRealtimeMachineStorageMirror } from './realtimeMachineStorageMirror';

describe('createRealtimeMachineStorageMirror', () => {
  it('mirrors only the owned adapter and resets a trailing disconnect exactly once', () => {
    const subscription: { listener: (() => void) | null } = { listener: null };
    let snapshot: any = { adapterId: null, state: 'disconnected', controlSessionId: null };
    const setRealtimeStatus = vi.fn();
    const setRealtimeMode = vi.fn();
    const clearRealtimeModeDebounce = vi.fn();
    const dispose = createRealtimeMachineStorageMirror({
      adapterId: 'realtime_elevenlabs',
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        subscription.listener = next;
        return () => { subscription.listener = null; };
      },
      projectSnapshot: (runtime) => ({
        status: runtime.state === 'error' ? 'error' : runtime.state === 'speaking' ? 'connected' : runtime.state,
        mode: runtime.state === 'speaking' ? 'speaking' : 'idle',
      }),
      getStoragePort: () => ({ setRealtimeStatus, setRealtimeMode, clearRealtimeModeDebounce }),
    });

    snapshot = { adapterId: 'local_conversation', state: 'speaking', controlSessionId: 'local' };
    subscription.listener?.();
    expect(setRealtimeStatus).not.toHaveBeenCalled();

    snapshot = { adapterId: 'realtime_elevenlabs', state: 'speaking', controlSessionId: 'voice' };
    subscription.listener?.();
    expect(setRealtimeStatus).toHaveBeenLastCalledWith('connected');
    expect(setRealtimeMode).toHaveBeenLastCalledWith('speaking', false);

    snapshot = { adapterId: null, state: 'disconnected', controlSessionId: null };
    subscription.listener?.();
    subscription.listener?.();
    expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
    expect(setRealtimeMode).toHaveBeenLastCalledWith('idle', true);
    expect(clearRealtimeModeDebounce).toHaveBeenCalledTimes(1);
    dispose();
  });
});
