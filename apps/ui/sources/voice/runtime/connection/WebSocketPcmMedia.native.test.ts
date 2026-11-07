import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { createDeferred } from '@/dev/testkit';

const native = createNativeVoicePcmCaptureHarness();
vi.mock('expo-modules-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('expo-modules-core')>();
  return { ...original, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
    ? native.nativeModule : original.requireOptionalNativeModule(name) };
});

// The package registry resolves its native SDK once for this JavaScript runtime.
// Keep that physical module identity stable; retire media through its real owner.
const { createWebSocketPcmMedia } = await import('./WebSocketPcmMedia.native');
const { createNativeMicSession } = await import('@/voice/runtime/mic/NativeMicSession');
const { createWebSocketPcmConnection } = await import('./VoiceRealtimeConnection');
const { getSharedVoicePcmCapture, getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const activeMedia = new Set<ReturnType<typeof createWebSocketPcmMedia>>();

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all([...activeMedia].map(media => media.pcm.stop()));
  activeMedia.clear();
});
afterAll(() => {
  getSharedVoiceAudioSessionCoordinator()?.dispose();
  native.coordinator.dispose();
});

describe('native WebSocketPcmMedia', () => {
  async function createMedia() {
    const inputChunkReceived = createDeferred<void>();
    const onInputChunk = vi.fn((_chunk: string) => { inputChunkReceived.resolve(); });
    const onOutputLevel = vi.fn();
    const mic = createNativeMicSession();
    const ensureActive = vi.spyOn(mic, 'ensureActive');
    const media = createWebSocketPcmMedia({
      mic, input: { sampleRate: 24_000, chunkMs: 100 }, output: { sampleRate: 24_000 },
      onInputChunk, onOutputLevel,
    });
    activeMedia.add(media);
    return { media, onInputChunk, onOutputLevel, ensureActive, inputChunkReceived: inputChunkReceived.promise };
  }

  it.each(['clear', 'interrupt', 'stop', 'abort'] as const)('never reports a natural drain after %s', async outcome => {
    const { media } = await createMedia();
    await media.pcm.start(new AbortController().signal);
    media.enqueueOutput('AQACAA==');
    const controller = new AbortController();
    const drain = media.waitForOutputDrain(controller.signal);
    if (outcome === 'clear') media.clearOutput();
    if (outcome === 'interrupt') { media.beginOutputInterruptionCandidate(); media.resolveOutputInterruptionCandidate('confirmed'); }
    if (outcome === 'stop') await media.pcm.stop();
    if (outcome === 'abort') controller.abort();
    expect(await drain).toBe('cancelled');
  });

  it.each(['completed', 'clear', 'suspended'] as const)('captures the whole native read-back before waiting: %s', async outcome => {
    const { media } = await createMedia();
    await media.pcm.start(new AbortController().signal);
    const playback = media.captureOutputPlayback();
    media.enqueueOutput('AQACAA==');
    if (outcome === 'clear') media.clearOutput();
    if (outcome === 'suspended') {
      media.pcm.setOutputFocusState?.('suspended');
      media.pcm.setOutputFocusState?.('active');
    }
    const drain = playback.waitForDrain(new AbortController().signal);
    if (outcome === 'completed') {
      const capture = getSharedVoicePcmCapture()!.getSnapshot();
      native.emitEvent('playbackDrained', { streamId: capture.streamId!, generation: capture.generation });
    }
    expect(await drain).toBe(outcome === 'completed' ? 'completed' : 'cancelled');
  });

  it('uses the one shared native capture/player lifecycle with a stream-scoped output lease', async () => {
    const { media, onInputChunk, onOutputLevel, ensureActive, inputChunkReceived } = await createMedia();
    const terminal = vi.fn();
    media.pcm.subscribeTerminal?.(terminal);
    await media.pcm.start(new AbortController().signal);

    expect(ensureActive).not.toHaveBeenCalled();
    expect(native.nativeModule.start).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 24_000, channels: 1, frameMs: 100 }));
    const capture = getSharedVoicePcmCapture()!.getSnapshot();
    const identity = { streamId: capture.streamId!, generation: capture.generation };
    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot()).toMatchObject({
      leaseCount: 1, configuration: { mode: 'conversation', input: true, output: true, aec: 'required' },
    });
    expect(native.nativeModule.startPlayback).toHaveBeenCalledWith({ ...identity, sampleRate: 24_000, channels: 1 });

    native.emitEvent('audioFrame', { streamId: identity.streamId, pcm16leBase64: 'AQACAA==', sampleRate: 24_000, channels: 1 });
    await inputChunkReceived;
    expect(onInputChunk).toHaveBeenCalledWith('AQACAA==');
    expect(media.inputLevel()).toBeGreaterThan(0);
    expect(media.enqueueOutput('AQACAA==')).toBe(true);
    expect(native.nativeModule.enqueuePlayback).toHaveBeenCalledWith({ ...identity, pcm16leBase64: 'AQACAA==' });
    expect(media.pcm.playbackCursorMs()).toBe(325);
    expect(media.playbackCursorMs()).toBe(325);

    const expectGain = (gain: number) => expect(native.nativeModule.setPlaybackGain).toHaveBeenLastCalledWith({ ...identity, gain });
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    expectGain(0.18);
    media.resolveOutputInterruptionCandidate('false_alarm');
    expectGain(1);
    expect(media.pcm.setOutputFocusState?.('suspended')).toBe('applied');
    expectGain(0);
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    expectGain(0);
    media.resolveOutputInterruptionCandidate('false_alarm');
    expectGain(0);
    expect(media.pcm.setOutputFocusState?.('ducked')).toBe('applied');
    expectGain(0.18);
    expect(media.pcm.setOutputFocusState?.('active')).toBe('applied');
    expectGain(1);
    expect(media.beginOutputInterruptionCandidate()).toBe('ducked');
    media.resolveOutputInterruptionCandidate('confirmed');
    expect(native.nativeModule.clearPlayback).toHaveBeenCalledWith(identity);
    await media.waitForOutputDrain(new AbortController().signal);
    native.emitEvent('playbackTerminal', { ...identity, reason: 'write_error' });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ code: 'native_playback_write_error' }));

    await media.pcm.stop();
    await media.pcm.stop();
    expect(native.nativeModule.stopPlayback).toHaveBeenCalledOnce();
    expect(native.nativeModule.stop).toHaveBeenCalledOnce();
    expect(getSharedVoicePcmCapture()?.getSnapshot().streamId).toBeNull();
    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot().leaseCount).toBe(0);
    expect(onOutputLevel).toHaveBeenLastCalledWith(0);
  });

  it.each(['stop', 'abort'] as const)('releases a late native capture when its start receives %s', async (outcome) => {
    const started = createDeferred<{ streamId: string }>();
    const startEntered = createDeferred<void>();
    native.nativeModule.start.mockImplementationOnce(async () => {
      startEntered.resolve();
      const stream = await started.promise;
      const request = native.nativeModule.configureAudioSession.mock.calls.at(-1)?.[0];
      if (!request) throw new Error('Expected an admitted native audio session');
      native.emitEvent('voiceAudioSessionEvent', {
        generation: request.generation, kind: 'capabilities_changed', aecAvailable: true, aecActive: true,
      });
      return stream;
    });
    const { media } = await createMedia();
    const controller = new AbortController();
    const starting = media.pcm.start(controller.signal);
    await startEntered.promise;
    expect(native.nativeModule.start).toHaveBeenCalledOnce();
    if (outcome === 'stop') await media.pcm.stop();
    else controller.abort();
    started.resolve({ streamId: 'native-stream' });
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.nativeModule.stop).toHaveBeenCalledOnce();
    expect(native.nativeModule.startPlayback).not.toHaveBeenCalled();
    expect(native.nativeModule.stopPlayback).not.toHaveBeenCalled();
    expect(media.enqueueOutput('AQACAA==')).toBe(false);
    expect(getSharedVoicePcmCapture()?.getSnapshot().streamId).toBeNull();
    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot().leaseCount).toBe(0);
  });

  it('closes the transport independently while the actual native capture stop is still pending', async () => {
    const stopped = createDeferred<void>();
    const stopEntered = createDeferred<void>();
    native.nativeModule.stop.mockImplementationOnce(async () => {
      stopEntered.resolve();
      await stopped.promise;
    });
    const { media } = await createMedia();
    const closeEntered = createDeferred<void>();
    const closeTransport = vi.fn(async () => { closeEntered.resolve(); });
    const connection = createWebSocketPcmConnection({
      driver: { open: async () => {}, sendControl: async () => {}, close: closeTransport },
      pcm: media.pcm,
    });
    await connection.connect(new AbortController().signal);
    expect(media.enqueueOutput('AQACAA==')).toBe(true);
    let settled = false;
    const closing = connection.close({ code: 'user_stop' }).then(() => { settled = true; });
    try {
      await Promise.all([stopEntered.promise, closeEntered.promise]);
      expect(native.nativeModule.stop).toHaveBeenCalledOnce();
      expect(closeTransport).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(connection.state()).toBe('closed');
      expect(media.enqueueOutput('AQACAA==')).toBe(false);
      expect(native.nativeModule.stopPlayback).toHaveBeenCalledOnce();
    } finally {
      stopped.resolve();
      await closing;
      await media.pcm.stop();
    }
    expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot().leaseCount).toBe(0);
  });
});
