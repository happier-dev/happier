import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import type { AudioStreamFrameEvent } from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';
import type { VoiceMachineError } from '../machine/voiceMachineError';

const nativeAudio = createNativeVoicePcmCaptureHarness();
vi.mock('expo-modules-core', async original => {
  const actual = await original<typeof import('expo-modules-core')>();
  return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
    ? nativeAudio.nativeModule : actual.requireOptionalNativeModule(name) };
});
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createNativeMicSession } = await import('../mic/NativeMicSession');
const { createDaemonSpeechPcmCapture } = await import('./DaemonSpeechPcmCapture.native');
const { getSharedVoicePcmCapture, getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const sharedCapture = getSharedVoicePcmCapture();
const coordinator = getSharedVoiceAudioSessionCoordinator();
if (!sharedCapture || !coordinator) throw new Error('Installed native capture coordination unavailable');
const harness = { ...nativeAudio, capture: sharedCapture, coordinator };
afterAll(async () => {
  await coordinator.dispose();
  await nativeAudio.coordinator.dispose();
});
const captures: Array<ReturnType<typeof createDaemonSpeechPcmCapture>> = [];
function createCapture(overrides: Partial<Parameters<typeof createDaemonSpeechPcmCapture>[0]> = {}) {
  const chunkEntered = createDeferred<void>();
  const errorReported = createDeferred<void>();
  const micSession = createNativeMicSession({ ensurePermission: async () => {} });
  const options = { micSession, onAudioStarted: vi.fn(), onChunk: vi.fn(async (_bytes: Uint8Array) => {}),
    onError: vi.fn(), ...overrides };
  const onChunk = options.onChunk;
  const onError = options.onError;
  options.onChunk = vi.fn(async (bytes: Uint8Array) => { chunkEntered.resolve(); await onChunk(bytes); });
  options.onError = vi.fn((error: VoiceMachineError) => { errorReported.resolve(); onError?.(error); });
  const capture = createDaemonSpeechPcmCapture(options);
  captures.push(capture);
  return { capture, options, chunkEntered: chunkEntered.promise, errorReported: errorReported.promise };
}
function emitNativeFrame(overrides: Partial<AudioStreamFrameEvent> = {}) {
  const callback = vi.mocked(harness.nativeModule.addListener).mock.calls.find(([name]) => name === 'audioFrame')?.[1];
  if (!callback) throw new Error('native frame listener missing');
  Reflect.apply(callback, undefined, [{ streamId: 'native-stream', pcm16leBase64: 'AAABAA==',
    sampleRate: 16_000, channels: 1, ...overrides }]);
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  for (const capture of captures.splice(0)) await capture.stop();
  expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
});

describe('daemon native PCM through the shared capture owner', () => {
  // Legacy/missing native installation is a separate app bootstrap, covered by
  // the actual default-capture keeper in the native availability suite.
  it('admits a conversation/AEC subscriber with canonical native format', async () => {
    const { capture } = createCapture({ capturePurpose: 'conversation' });
    await capture.start();
    expect(capture.isActive()).toBe(true);
    expect(harness.capture.getSnapshot().subscriberCount).toBe(1);
    expect(harness.nativeModule.start).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 16_000, channels: 1, frameMs: 20 }));
    expect(harness.coordinator.getSnapshot().configuration).toMatchObject({ mode: 'conversation', input: true, output: true, aec: 'required' });
  });
  it('drains accepted Dictation frames while prompt stop abandons held delivery', async () => {
    const held = createDeferred<void>();
    const chunks: Uint8Array[] = [];
    const { capture, chunkEntered } = createCapture({ capturePurpose: 'dictation', onChunk: async bytes => {
      chunks.push(bytes); if (chunks.length === 1) await held.promise;
    } });
    await capture.start();
    expect(harness.coordinator.getSnapshot().configuration).toMatchObject({ mode: 'dictation', output: false, aec: 'off' });
    harness.emit('AAE='); harness.emit('AgM=');
    await chunkEntered;
    expect(chunks).toHaveLength(1);
    const nativeStopEntered = createDeferred<void>();
    const stop = vi.mocked(harness.nativeModule.stop);
    const stopNative = stop.getMockImplementation();
    if (!stopNative) throw new Error('Native stop boundary missing');
    stop.mockImplementationOnce(async (...args) => { nativeStopEntered.resolve(); await stopNative(...args); });
    const finishing = capture.finish();
    await nativeStopEntered.promise;
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    held.resolve(undefined); await finishing;
    expect(chunks).toEqual([new Uint8Array([0, 1]), new Uint8Array([2, 3])]);
    expect(capture.isActive()).toBe(false);
    const pending = createDeferred<void>();
    const abandoned = createCapture({ onChunk: () => pending.promise });
    await abandoned.capture.start(); harness.emit();
    await abandoned.chunkEntered; await abandoned.capture.stop();
    expect(abandoned.capture.isActive()).toBe(false);
    expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
    pending.resolve(undefined);
  });
  it('decodes real native frames and publishes the audio-start edge once', async () => {
    const { capture, options } = createCapture();
    await capture.start(); emitNativeFrame(); emitNativeFrame(); await harness.capture.waitForDrain();
    expect(vi.mocked(options.onChunk).mock.calls.map(([bytes]) => bytes)).toEqual([new Uint8Array([0, 0, 1, 0]), new Uint8Array([0, 0, 1, 0])]);
    expect(options.onAudioStarted).toHaveBeenCalledTimes(1);
  });
  it('drops muted, malformed and non-canonical native frames', async () => {
    const { capture, options } = createCapture();
    await capture.start(); options.micSession.setMuted(true); emitNativeFrame();
    await harness.capture.waitForDrain(); options.micSession.setMuted(false);
    emitNativeFrame({ sampleRate: 48_000 }); emitNativeFrame({ channels: 2 });
    emitNativeFrame({ pcm16leBase64: '!!!' }); await harness.capture.waitForDrain();
    expect(options.onChunk).not.toHaveBeenCalled(); expect(options.onAudioStarted).not.toHaveBeenCalled();
  });
  it('releases native capture once on abort and leaves microphone teardown with its owner', async () => {
    const lifetime = new AbortController();
    const { capture, options } = createCapture({ signal: lifetime.signal });
    const teardown = vi.spyOn(options.micSession, 'teardown');
    await capture.start(); lifetime.abort();
    await capture.stop();
    expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
    expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
    expect(teardown).not.toHaveBeenCalled();
  });
  it('reports native acquisition failure without retaining a half-open lease', async () => {
    vi.mocked(harness.nativeModule.start).mockRejectedValueOnce(new Error('native_start_failed'));
    const { capture, options } = createCapture(); await capture.start();
    expect(capture.isActive()).toBe(false);
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider_error' }));
    expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
    expect(harness.coordinator.getSnapshot().leaseCount).toBe(0);
  });
  it('reports subscriber failure and actual queued-frame overflow as terminal capture errors', async () => {
    const failed = createCapture({ onChunk: async () => { throw new Error('consumer_failed'); } });
    await failed.capture.start(); harness.emit();
    await failed.errorReported;
    expect(failed.options.onError).toHaveBeenCalled();
    await failed.capture.stop();
    const pending = createDeferred<void>();
    const overflow = createCapture({ onChunk: () => pending.promise });
    await overflow.capture.start(); harness.emit();
    await overflow.chunkEntered;
    for (let frame = 0; frame < 9; frame++) harness.emit();
    await overflow.errorReported;
    expect(overflow.options.onError).toHaveBeenCalled();
    expect(overflow.capture.isActive()).toBe(false);
    pending.resolve(undefined);
  });
  it('waits for its accepted subscriber work to drain', async () => {
    const pending = createDeferred<void>();
    const { capture, options, chunkEntered } = createCapture({ onChunk: vi.fn(() => pending.promise) });
    await capture.start(); harness.emit();
    await chunkEntered;
    expect(options.onChunk).toHaveBeenCalledTimes(1);
    let drained = false; const draining = capture.waitForDrain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    pending.resolve(undefined); await draining; expect(drained).toBe(true);
  });
});
