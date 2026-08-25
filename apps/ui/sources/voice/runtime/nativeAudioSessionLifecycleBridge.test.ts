import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import {
  createVoiceAudioSessionCoordinator,
  type VoiceAudioSessionPlatform,
  type VoiceAudioSessionPlatformEvent,
  type VoiceAudioSessionRequest,
} from '../../../../../packages/audio-stream-native/src/voiceAudioSessionCoordinator';

import { createNativeAudioSessionLifecycleBridge } from './nativeAudioSessionLifecycleBridge';

const ORIGINAL_PLATFORM_OS = Platform.OS;

afterEach(() => {
  (Platform as unknown as { OS: string }).OS = ORIGINAL_PLATFORM_OS;
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

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
  let snapshot = {
    adapterId: 'local_conversation', sessionId: 'voice-global', status: 'connected' as const,
    mode: 'listening' as const, canStop: true, micMuted,
  };
  const controller = {
    getSnapshot: vi.fn(() => snapshot),
    setOutputFocusState: vi.fn(async (): Promise<'applied' | 'unsupported'> => 'applied'),
    setMuted: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const bridge = createNativeAudioSessionLifecycleBridge({
    coordinator: coordinator as never,
    controller,
  });
  return { bridge, controller, emit: (event: VoiceAudioSessionPlatformEvent) => listener?.(event), remove };
}

function createReconfigurationHarness() {
  let platformListener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  const platform: VoiceAudioSessionPlatform = {
    apply: vi.fn(async ({ generation, configuration }) => {
      platformListener?.({
        generation,
        kind: 'focus_changed',
        state: configuration.output ? 'gained' : 'not_required',
      });
      return {
        generation,
        aecAvailable: true,
        aecActive: false,
        route: 'speaker',
      };
    }),
    restore: vi.fn(async () => undefined),
    subscribe: (listener) => {
      platformListener = listener;
      return { remove: () => { platformListener = null; } };
    },
  };
  const coordinator = createVoiceAudioSessionCoordinator({ platform });
  const snapshot = {
    adapterId: 'local_conversation', sessionId: 'voice-global', status: 'connected' as const,
    mode: 'listening' as const, canStop: true, micMuted: false,
  };
  const controller = {
    getSnapshot: vi.fn(() => snapshot),
    setOutputFocusState: vi.fn(async (): Promise<'applied' | 'unsupported'> => 'applied'),
    setMuted: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const bridge = createNativeAudioSessionLifecycleBridge({ coordinator, controller });
  const request = (overrides: Partial<VoiceAudioSessionRequest> = {}): VoiceAudioSessionRequest => ({
    ownerId: 'capture',
    mode: 'conversation',
    input: true,
    output: true,
    aec: 'preferred',
    capture: 'host_managed',
    ...overrides,
  });
  return {
    bridge,
    controller,
    coordinator,
    emit: (event: VoiceAudioSessionPlatformEvent) => platformListener?.(event),
    request,
  };
}

describe('createNativeAudioSessionLifecycleBridge', () => {
  it('auto-mutes across overlapping transient suspension reasons and resumes only after all clear', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
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

  it('keeps an active unmuted iOS Voice attempt unchanged through ordinary background and foreground transitions', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    const { controller, emit } = createHarness();

    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).not.toHaveBeenCalled();
    expect(controller.setOutputFocusState).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('preserves an explicit iOS Voice mute through ordinary background and foreground transitions', async () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    const { controller, emit } = createHarness(true);

    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).not.toHaveBeenCalled();
    expect(controller.setOutputFocusState).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('keeps an active unmuted Android Voice attempt unchanged through ordinary background and foreground transitions', async () => {
    (Platform as unknown as { OS: string }).OS = 'android';
    const { controller, emit } = createHarness();

    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).not.toHaveBeenCalled();
    expect(controller.setOutputFocusState).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('does not let a duckable focus signal clear a true transient capture suspension', async () => {
    const { controller, emit } = createHarness();
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));

    // This platform fact is intentionally distinct from transient loss. The
    // native output owner can apply its own duck policy, while capture stays
    // suspended until Android reports focus gain.
    emit({ generation: 1, kind: 'focus_duckable' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).toHaveBeenCalledTimes(1);

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false));
  });

  it('suspends provider-neutral output for transient focus loss and restores only on gain', async () => {
    const { controller, emit } = createHarness();

    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setOutputFocusState).toHaveBeenLastCalledWith(
      'voice-global',
      'suspended',
    ));
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));

    // A duckable notification after a real transient loss must not downgrade
    // the output suspension before Android has returned focus.
    emit({ generation: 1, kind: 'focus_duckable' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setOutputFocusState).toHaveBeenCalledTimes(1);

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await vi.waitFor(() => expect(controller.setOutputFocusState).toHaveBeenLastCalledWith(
      'voice-global',
      'active',
    ));
  });

  it('ducks output without muting capture and restores it on focus gain', async () => {
    const { controller, emit } = createHarness();

    emit({ generation: 1, kind: 'focus_duckable' });
    await vi.waitFor(() => expect(controller.setOutputFocusState).toHaveBeenLastCalledWith(
      'voice-global',
      'ducked',
    ));
    expect(controller.setMuted).not.toHaveBeenCalled();

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await vi.waitFor(() => expect(controller.setOutputFocusState).toHaveBeenLastCalledWith(
      'voice-global',
      'active',
    ));
  });

  it('does not mute capture when the lifecycle owner reports output suspension unsupported', async () => {
    const { controller, emit } = createHarness();
    controller.setOutputFocusState.mockResolvedValueOnce('unsupported');

    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });

    await vi.waitFor(() => expect(controller.setOutputFocusState).toHaveBeenCalledWith(
      'voice-global',
      'suspended',
    ));
    // Exact-adapter fail-closed settlement belongs to the lifecycle controller;
    // this bridge must not re-resolve and stop a same-id replacement.
    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.setMuted).not.toHaveBeenCalled();
  });

  it('does not unmute when active output restoration is unsupported', async () => {
    const { controller, emit } = createHarness();
    controller.setOutputFocusState
      .mockResolvedValueOnce('applied')
      .mockResolvedValueOnce('unsupported');

    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.setMuted).toHaveBeenCalledTimes(1);
  });

  it('does not unmute when active output restoration throws', async () => {
    const { controller, emit } = createHarness();
    controller.setOutputFocusState
      .mockResolvedValueOnce('applied')
      .mockRejectedValueOnce(new Error('output_restore_failed'));

    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.setMuted).toHaveBeenCalledTimes(1);
  });

  it('does not stop a same-session replacement after delayed output focus failure', async () => {
    const outputFocus = createDeferred<'applied' | 'unsupported'>();
    let listener: (event: VoiceAudioSessionPlatformEvent) => void = () => {
      throw new Error('native_audio_bridge_listener_missing');
    };
    let snapshot: Readonly<{
      adapterId: string;
      sessionId: string;
      status: 'connected';
      mode: 'listening';
      canStop: true;
      micMuted: false;
    }> = {
      adapterId: 'incumbent',
      sessionId: 'voice-global',
      status: 'connected',
      mode: 'listening',
      canStop: true,
      micMuted: false,
    };
    const controller = {
      getSnapshot: vi.fn(() => snapshot),
      setOutputFocusState: vi.fn(() => outputFocus.promise),
      setMuted: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const bridge = createNativeAudioSessionLifecycleBridge({
      coordinator: {
        subscribe(next: (event: VoiceAudioSessionPlatformEvent) => void) {
          listener = next;
          return { remove: vi.fn() };
        },
        getSnapshot: () => ({ configuration: { aec: 'preferred' as const } }),
      } as never,
      controller,
    });

    listener({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setOutputFocusState).toHaveBeenCalledWith(
      'voice-global',
      'suspended',
    ));

    snapshot = { ...snapshot, adapterId: 'replacement' };
    outputFocus.resolve('unsupported');
    await outputFocus.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.setMuted).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('clears a transient capture suspension only from the replacement focus generation', async () => {
    const { bridge, controller, coordinator, emit, request } = createReconfigurationHarness();
    const first = await coordinator.acquire(request());
    const firstGeneration = coordinator.getSnapshot().generation;
    emit({ generation: firstGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));

    const replacement = await coordinator.acquire(request({ ownerId: 'replacement' }));
    const replacementGeneration = coordinator.getSnapshot().generation;
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false));

    emit({ generation: replacementGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));
    emit({ generation: firstGeneration, kind: 'focus_changed', state: 'gained' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true);

    emit({ generation: replacementGeneration, kind: 'focus_changed', state: 'gained' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false));

    await replacement.release();
    await first.release();
    bridge.dispose();
  });

  it('clears a focus suspension when the replacement configuration no longer needs output focus', async () => {
    const { bridge, controller, coordinator, emit, request } = createReconfigurationHarness();
    const input = await coordinator.acquire(request({ output: false }));
    const output = await coordinator.acquire(request({ ownerId: 'output' }));
    const outputGeneration = coordinator.getSnapshot().generation;
    emit({ generation: outputGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true));

    await output.release();
    const inputOnlyGeneration = coordinator.getSnapshot().generation;
    await vi.waitFor(() => expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false));

    emit({ generation: outputGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false);
    expect(inputOnlyGeneration).not.toBe(outputGeneration);

    await input.release();
    bridge.dispose();
  });

  it('never unmutes a session that was already user-muted', async () => {
    (Platform as unknown as { OS: string }).OS = 'android';
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
