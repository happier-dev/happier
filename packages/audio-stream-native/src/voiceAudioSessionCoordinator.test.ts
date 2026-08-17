import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

import { createHappierAudioStreamNativePlatform } from './HappierAudioStreamNative';
import type {
  HappierAudioStreamNativeEventMap,
  HappierAudioStreamNativeModule,
} from './HappierAudioStreamNative.types';
import {
  createVoiceAudioSessionCoordinator,
  type VoiceAudioSessionPlatform,
  type VoiceAudioSessionPlatformEvent,
  type VoiceAudioSessionRequest,
} from './voiceAudioSessionCoordinator';

function request(overrides: Partial<VoiceAudioSessionRequest> = {}): VoiceAudioSessionRequest {
  return {
    ownerId: 'capture',
    mode: 'dictation',
    input: true,
    output: false,
    aec: 'off',
    capture: 'host_managed',
    ...overrides,
  };
}

function createPlatform(options: Readonly<{ aecAvailable?: boolean }> = {}) {
  let listener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  const platform: VoiceAudioSessionPlatform = {
    apply: vi.fn(async ({ generation, configuration }) => ({
      generation,
      aecAvailable: options.aecAvailable ?? true,
      aecActive: configuration.aec !== 'off' && (options.aecAvailable ?? true),
      route: 'speaker',
    })),
    restore: vi.fn(async () => undefined),
    subscribe: vi.fn((next) => {
      listener = next;
      return { remove: () => { listener = null; } };
    }),
  };
  return {
    platform,
    emit: (event: VoiceAudioSessionPlatformEvent) => listener?.(event),
  };
}

function createNativePlatformReportingRequestedAecAsActive() {
  let sessionListener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  const nativeModule: HappierAudioStreamNativeModule = {
    start: vi.fn(async ({ generation }) => {
      sessionListener?.({
        generation,
        kind: 'capabilities_changed',
        aecAvailable: true,
        aecActive: true,
      });
      return { streamId: 'stream-1' };
    }),
    stop: vi.fn(async () => undefined),
    configureAudioSession: vi.fn(async ({ generation }) => ({
      generation,
      aecAvailable: true,
      // This is the old native response: configuration only requests voice
      // processing, but reports it as though a capture had confirmed it.
      aecActive: true,
      route: 'speaker',
    })),
    restoreAudioSession: vi.fn(async () => undefined),
    addListener: <EventName extends keyof HappierAudioStreamNativeEventMap>(
      eventName: EventName,
      listener: (event: HappierAudioStreamNativeEventMap[EventName]) => void,
    ) => {
      if (eventName === 'voiceAudioSessionEvent') {
        sessionListener = listener as (event: VoiceAudioSessionPlatformEvent) => void;
      }
      return { remove: () => { sessionListener = null; } };
    },
  };
  return {
    nativeModule,
    platform: createHappierAudioStreamNativePlatform(nativeModule),
  };
}

describe('VoiceAudioSessionCoordinator', () => {
  it('does not admit required AEC from a pre-capture configuration request, then accepts the start-time confirmation event', async () => {
    const { nativeModule, platform } = createNativePlatformReportingRequestedAecAsActive();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });

    await expect(coordinator.acquire(request({ mode: 'conversation', aec: 'required' })))
      .rejects.toMatchObject({ code: 'aec_required_unavailable' });
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 0, capabilities: null });

    const preferred = await coordinator.acquire(request({ mode: 'conversation', aec: 'preferred' }));
    expect(preferred.capabilities).toMatchObject({ aecAvailable: true, aecActive: false });

    const generation = coordinator.getSnapshot().generation;
    await nativeModule.start({ sampleRate: 16_000, channels: 1, frameMs: 20, generation });
    expect(coordinator.getSnapshot().capabilities).toMatchObject({ aecAvailable: true, aecActive: true });

    await preferred.release();
  });

  it('merges overlapping leases and restores only after the final release in either order', async () => {
    for (const releaseFirst of ['dictation', 'conversation'] as const) {
      const { platform } = createPlatform();
      const coordinator = createVoiceAudioSessionCoordinator({ platform });
      const dictation = await coordinator.acquire(request());
      const conversation = await coordinator.acquire(request({
        ownerId: 'conversation',
        mode: 'conversation',
        output: true,
        aec: 'required',
      }));

      expect(platform.apply).toHaveBeenLastCalledWith(expect.objectContaining({
        configuration: {
          mode: 'conversation',
          input: true,
          output: true,
          aec: 'required',
          capture: 'host_managed',
        },
      }));

      await (releaseFirst === 'dictation' ? dictation : conversation).release();
      expect(platform.restore).not.toHaveBeenCalled();
      await (releaseFirst === 'dictation' ? conversation : dictation).release();
      expect(platform.restore).toHaveBeenCalledTimes(1);
    }
  });

  it('makes duplicate release idempotent', async () => {
    const { platform } = createPlatform();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const lease = await coordinator.acquire(request());

    await Promise.all([lease.release(), lease.release(), lease.release()]);

    expect(platform.restore).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().leaseCount).toBe(0);
  });

  it('rolls back only the failed acquisition and preserves the prior configuration', async () => {
    const { platform } = createPlatform();
    const apply = vi.mocked(platform.apply);
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const first = await coordinator.acquire(request());
    apply.mockRejectedValueOnce(new Error('platform apply failed'));

    await expect(coordinator.acquire(request({ ownerId: 'playback', mode: 'playback', input: false, output: true })))
      .rejects.toThrow('platform apply failed');

    expect(coordinator.getSnapshot().leaseCount).toBe(1);
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({ mode: 'dictation', output: false }),
    }));
    await first.release();
  });

  it('fails required AEC closed but permits preferred AEC as an explicit degraded capability', async () => {
    const { platform } = createPlatform({ aecAvailable: false });
    const coordinator = createVoiceAudioSessionCoordinator({ platform });

    await expect(coordinator.acquire(request({ mode: 'conversation', aec: 'required' })))
      .rejects.toMatchObject({ code: 'aec_required_unavailable' });
    expect(coordinator.getSnapshot().leaseCount).toBe(0);

    const preferred = await coordinator.acquire(request({ mode: 'conversation', aec: 'preferred' }));
    expect(preferred.capabilities).toEqual(expect.objectContaining({ aecAvailable: false, aecActive: false }));
    await preferred.release();
  });

  it('rejects provider-managed exclusive capture while any other lease exists', async () => {
    const { platform } = createPlatform();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const host = await coordinator.acquire(request());

    await expect(coordinator.acquire(request({
      ownerId: 'vendor-sdk',
      mode: 'conversation',
      capture: 'provider_managed_exclusive',
      output: true,
      aec: 'preferred',
    }))).rejects.toMatchObject({ code: 'exclusive_capture_conflict' });

    await host.release();
    const exclusive = await coordinator.acquire(request({
      ownerId: 'vendor-sdk',
      mode: 'conversation',
      capture: 'provider_managed_exclusive',
      output: true,
      aec: 'preferred',
    }));
    await expect(coordinator.acquire(request({ ownerId: 'second-host' })))
      .rejects.toMatchObject({ code: 'exclusive_capture_conflict' });
    await exclusive.release();
  });

  it('drops stale platform callbacks while forwarding current interruption, focus, route and lifecycle events', async () => {
    const { platform, emit } = createPlatform();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const events: VoiceAudioSessionPlatformEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const first = await coordinator.acquire(request());
    const firstGeneration = coordinator.getSnapshot().generation;
    const second = await coordinator.acquire(request({ ownerId: 'speaker', mode: 'playback', input: false, output: true }));
    const currentGeneration = coordinator.getSnapshot().generation;

    emit({ generation: firstGeneration, kind: 'interruption_began' });
    emit({ generation: currentGeneration, kind: 'interruption_began' });
    emit({ generation: currentGeneration, kind: 'interruption_ended', shouldResume: true });
    emit({ generation: currentGeneration, kind: 'focus_changed', state: 'lost_transient' });
    emit({ generation: currentGeneration, kind: 'route_changed', route: 'bluetooth' });
    emit({ generation: currentGeneration, kind: 'lifecycle_changed', state: 'background' });

    expect(events.map((event) => event.kind)).toEqual([
      'interruption_began',
      'interruption_ended',
      'focus_changed',
      'route_changed',
      'lifecycle_changed',
    ]);
    await second.release();
    await first.release();
  });

  it('serializes overlapping mutations and makes stale release work inert', async () => {
    const { platform } = createPlatform();
    const apply = vi.mocked(platform.apply);
    const unblock = { current: null as (() => void) | null };
    apply.mockImplementationOnce(async ({ generation, configuration }) => {
      await new Promise<void>((resolve) => { unblock.current = resolve; });
      return { generation, aecAvailable: true, aecActive: configuration.aec !== 'off', route: 'speaker' };
    });
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const firstPromise = coordinator.acquire(request({ ownerId: 'first' }));
    const secondPromise = coordinator.acquire(request({ ownerId: 'second', mode: 'playback', input: false, output: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apply).toHaveBeenCalledTimes(1);
    unblock.current?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(apply).toHaveBeenCalledTimes(2);

    await first.release();
    await first.release();
    await second.release();
    expect(platform.restore).toHaveBeenCalledTimes(1);
  });

  it('contains listener failures so one subscriber cannot break native event delivery', async () => {
    const { platform, emit } = createPlatform();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const delivered: string[] = [];
    coordinator.subscribe(() => { throw new Error('broken observer'); });
    coordinator.subscribe((event) => { delivered.push(event.kind); });
    await coordinator.acquire(request());
    const currentGeneration = coordinator.getSnapshot().generation;

    expect(() => emit({ generation: currentGeneration, kind: 'interruption_began' })).not.toThrow();
    expect(delivered).toEqual(['interruption_began']);
  });

  it('retains a lease after a failed release transition so cleanup can be retried', async () => {
    const { platform } = createPlatform();
    const restore = vi.mocked(platform.restore);
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const lease = await coordinator.acquire(request());
    restore.mockRejectedValueOnce(new Error('restore failed'));

    await expect(lease.release()).rejects.toThrow('restore failed');
    expect(coordinator.getSnapshot().leaseCount).toBe(1);

    await lease.release();
    expect(coordinator.getSnapshot().leaseCount).toBe(0);
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('retries a failed release before a later exclusive acquisition after its caller has exited', async () => {
    const { platform } = createPlatform();
    const restore = vi.mocked(platform.restore);
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const playback = await coordinator.acquire(request({
      ownerId: 'playback',
      mode: 'playback',
      input: false,
      output: true,
    }));
    restore.mockRejectedValueOnce(new Error('restore failed'));

    await expect(playback.release()).rejects.toThrow('restore failed');
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, pendingReleaseCount: 1 });

    // The playback caller has no remaining lease reference. A later exclusive
    // caller must make the coordinator retry its retained cleanup rather than
    // being permanently blocked by the failed playback restoration.
    const exclusive = await coordinator.acquire(request({
      ownerId: 'vendor-sdk',
      mode: 'conversation',
      output: true,
      aec: 'preferred',
      capture: 'provider_managed_exclusive',
    }));

    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, pendingReleaseCount: 0 });
    await exclusive.release();
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 0, pendingReleaseCount: 0 });
  });

  it('bounds automatic failed-release retries and surfaces a permanent restoration error to the next acquire', async () => {
    vi.useFakeTimers();
    try {
      const { platform } = createPlatform();
      const restore = vi.mocked(platform.restore);
      const coordinator = createVoiceAudioSessionCoordinator({ platform });
      const playback = await coordinator.acquire(request({
        ownerId: 'playback',
        mode: 'playback',
        input: false,
        output: true,
      }));
      restore.mockRejectedValue(new Error('persistent restore failure'));

      await expect(playback.release()).rejects.toThrow('persistent restore failure');
      await vi.runAllTimersAsync();

      expect(restore).toHaveBeenCalledTimes(4); // initial release + bounded retries
      expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, pendingReleaseCount: 1 });
      await expect(coordinator.acquire(request({
        ownerId: 'vendor-sdk',
        mode: 'conversation',
        output: true,
        aec: 'preferred',
        capture: 'provider_managed_exclusive',
      }))).rejects.toThrow('persistent restore failure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the native subscription even when dispose restoration fails', async () => {
    let listener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
    const remove = vi.fn();
    const platform: VoiceAudioSessionPlatform = {
      apply: vi.fn(async ({ generation }) => ({ generation, aecAvailable: true, aecActive: false, route: 'speaker' })),
      restore: vi.fn(async () => undefined),
      subscribe: vi.fn((next) => {
        listener = next;
        return { remove };
      }),
    };
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    await coordinator.acquire(request());
    vi.mocked(platform.restore).mockRejectedValueOnce(new Error('restore failed'));

    await expect(coordinator.dispose()).rejects.toThrow('restore failed');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(listener).not.toBeNull();

    await expect(coordinator.acquire(request({ ownerId: 'late-owner' })))
      .rejects.toThrow('voice_audio_session_coordinator_disposed');
    await coordinator.dispose();
    expect(platform.restore).toHaveBeenCalledTimes(2);
  });

  it('ignores platform events when no audio-session lease is active', () => {
    const { platform, emit } = createPlatform();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    const events: VoiceAudioSessionPlatformEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    emit({ generation: 0, kind: 'capabilities_changed', aecAvailable: true, aecActive: true });
    emit({ generation: 0, kind: 'route_changed', route: 'speaker' });

    expect(events).toEqual([]);
    expect(coordinator.getSnapshot()).toMatchObject({ configuration: null, capabilities: null });
  });

  it('does not retain observers subscribed after disposal', async () => {
    const { platform, emit } = createPlatform();
    const coordinator = createVoiceAudioSessionCoordinator({ platform });
    await coordinator.dispose();
    const listener = vi.fn();

    const subscription = coordinator.subscribe(listener);
    emit({ generation: coordinator.getSnapshot().generation, kind: 'interruption_began' });
    subscription.remove();

    expect(listener).not.toHaveBeenCalled();
  });
});
