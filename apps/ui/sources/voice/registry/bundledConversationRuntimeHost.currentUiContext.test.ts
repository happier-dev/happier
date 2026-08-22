import { describe, expect, it, vi } from 'vitest';
import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';

const {
  createCurrentUiContextAutomaticUpdateProjector,
  onCurrentUiContextChanged,
  onVoiceStarted,
  onVoiceStopped,
} = vi.hoisted(() => ({
  createCurrentUiContextAutomaticUpdateProjector: vi.fn(() => ({
    project: vi.fn(() => null),
    markDelivered: vi.fn(),
  })),
  onCurrentUiContextChanged: vi.fn(),
  onVoiceStarted: vi.fn(() => ''),
  onVoiceStopped: vi.fn(),
}));

vi.mock('@/voice/context/voiceHooks', () => ({
  createCurrentUiContextAutomaticUpdateProjector,
  voiceHooks: {
    onCurrentUiContextChanged,
    onVoiceStarted,
    onVoiceStopped,
  },
}));

import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

describe('bundled conversation runtime host current UI lifecycle', () => {
  it('subscribes only after connect and retires context delivery with the exact voice attempt', () => {
    let snapshot: CurrentUiContextSnapshotV1 | null = {
      navigation: { area: 'session', screen: 'overview' },
      commands: [],
    };
    const listeners = new Set<() => void>();
    const currentUiContext = {
      readCurrentUiContext: vi.fn(() => snapshot),
      resolveCurrentUiCommand: vi.fn(() => null),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const lease = createBundledConversationRuntimeHostLease({ currentUiContext });

    try {
      lease.host.voiceHooks.onStarted('control-session', 'session_context');
      expect(currentUiContext.subscribe).not.toHaveBeenCalled();
      expect(onCurrentUiContextChanged).not.toHaveBeenCalled();

      lease.host.voiceHooks.onConnected?.('control-session');
      expect(currentUiContext.subscribe).toHaveBeenCalledTimes(1);
      expect(onCurrentUiContextChanged).toHaveBeenLastCalledWith('control-session', snapshot, expect.anything());

      snapshot = {
        navigation: { area: 'settings', screen: 'voice' },
        commands: [],
      };
      const firstListener = [...listeners][0];
      if (!firstListener) throw new Error('missing current UI subscription');
      firstListener();
      expect(onCurrentUiContextChanged).toHaveBeenLastCalledWith('control-session', snapshot, expect.anything());

      snapshot = null;
      firstListener();
      expect(onCurrentUiContextChanged).toHaveBeenLastCalledWith('control-session', null, expect.anything());

      lease.host.voiceHooks.onStopped();
      expect(listeners).toHaveLength(0);
      const callsAfterStop = onCurrentUiContextChanged.mock.calls.length;
      firstListener();
      expect(onCurrentUiContextChanged).toHaveBeenCalledTimes(callsAfterStop);

      lease.host.voiceHooks.onConnected?.('control-session');
      const secondListener = [...listeners][0];
      if (!secondListener) throw new Error('missing replacement current UI subscription');
      const callsBeforeRevoke = onCurrentUiContextChanged.mock.calls.length;
      lease.revoke();
      secondListener();
      expect(onCurrentUiContextChanged).toHaveBeenCalledTimes(callsBeforeRevoke);
    } finally {
      lease.revoke();
    }
  });
});
