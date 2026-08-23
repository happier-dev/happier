import { describe, expect, it, vi } from 'vitest';
import type { VoiceAudioSessionPlatformEvent } from '@happier-dev/audio-stream-native';

import { createNativeAudioSessionLifecycleBridge } from './nativeAudioSessionLifecycleBridge';

function createHarness(micMuted = false, aec: 'required' | 'preferred' = 'preferred') {
  let listener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  const remove = vi.fn();
  const coordinator = {
    subscribe: vi.fn((next: (event: VoiceAudioSessionPlatformEvent) => void) => {
      listener = next;
      return { remove };
    }),
    getSnapshot: () => ({ configuration: { aec } }),
  };
  const controller = {
    getSnapshot: vi.fn(() => ({
      adapterId: 'local_conversation', sessionId: 'voice-global', status: 'connected' as const,
      mode: 'listening' as const, canStop: true, micMuted,
    })),
    setMuted: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const bridge = createNativeAudioSessionLifecycleBridge({
    coordinator: coordinator as never,
    controller,
  });
  return { bridge, controller, emit: (event: VoiceAudioSessionPlatformEvent) => listener?.(event), remove };
}

describe('createNativeAudioSessionLifecycleBridge', () => {
  it('auto-mutes across overlapping transient suspension reasons and resumes only after all clear', async () => {
    const { controller, emit } = createHarness();
    emit({ generation: 1, kind: 'interruption_began' });
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenCalledTimes(1));
    emit({ generation: 1, kind: 'interruption_ended', shouldResume: true });
    await Promise.resolve();
    expect(controller.setMuted).toHaveBeenCalledTimes(1);
    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false));
  });

  it('never unmutes a session that was already user-muted', async () => {
    const { controller, emit } = createHarness(true);
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });
    await Promise.resolve();
    expect(controller.setMuted).not.toHaveBeenCalled();
  });

  it('stops fail-closed when interruption cannot resume or focus is permanently lost', async () => {
    const first = createHarness();
    first.emit({ generation: 1, kind: 'interruption_began' });
    first.emit({ generation: 1, kind: 'interruption_ended', shouldResume: false });
    await vi.waitFor(() => expect(first.controller.stop).toHaveBeenCalledWith('voice-global'));

    const second = createHarness();
    second.emit({ generation: 2, kind: 'focus_changed', state: 'lost_permanent' });
    await vi.waitFor(() => expect(second.controller.stop).toHaveBeenCalledWith('voice-global'));
  });

  it('stops when required echo cancellation is lost at runtime', async () => {
    const { controller, emit } = createHarness(false, 'required');
    emit({ generation: 1, kind: 'capabilities_changed', aecAvailable: true, aecActive: false });
    await vi.waitFor(() => expect(controller.stop).toHaveBeenCalledWith('voice-global'));
  });

  it('stops the session when the native audio graph reports itself terminal', async () => {
    // A media-services reset or an unrecoverable engine configuration change
    // leaves the native graph dead while the session still looks connected.
    // Nothing else observes that, so the lifecycle owner has to end the session.
    const reset = createHarness();
    reset.emit({ generation: 1, kind: 'audio_graph_terminal', reason: 'media_services_reset' });
    await vi.waitFor(() => expect(reset.controller.stop).toHaveBeenCalledWith('voice-global'));

    const configuration = createHarness();
    configuration.emit({
      generation: 1,
      kind: 'audio_graph_terminal',
      reason: 'configuration_unrecoverable',
    });
    await vi.waitFor(() => expect(configuration.controller.stop).toHaveBeenCalledWith('voice-global'));
  });

  it('leaves an ordinary route change to the native owner instead of ending the session', async () => {
    // Route changes are constant and survivable; the native owner is the only
    // party that can tell a survivable one from a dead graph, and it says so
    // with `audio_graph_terminal`.
    const { controller, emit } = createHarness();
    emit({ generation: 1, kind: 'route_changed', route: 'BluetoothHFP' });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.setMuted).not.toHaveBeenCalled();
  });

  it('removes the native listener and makes queued work inert on disposal', async () => {
    const { bridge, controller, emit, remove } = createHarness();
    bridge.dispose();
    emit({ generation: 1, kind: 'interruption_began' });
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.setMuted).not.toHaveBeenCalled();
  });
});
