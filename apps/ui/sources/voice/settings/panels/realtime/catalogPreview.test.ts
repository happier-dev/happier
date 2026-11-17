import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { createDeferred } from '@/dev/testkit';

const audio = vi.hoisted(() => ({ play: vi.fn(), remove: vi.fn(), detach: vi.fn(),
  onStatus: null as ((status: Readonly<{ didJustFinish?: boolean }>) => void) | null }));
// Expo audio is the OS playback boundary. Audio-mode and preview lifecycle owners remain real.
vi.mock('expo-audio', () => ({
  AudioModule: { setAudioModeAsync: async () => {} },
  createAudioPlayer: () => ({ play: audio.play, remove: audio.remove,
    addListener: (_event: string, listener: NonNullable<typeof audio.onStatus>) => {
      audio.onStatus = listener;
      return { remove: audio.detach };
    } }),
}));
const boundary = createVoiceSpeechOutputBoundary({ getAccount: () => {
  throw new Error('Installed device preview must not dispatch a daemon RPC');
} });
const { playRealtimeCatalogPreview, readRealtimeCatalogPreview, stopRealtimeCatalogPreview } = await import('./catalogPreview');
let restored = createDeferred<void>();
beforeEach(() => {
  const { audioSession } = boundary.reset();
  restored = createDeferred<void>();
  const restoreAudio = audioSession.nativeModule.restoreAudioSession.getMockImplementation();
  if (!restoreAudio) throw new Error('Native audio restore boundary missing');
  audioSession.nativeModule.restoreAudioSession.mockImplementationOnce(async () => { await restoreAudio(); restored.resolve(); });
  boundary.platform.value = 'ios';
  audio.play.mockClear(); audio.remove.mockClear(); audio.detach.mockClear();
});
afterEach(() => {
  const preview = readRealtimeCatalogPreview();
  if (preview) stopRealtimeCatalogPreview(preview.providerId);
  boundary.disposeNativeSdkBridge();
});
afterAll(async () => { await boundary.disposeAudioSession(); });

describe('the shared catalog preview owner', () => {
  it('retains URL-based preview playback and stop cleanup for realtime catalogs', async () => {
    const providerId = 'happier.voice.example/realtime';
    expect(await playRealtimeCatalogPreview({ providerId,
      row: { id: 'calm', name: 'Calm', previewUrl: 'https://preview.example.test/calm.wav' },
      isCurrent: () => true })).toMatchObject({ status: 'completed' });
    expect(audio.play).toHaveBeenCalled();
    expect(boundary.getAudioSessionCoordinator().getSnapshot()).toMatchObject({ leaseCount: 1, configuration: {
      mode: 'playback', input: false, output: true, capture: 'host_managed',
    } });
    expect(readRealtimeCatalogPreview()).toEqual({ providerId, voiceId: 'calm' });
    expect(stopRealtimeCatalogPreview('another-provider')).toBe(false);
    expect(audio.remove).not.toHaveBeenCalled();
    expect(stopRealtimeCatalogPreview(providerId)).toBe(true);
    expect(audio.remove).toHaveBeenCalled();
    expect(audio.detach).toHaveBeenCalled();
    expect(readRealtimeCatalogPreview()).toBeNull();
    await restored.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(boundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });
  it.each(['stop', 'completion'] as const)('retains provider resources until preview %s', async end => {
    let released = false;
    await playRealtimeCatalogPreview({ providerId: 'preview-runtime',
      row: { id: 'calm', name: 'Calm', previewUrl: 'https://preview.example.test/calm.wav' },
      isCurrent: () => true, releaseRuntime: () => { released = true; } });
    expect(released).toBe(false);
    if (end === 'stop') stopRealtimeCatalogPreview('preview-runtime');
    else audio.onStatus?.({ didJustFinish: true });
    expect(released).toBe(true);
    await restored.promise;
  });
  it('releases the catalog playback lease when the OS reports completion', async () => {
    await playRealtimeCatalogPreview({ providerId: 'preview-completion', row: { id: 'calm', name: 'Calm',
      previewUrl: 'https://preview.example.test/calm.wav' }, isCurrent: () => true });
    audio.onStatus?.({ didJustFinish: true });
    expect(readRealtimeCatalogPreview()).toBeNull();
    const coordinator = boundary.getAudioSessionCoordinator();
    await restored.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 0, pendingReleaseCount: 0, configuration: null });
  });
});
