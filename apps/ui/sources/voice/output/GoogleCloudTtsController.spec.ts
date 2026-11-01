import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebAudioBoundary } from '@/dev/testkit/harness/webAudio';
import { toSpeechText } from '@/voice/output/speechText';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

let audio: ReturnType<typeof createWebAudioBoundary>;
beforeEach(() => {
  vi.resetModules();
  audio = createWebAudioBoundary();
  vi.stubGlobal('AudioContext', audio.AudioContext);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('speakGoogleCloudText', () => {
  it('synthesizes audio via Google Cloud TTS and plays it', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ audioContent: 'Zm9v' })); // "foo"
    vi.stubGlobal('fetch', fetchSpy);

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
    const init = call[1];
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ audioConfig: { audioEncoding: 'MP3' } });
    expect(audio.decodedBytes.map((bytes) => [...new Uint8Array(bytes)])).toEqual([[102, 111, 111]]);
    expect(audio.sources[0]?.started).toBe(true);
    expect(audio.sources[0]?.disconnected).toBe(true);
  });

  it('does not play audio when stopped while the synthesis request is in flight', async () => {
    const fetchSpy = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchSpy);

    let stopper: (() => void) | null = null;
    const { speakGoogleCloudText } = await import('./GoogleCloudTtsController');
    const promise = speakGoogleCloudText({
      apiKey: 'k',
      androidCertSha1: null,
      input: 'hello',
      voiceName: null,
      languageCode: null,
      format: 'mp3',
      speakingRate: null,
      pitch: null,
      timeoutMs: 15000,
      registerPlaybackStopper: (s) => {
        stopper = s;
        return () => {};
      },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    stopper!();

    await expect(promise).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(audio.sources).toHaveLength(0);
  });

  it.each([
    ['prose', 'Das Wetter ist heute schön und überall ruhig. '.repeat(200)],
    ['unfinished brackets', `[ ${'a'.repeat(5100)}`],
    ['literal link syntax in code', toSpeechText(`\`[${'a'.repeat(5100)}](https://example.test/docs)\``)],
    ['normalized long link label', toSpeechText(`[${'a'.repeat(5100)}](https://example.test/docs)`)],
    ['multibyte hard cuts', `${'a'.repeat(4999)}😀界${'😀界'.repeat(1000)}`],
  ])('splits %s so every request stays within the 5000-byte API limit', async (_kind, input) => {
    const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body: { input: { text: string } } = JSON.parse(String(init?.body));
      const status = new TextEncoder().encode(body.input.text).byteLength > 5000 ? 400 : 200;
      return Response.json({ audioContent: 'Zm9v' }, { status });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { speakGoogleCloudText } = await import('./GoogleCloudTtsController');
    await speakGoogleCloudText({
      apiKey: 'k',
      androidCertSha1: null,
      input,
      voiceName: null,
      languageCode: null,
      format: 'mp3',
      speakingRate: null,
      pitch: null,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
    });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    const sentTexts = fetchSpy.mock.calls.map(([, init]) => {
      // The HTTP leaf receives the real controller's serialized Google request.
      const body: { input: { text: string } } = JSON.parse(String(init?.body));
      return body.input.text;
    });
    for (const text of sentTexts) {
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(5000);
      expect(text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
    }
    expect(sentTexts.join('').replace(/\s/gu, '')).toBe(input.replace(/\s/gu, ''));
    expect(audio.sources).toHaveLength(sentTexts.length);
    expect(audio.sources.every((source) => source.started && source.disconnected)).toBe(true);
  });
});
