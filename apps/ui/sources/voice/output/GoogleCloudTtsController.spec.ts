import { describe, expect, it, vi } from 'vitest';

const playSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (...args: any[]) => playSpy(...args),
}));

describe('speakGoogleCloudText', () => {
  it('synthesizes audio via Google Cloud TTS and plays it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audioContent: 'Zm9v' }), // "foo"
    });
    (globalThis as any).fetch = fetchSpy;

    const { speakGoogleCloudText } = await import('./GoogleCloudTtsController');
    await speakGoogleCloudText({
      apiKey: 'k',
      androidCertSha1: null,
      input: 'hello',
      voiceName: 'en-US-Wavenet-D',
      languageCode: 'en-US',
      format: 'mp3',
      speakingRate: null,
      pitch: null,
      timeoutMs: 15000,
      registerPlaybackStopper: (_stopper) => () => {},
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('texttospeech.googleapis.com'),
      expect.objectContaining({
        method: 'POST',
      }),
    );

    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as any;
    const body = JSON.parse(String(init.body));
    expect(body.audioConfig.audioEncoding).toBe('MP3');

    expect(playSpy).toHaveBeenCalled();
    const played = playSpy.mock.calls[0]![0];
    expect(played.format).toBe('mp3');
    expect(new Uint8Array(played.bytes)).toEqual(new Uint8Array([102, 111, 111]));
  });
});

