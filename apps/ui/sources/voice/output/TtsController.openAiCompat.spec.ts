import { beforeEach, describe, expect, it, vi } from 'vitest';

const playAudioBytesWithStopper = vi.fn(async (_params: unknown) => undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (params: unknown) => playAudioBytesWithStopper(params),
}));

import { speakOpenAiCompatText } from './TtsController';

describe('speakOpenAiCompatText', () => {
  beforeEach(() => {
    playAudioBytesWithStopper.mockReset();
    playAudioBytesWithStopper.mockResolvedValue(undefined);
  });
  it('reports speaking only when the synthesized audio playback reports its actual start', async () => {
    const synthesize = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' }));
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('browser fetch forbidden'));
    const onPlaybackStarted = vi.fn();
    let notifyPlaybackStarted!: () => void;
    playAudioBytesWithStopper.mockImplementationOnce(async (params: unknown) => {
      const callback = (params as Readonly<{ onPlaybackStarted?: () => void }>).onPlaybackStarted;
      if (!callback) throw new Error('Expected playback-start callback');
      notifyPlaybackStarted = callback;
    });

    await speakOpenAiCompatText({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: 'http://localhost:8002',
      insecureLocalConsentMachineId: 'machine-a',
      credentialKind: 'tts_api_key',
      model: 'tts-1',
      voice: 'alloy',
      format: 'wav',
      input: 'hello',
      registerPlaybackStopper: () => () => undefined,
      onPlaybackStarted,
      client: { synthesize } as any,
    });

    expect(onPlaybackStarted).not.toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: 'http://localhost:8002',
      insecureLocalConsentMachineId: 'machine-a',
      credentialKind: 'tts_api_key',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      signal: expect.any(AbortSignal),
    }));
    expect(playAudioBytesWithStopper).toHaveBeenCalledWith(expect.objectContaining({
      bytes: expect.any(ArrayBuffer),
      format: 'wav',
      onPlaybackStarted,
    }));
    notifyPlaybackStarted();
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    expect(browserFetch).not.toHaveBeenCalled();
    browserFetch.mockRestore();
  });

  it('registers cancellation before synthesis and forwards it to the daemon request', async () => {
    let registeredStopper: (() => void) | null = null;
    const synthesize = vi.fn(async ({ signal }: { signal?: AbortSignal | null }) => await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
    }));
    const onPlaybackStarted = vi.fn();

    const pending = speakOpenAiCompatText({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
      credentialKind: 'tts_api_key',
      model: 'tts-1',
      voice: 'alloy',
      format: 'wav',
      input: 'hello',
      registerPlaybackStopper: (stopper) => {
        registeredStopper = stopper;
        return () => undefined;
      },
      onPlaybackStarted,
      client: { synthesize } as any,
    });

    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    expect(registeredStopper).toBeTypeOf('function');
    registeredStopper!();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('does not report speaking when synthesis fails before playback', async () => {
    const onPlaybackStarted = vi.fn();
    const synthesize = vi.fn(async () => {
      throw new Error('network_synthesis_failed');
    });

    await expect(speakOpenAiCompatText({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
      credentialKind: 'tts_api_key',
      model: 'tts-1',
      voice: 'alloy',
      format: 'wav',
      input: 'hello',
      registerPlaybackStopper: () => () => undefined,
      onPlaybackStarted,
      client: { synthesize } as any,
    })).rejects.toThrow('network_synthesis_failed');

    expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });
});
