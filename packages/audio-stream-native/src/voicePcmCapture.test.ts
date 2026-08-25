import { describe, expect, it, vi } from 'vitest';

import type {
  AudioStreamCaptureTerminalEvent,
  AudioStreamFrameEvent,
  HappierAudioStreamNativeModule,
} from './HappierAudioStreamNative.types';
import { createVoicePcmCapture } from './voicePcmCapture';
import {
  createVoiceAudioSessionCoordinator,
  type VoiceAudioSessionCoordinator,
  type VoiceAudioSessionPlatform,
  type VoiceAudioSessionPlatformEvent,
} from './voiceAudioSessionCoordinator';

const FORMAT = { sampleRate: 16_000, channels: 1 as const, frameMs: 20 };

function createHarness() {
  let frameListener: ((event: AudioStreamFrameEvent) => void) | null = null;
  let captureTerminalListener: ((event: AudioStreamCaptureTerminalEvent) => void) | null = null;
  let nextStream = 0;
  const nativeModule: HappierAudioStreamNativeModule = {
    start: vi.fn(async () => ({ streamId: `stream-${++nextStream}` })),
    stop: vi.fn(async () => undefined),
    configureAudioSession: vi.fn(async ({ generation, configuration }) => ({
      generation,
      aecAvailable: true,
      aecActive: configuration.aec !== 'off',
      route: 'speaker',
    })),
    restoreAudioSession: vi.fn(async () => undefined),
    addListener: vi.fn((eventName, listener) => {
      if (eventName === 'audioFrame') frameListener = listener as (event: AudioStreamFrameEvent) => void;
      if ((eventName as string) === 'captureTerminal') {
        captureTerminalListener = listener as unknown as (event: AudioStreamCaptureTerminalEvent) => void;
      }
      return {
        remove: () => {
          if (eventName === 'audioFrame') frameListener = null;
          if ((eventName as string) === 'captureTerminal') captureTerminalListener = null;
        },
      };
    }),
  };
  const sessionLease = { id: 'audio-lease', capabilities: { aecAvailable: true, aecActive: false, route: 'speaker' }, release: vi.fn(async () => undefined) };
  const audioSessionCoordinator = {
    acquireForCapture: vi.fn(async (_request, startCapture: () => Promise<void>) => {
      await startCapture();
      return sessionLease;
    }),
    subscribe: vi.fn(() => ({ remove: vi.fn() })),
  } as unknown as VoiceAudioSessionCoordinator;
  return {
    nativeModule,
    audioSessionCoordinator,
    sessionLease,
    emit: (event: AudioStreamFrameEvent) => frameListener?.(event),
    emitCaptureTerminal: (event: AudioStreamCaptureTerminalEvent) => captureTerminalListener?.(event),
  };
}

function createRequiredAecHarness() {
  let sessionListener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  let frameListener: ((event: AudioStreamFrameEvent) => void) | null = null;
  let captureTerminalListener: ((event: AudioStreamCaptureTerminalEvent) => void) | null = null;
  let configuredGeneration = 0;
  const platform: VoiceAudioSessionPlatform = {
    apply: vi.fn(async ({ generation }) => {
      configuredGeneration = generation;
      return {
        generation,
        aecAvailable: true,
        // Native configuration can request AEC but only native capture start
        // proves it is active.
        aecActive: false,
        route: 'speaker',
      };
    }),
    restore: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => {
      sessionListener = listener;
      return { remove: () => { sessionListener = null; } };
    }),
  };
  const nativeModule: HappierAudioStreamNativeModule = {
    start: vi.fn(async () => {
      sessionListener?.({
        generation: configuredGeneration,
        kind: 'capabilities_changed',
        aecAvailable: true,
        aecActive: true,
      });
      return { streamId: 'required-aec-stream' };
    }),
    stop: vi.fn(async () => undefined),
    configureAudioSession: vi.fn(async ({ generation, configuration }) => ({
      generation,
      aecAvailable: true,
      aecActive: configuration.aec !== 'off',
      route: 'speaker',
    })),
    restoreAudioSession: vi.fn(async () => undefined),
    addListener: vi.fn((eventName, listener) => {
      if (eventName === 'audioFrame') frameListener = listener as (event: AudioStreamFrameEvent) => void;
      if ((eventName as string) === 'captureTerminal') {
        captureTerminalListener = listener as unknown as (event: AudioStreamCaptureTerminalEvent) => void;
      }
      return {
        remove: () => {
          if (eventName === 'audioFrame') frameListener = null;
          if ((eventName as string) === 'captureTerminal') captureTerminalListener = null;
        },
      };
    }),
  };
  const audioSessionCoordinator = createVoiceAudioSessionCoordinator({ platform });
  return {
    nativeModule,
    audioSessionCoordinator,
    emitAecCapabilities: (aecAvailable: boolean, aecActive: boolean) => {
      sessionListener?.({
        generation: audioSessionCoordinator.getSnapshot().generation,
        kind: 'capabilities_changed',
        aecAvailable,
        aecActive,
      });
    },
    emit: (event: AudioStreamFrameEvent) => frameListener?.(event),
    emitCaptureTerminal: (event: AudioStreamCaptureTerminalEvent) => captureTerminalListener?.(event),
  };
}

describe('VoicePcmCapture', () => {
  it('admits required AEC only after the host capture reports it active', async () => {
    const harness = createRequiredAecHarness();
    const capture = createVoicePcmCapture(harness);

    const lease = await capture.acquire({
      ownerId: 'required-aec',
      format: FORMAT,
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'required' },
      onFrame: () => undefined,
    });

    expect(lease.streamId).toBe('required-aec-stream');
    expect(harness.nativeModule.start).toHaveBeenCalledTimes(1);
    expect(harness.audioSessionCoordinator.getSnapshot().capabilities).toMatchObject({
      aecAvailable: true,
      aecActive: true,
    });

    await lease.release();
  });

  it('tears down the host capture and reports an error when required AEC is lost', async () => {
    const harness = createRequiredAecHarness();
    const capture = createVoicePcmCapture(harness);
    const onError = vi.fn();
    const lease = await capture.acquire({
      ownerId: 'required-aec',
      format: FORMAT,
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'required' },
      onFrame: () => undefined,
      onError,
    });

    harness.emitAecCapabilities(true, false);

    await vi.waitFor(() => expect(harness.nativeModule.stop).toHaveBeenCalledWith({ streamId: lease.streamId }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'aec_required_unavailable' }));
    expect(capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });
  });

  it('does not hand out a required-AEC lease when capability is already lost before observation attaches', async () => {
    const harness = createHarness();
    const audioSessionCoordinator = {
      acquireForCapture: vi.fn(async (_request, startCapture: () => Promise<void>) => {
        await startCapture();
        return harness.sessionLease;
      }),
      subscribe: vi.fn(() => ({ remove: vi.fn() })),
      getSnapshot: vi.fn(() => ({
        generation: 1,
        leaseCount: 1,
        pendingReleaseCount: 0,
        configuration: { mode: 'conversation', input: true, output: true, aec: 'required', capture: 'host_managed' },
        capabilities: { aecAvailable: true, aecActive: false, route: 'speaker' },
      })),
    } as unknown as VoiceAudioSessionCoordinator;
    const capture = createVoicePcmCapture({ nativeModule: harness.nativeModule, audioSessionCoordinator });

    await expect(capture.acquire({
      ownerId: 'required-aec',
      format: FORMAT,
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'required' },
      onFrame: () => undefined,
    })).rejects.toMatchObject({ code: 'aec_required_unavailable' });

    expect(harness.nativeModule.stop).toHaveBeenCalledWith({ streamId: 'stream-1' });
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
    expect(capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });
  });

  it('shares one native stream across compatible subscriber leases and stops after the final release', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const firstFrames: string[] = [];
    const secondFrames: string[] = [];
    const first = await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: (frame) => { firstFrames.push(frame.pcm16leBase64); } });
    const second = await capture.acquire({ ownerId: 'vad', format: FORMAT, onFrame: (frame) => { secondFrames.push(frame.pcm16leBase64); } });

    expect(first.streamId).toBe(second.streamId);
    expect(harness.nativeModule.start).toHaveBeenCalledTimes(1);
    harness.emit({ streamId: first.streamId, pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();
    expect(firstFrames).toEqual(['AA==']);
    expect(secondFrames).toEqual(['AA==']);

    await first.release();
    expect(harness.nativeModule.stop).not.toHaveBeenCalled();
    await second.release();
    expect(harness.nativeModule.stop).toHaveBeenCalledWith({ streamId: first.streamId });
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
  });

  it('does not lose an initial frame emitted before native start resolves', async () => {
    const harness = createHarness();
    vi.mocked(harness.nativeModule.start).mockImplementationOnce(async () => {
      harness.emit({ streamId: 'stream-1', pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });
      return { streamId: 'stream-1' };
    });
    const capture = createVoicePcmCapture(harness);
    const frames: string[] = [];

    const lease = await capture.acquire({
      ownerId: 'stt',
      format: FORMAT,
      onFrame: (frame) => { frames.push(frame.pcm16leBase64); },
    });
    await lease.waitForDrain();

    expect(frames).toEqual(['AA==']);
    await lease.release();
  });

  it('retires a matching terminal emitted before native start resolves', async () => {
    const harness = createHarness();
    vi.mocked(harness.nativeModule.start).mockImplementationOnce(async ({ generation }) => {
      harness.emitCaptureTerminal({ streamId: 'stream-1', generation, reason: 'read_error' });
      return { streamId: 'stream-1' };
    });
    const capture = createVoicePcmCapture(harness);
    const errors = vi.fn();

    const lease = await capture.acquire({
      ownerId: 'stt',
      format: FORMAT,
      onFrame: () => undefined,
      onError: errors,
    });
    await lease.release();

    expect(errors).toHaveBeenCalledWith(expect.any(Error));
    expect(harness.nativeModule.stop).toHaveBeenCalledWith({ streamId: 'stream-1' });
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
    expect(capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });
  });

  it('rejects an incompatible format instead of restarting another consumer stream', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const first = await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined });

    await expect(capture.acquire({
      ownerId: 'other',
      format: { sampleRate: 24_000, channels: 1, frameMs: 20 },
      onFrame: () => undefined,
    })).rejects.toMatchObject({ code: 'capture_format_conflict' });
    expect(harness.nativeModule.start).toHaveBeenCalledTimes(1);
    await first.release();
  });

  it('rejects a capture subscriber that disables audio-session input', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);

    await expect(capture.acquire({
      ownerId: 'invalid-playback-only-capture',
      format: FORMAT,
      audioSession: { mode: 'playback', input: false, output: true, aec: 'off' },
      onFrame: () => undefined,
    })).rejects.toMatchObject({ code: 'invalid_capture_request' });

    expect(harness.audioSessionCoordinator.acquireForCapture).not.toHaveBeenCalled();
    expect(harness.nativeModule.start).not.toHaveBeenCalled();
  });

  it('compares audio-session requests by values rather than object key order', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const first = await capture.acquire({
      ownerId: 'stt',
      format: FORMAT,
      audioSession: { mode: 'conversation', input: true, output: true, aec: 'preferred' },
      onFrame: () => undefined,
    });
    const second = await capture.acquire({
      ownerId: 'vad',
      format: FORMAT,
      audioSession: { aec: 'preferred', output: true, input: true, mode: 'conversation' },
      onFrame: () => undefined,
    });

    expect(first.streamId).toBe(second.streamId);
    expect(harness.audioSessionCoordinator.acquireForCapture).toHaveBeenCalledTimes(1);
    expect(harness.audioSessionCoordinator.acquireForCapture).toHaveBeenCalledWith({
      ownerId: 'stt',
      mode: 'conversation',
      input: true,
      output: true,
      aec: 'preferred',
      capture: 'host_managed',
    }, expect.any(Function));
    expect(harness.nativeModule.start).toHaveBeenCalledTimes(1);
    await first.release();
    await second.release();
  });

  it('bounds slow consumers independently and reports dropped frames without stalling fast consumers', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const unblockSlow = { current: null as (() => void) | null };
    const slow = vi.fn(async () => new Promise<void>((resolve) => { unblockSlow.current = resolve; }));
    const fast = vi.fn(async () => undefined);
    const dropped: number[] = [];
    const slowLease = await capture.acquire({ ownerId: 'slow', format: FORMAT, maxQueuedFrames: 1, onFrame: slow, onDroppedFrames: (count) => dropped.push(count) });
    const fastLease = await capture.acquire({ ownerId: 'fast', format: FORMAT, maxQueuedFrames: 8, onFrame: fast });

    for (const value of ['AA==', 'AQ==', 'Ag==']) {
      harness.emit({ streamId: slowLease.streamId, pcm16leBase64: value, sampleRate: 16_000, channels: 1 });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fast).toHaveBeenCalledTimes(3);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([1, 2]);
    unblockSlow.current?.();
    await capture.waitForDrain();
    await slowLease.release();
    await fastLease.release();
  });

  it('supports subscriber mute/filter without muting the shared native stream', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    let muted = true;
    const mutedFrames = vi.fn();
    const otherFrames = vi.fn();
    const mutedLease = await capture.acquire({ ownerId: 'muted', format: FORMAT, shouldDeliver: () => !muted, onFrame: mutedFrames });
    const otherLease = await capture.acquire({ ownerId: 'other', format: FORMAT, onFrame: otherFrames });

    harness.emit({ streamId: mutedLease.streamId, pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();
    expect(mutedFrames).not.toHaveBeenCalled();
    expect(otherFrames).toHaveBeenCalledTimes(1);
    muted = false;
    harness.emit({ streamId: mutedLease.streamId, pcm16leBase64: 'AQ==', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();
    expect(mutedFrames).toHaveBeenCalledTimes(1);
    await mutedLease.release();
    await otherLease.release();
  });

  it('isolates subscriber filter and error callbacks so one consumer cannot break fan-out', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const broken = await capture.acquire({
      ownerId: 'broken',
      format: FORMAT,
      shouldDeliver: () => { throw new Error('broken filter'); },
      onFrame: () => undefined,
      onError: () => { throw new Error('broken error observer'); },
    });
    const healthyFrames = vi.fn();
    const healthy = await capture.acquire({ ownerId: 'healthy', format: FORMAT, onFrame: healthyFrames });

    harness.emit({ streamId: broken.streamId, pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();

    expect(healthyFrames).toHaveBeenCalledTimes(1);
    await broken.release();
    await healthy.release();
  });

  it('leaves no capture state when coordinator-owned start admission fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.nativeModule.start).mockRejectedValueOnce(new Error('native start failed'));
    const capture = createVoicePcmCapture(harness);

    await expect(capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined }))
      .rejects.toThrow('native start failed');

    expect(harness.audioSessionCoordinator.acquireForCapture).toHaveBeenCalledTimes(1);
    expect(capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });
  });

  it('releases the audio-session lease even when native stream teardown fails', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const lease = await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined });
    vi.mocked(harness.nativeModule.stop).mockRejectedValueOnce(new Error('native stop failed'));

    await expect(lease.release()).rejects.toThrow('native stop failed');

    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
    expect(capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });

    await lease.release();
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(2);
  });

  it('retains the audio-session lease until a failed restoration is retried successfully', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const lease = await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined });
    harness.sessionLease.release
      .mockRejectedValueOnce(new Error('audio session restore failed'))
      .mockResolvedValueOnce(undefined);

    await expect(lease.release()).rejects.toThrow('audio session restore failed');
    await lease.release();

    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(2);
  });

  it('retries both native stop and audio-session restoration after a combined teardown failure', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const lease = await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined });
    vi.mocked(harness.nativeModule.stop)
      .mockRejectedValueOnce(new Error('native stop failed'))
      .mockResolvedValueOnce(undefined);
    harness.sessionLease.release
      .mockRejectedValueOnce(new Error('audio session restore failed'))
      .mockResolvedValueOnce(undefined);

    await expect(lease.release()).rejects.toBeInstanceOf(AggregateError);
    await lease.release();

    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(2);
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(2);
  });

  it('ignores stale frames after stop and a new generation starts', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const frames = vi.fn();
    const first = await capture.acquire({ ownerId: 'first', format: FORMAT, onFrame: frames });
    const firstStreamId = first.streamId;
    await first.release();
    const second = await capture.acquire({ ownerId: 'second', format: FORMAT, onFrame: frames });

    harness.emit({ streamId: firstStreamId, pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });
    harness.emit({ streamId: second.streamId, pcm16leBase64: 'AQ==', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();
    expect(frames).toHaveBeenCalledTimes(1);
    await Promise.all([second.release(), second.release()]);
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(2);
  });

  it('retires only the matching native terminal, releases the shared session, and drops late frames', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const firstFrames = vi.fn();
    const secondFrames = vi.fn();
    const firstErrors = vi.fn();
    const secondErrors = vi.fn();
    const first = await capture.acquire({
      ownerId: 'first',
      format: FORMAT,
      onFrame: firstFrames,
      onError: firstErrors,
    });
    const second = await capture.acquire({
      ownerId: 'second',
      format: FORMAT,
      onFrame: secondFrames,
      onError: secondErrors,
    });
    const generation = capture.getSnapshot().generation;

    harness.emitCaptureTerminal({ streamId: 'other-stream', generation, reason: 'read_error' });
    harness.emitCaptureTerminal({ streamId: first.streamId, generation: generation + 1, reason: 'read_error' });
    harness.emit({ streamId: first.streamId, pcm16leBase64: 'before-terminal', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();

    expect(firstFrames).toHaveBeenCalledTimes(1);
    expect(secondFrames).toHaveBeenCalledTimes(1);
    expect(firstErrors).not.toHaveBeenCalled();
    expect(secondErrors).not.toHaveBeenCalled();
    expect(harness.sessionLease.release).not.toHaveBeenCalled();

    harness.emitCaptureTerminal({ streamId: first.streamId, generation, reason: 'dead_object' });
    harness.emit({ streamId: first.streamId, pcm16leBase64: 'late-frame', sampleRate: 16_000, channels: 1 });
    await first.release();
    await second.release();

    expect(firstErrors).toHaveBeenCalledWith(expect.any(Error));
    expect(secondErrors).toHaveBeenCalledWith(expect.any(Error));
    expect(firstFrames).toHaveBeenCalledTimes(1);
    expect(secondFrames).toHaveBeenCalledTimes(1);
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
    expect(capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });

    harness.emitCaptureTerminal({ streamId: first.streamId, generation, reason: 'dead_object' });
    harness.emit({ streamId: first.streamId, pcm16leBase64: 'stale-frame', sampleRate: 16_000, channels: 1 });
    await capture.waitForDrain();

    expect(firstErrors).toHaveBeenCalledTimes(1);
    expect(secondErrors).toHaveBeenCalledTimes(1);
    expect(firstFrames).toHaveBeenCalledTimes(1);
    expect(secondFrames).toHaveBeenCalledTimes(1);
  });

  it('does not let a hung subscriber block lease release or native restoration', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const lease = await capture.acquire({
      ownerId: 'hung',
      format: FORMAT,
      onFrame: async () => new Promise<void>(() => {}),
    });
    harness.emit({ streamId: lease.streamId, pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await Promise.race([
      lease.release().then(() => 'released' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
    ]);

    expect(result).toBe('released');
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
  });

  it('lets each consumer drain only its own queue', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    const hung = await capture.acquire({
      ownerId: 'hung',
      format: FORMAT,
      onFrame: async () => new Promise<void>(() => {}),
    });
    const fast = await capture.acquire({ ownerId: 'fast', format: FORMAT, onFrame: async () => undefined });
    harness.emit({ streamId: hung.streamId, pcm16leBase64: 'AA==', sampleRate: 16_000, channels: 1 });

    const result = await Promise.race([
      fast.waitForDrain().then(() => 'drained' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
    ]);

    expect(result).toBe('drained');
    await hung.release();
    await fast.release();
  });

  it('surfaces disposal failure and retries a pending native stop', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined });
    vi.mocked(harness.nativeModule.stop).mockRejectedValueOnce(new Error('native stop failed'));

    await expect(capture.dispose()).rejects.toThrow('native stop failed');
    await capture.dispose();

    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(2);
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(1);
  });

  it('surfaces disposal restoration failure and retries the retained session lease', async () => {
    const harness = createHarness();
    const capture = createVoicePcmCapture(harness);
    await capture.acquire({ ownerId: 'stt', format: FORMAT, onFrame: () => undefined });
    harness.sessionLease.release
      .mockRejectedValueOnce(new Error('audio session restore failed'))
      .mockResolvedValueOnce(undefined);

    await expect(capture.dispose()).rejects.toThrow('audio session restore failed');
    await capture.dispose();

    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(harness.sessionLease.release).toHaveBeenCalledTimes(2);
  });
});
