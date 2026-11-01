import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechOptions } from 'expo-speech';
import { createKokoroWorkerBoundary } from '@/dev/testkit/harness/kokoroWorker';
import { createWebAudioBoundary } from '@/dev/testkit/harness/webAudio';
import { deriveSettingsSecretsKey } from '@/sync/encryption/secretSettings';
import { sync } from '@/sync/sync';

// Boundaries only: platform speech (expo-speech), audio player (expo-audio), file system,
// network (fetch), and browser Worker/Web Audio APIs. Secret encryption and decryption stay real.
const speech = vi.hoisted(() => ({
  speak: vi.fn<(text: string, options?: SpeechOptions) => void>(),
  stop: vi.fn<() => void>(),
}));
vi.mock('expo-speech', () => ({
  speak: (text: string, options?: SpeechOptions) => speech.speak(text, options),
  stop: () => speech.stop(),
}));

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { get OS() { return platform.OS; } } });
});

vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemMock().module;
});

const playedSources = vi.hoisted(() => [] as string[]);
vi.mock('expo-audio', () => ({
  createAudioPlayer: (source: string) => {
    let listener: ((status: unknown) => void) | null = null;
    playedSources.push(source);
    return {
      addListener: (_event: string, cb: (status: unknown) => void) => {
        listener = cb;
        return { remove() {} };
      },
      play: () => {
        queueMicrotask(() => listener?.({ didJustFinish: true }));
      },
      remove() {},
    };
  },
}));

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { createTtsChunker } from '@/voice/output/TtsChunker';
import { getLocalVoiceState, patchLocalVoiceState } from '@/voice/local/localVoiceState';

const fetchMock = vi.fn<typeof fetch>();
const kokoroWorker = createKokoroWorkerBoundary();
const webAudio = createWebAudioBoundary();

beforeEach(() => {
  patchLocalVoiceState({ error: null });
  speech.speak.mockReset().mockImplementation((_text, options) => options?.onDone?.());
  speech.stop.mockReset();
  playedSources.length = 0;
  fetchMock.mockReset();
  platform.OS = 'ios';
  kokoroWorker.messages.length = 0;
  webAudio.decodedBytes.length = 0;
  webAudio.sources.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Worker', kokoroWorker.Worker);
  vi.stubGlobal('AudioContext', webAudio.AudioContext);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function readKokoroStream() {
  await vi.waitFor(() => expect(kokoroWorker.messages[0]?.type).toBe('stream'));
  const request = kokoroWorker.messages[0];
  if (!request || request.type !== 'stream') throw new Error('Expected Kokoro stream request');
  return request;
}

function settingsWithTts(tts: Record<string, unknown>) {
  return {
    voice: {
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
            autoSpeakReplies: true,
            bargeInEnabled: true,
            ...tts,
          },
        },
      },
    },
  };
}

const GOOGLE_TTS = {
  provider: 'google_cloud',
  googleCloud: {
    apiKey: null,
    voiceName: 'en-US-Wavenet-D',
    languageCode: 'en-US',
    format: 'mp3',
    speakingRate: null,
    pitch: null,
  },
};

const OPENAI_TTS = {
  provider: 'openai_compat',
  openaiCompat: { baseUrl: 'http://example.com/v1', apiKey: null, model: 'm', voice: 'v', format: 'wav' },
};

async function speak(text: string, tts: Record<string, unknown>, registerPlaybackStopper = (_s: () => void) => () => {}) {
  return await speakAssistantText({
    text,
    settings: settingsWithTts(tts),
    networkTimeoutMs: 15000,
    registerPlaybackStopper,
    onSpeaking: vi.fn(),
  });
}

describe('speakAssistantText', () => {
  it('speaks inline-code link labels as visible text while preserving literal links in code', async () => {
    await speak('See [`parser`](https://example.test/docs) and literal `[x](url)`.', { provider: 'device' });
    expect(speech.speak).toHaveBeenCalledWith('See parser and literal [x](url).', expect.anything());
  });

  it.each([
    ['Call `f(*args, **kwargs)` and then **continue speaking**.', 'Call f(*args, **kwargs) and then continue speaking.'],
    [`${'a'.repeat(31)}\`\`f(*args, \`literal\`, **kwargs)\`\` then **done**.`, `${'a'.repeat(31)}f(*args, \`literal\`, **kwargs) then done.`],
    ['Before first. See [`parser`](u). Then `left [x](url) right` continues afterward.', 'Before first. See parser. Then left [x](url) right continues afterward.'],
    ['See [the parser documentation with examples](https://example.test/docs). Then continue.', 'See the parser documentation with examples. Then continue.'],
    [`See [${'a'.repeat(45)}](https://example.test/docs). Then continue.`, `See ${'a'.repeat(45)}. Then continue.`],
    ['See ![the architecture diagram with labels](diagram.png). Then continue.', 'See the architecture diagram with labels. Then continue.'],
  ])('preserves inline code across supported streamed cuts: %s', async (text, expected) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    for (const chunk of [...chunker.push(text), ...chunker.flush()]) {
      await speakAssistantText({
        text: chunk,
        speechTextContext,
        settings: settingsWithTts({ provider: 'device' }),
        networkTimeoutMs: 15000,
        registerPlaybackStopper: () => () => {},
        onSpeaking: () => {},
      });
    }
    expect(speech.speak.mock.calls.map(([spoken]) => spoken).join('').replace(/\s+/gu, ''))
      .toBe(expected.replace(/\s+/gu, ''));
  });

  it.each([
    ['](https://example.test/docs). Then continue.', 'Ready first. See the parser documentation with examples. Then continue.'],
    ['', 'Ready first. See [the parser documentation with examples'],
    ['] remains ordinary bracketed prose.', 'Ready first. See [the parser documentation with examples] remains ordinary bracketed prose.'],
  ])('keeps a link label pending until its grammar is decidable: %s', async (tail, expected) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    const first = chunker.push('Ready first. See [the parser documentation with examples');
    expect(first[0]).toBe('Ready first.');
    const chunks = [
      ...first,
      ...chunker.push(tail),
      ...chunker.flush(),
    ];
    for (const text of chunks) {
      await speakAssistantText({
        text, speechTextContext, settings: settingsWithTts({ provider: 'device' }),
        networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {},
      });
    }
    expect(speech.speak.mock.calls.map(([spoken]) => spoken).join(' ').replace(/\s+/gu, ' '))
      .toBe(expected);
  });

  it.each([
    [`**${'a'.repeat(29)}**`, 'a'.repeat(29)],
    [`${'a'.repeat(32)}_count`, `${'a'.repeat(32)}_count`],
    [`${'a'.repeat(31)}_count`, `${'a'.repeat(31)}_count`],
    [`${'a'.repeat(31)} _count_`, `${'a'.repeat(31)}count`],
  ])('preserves delimiter meaning at the streaming hard cut: %s', async (text, expected) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    for (const chunk of [...chunker.push(text), ...chunker.flush()]) {
      await speakAssistantText({
        text: chunk,
        speechTextContext,
        settings: settingsWithTts({ provider: 'device' }),
        networkTimeoutMs: 15000,
        registerPlaybackStopper: () => () => {},
        onSpeaking: () => {},
      });
    }
    expect(speech.speak.mock.calls.map(([spoken]) => spoken).join('')).toBe(expected);
  });

  it.each(['**', '*', '__', '_', '~~'])('keeps %s emphasis out of speech across streamed chunks without delaying ready prose', async (marker) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    const first = 'Hello. This sentence continues inside the same emphasis. ';
    const last = 'World.';
    const literals = ' Use *.ts and **/*.ts and file* with max_retry_count and 2 * 3.';
    const speakChunks = async (chunks: readonly string[]) => {
      for (const text of chunks) {
        await speakAssistantText({
          text,
          speechTextContext,
          settings: settingsWithTts({ provider: 'device' }),
          networkTimeoutMs: 15000,
          registerPlaybackStopper: () => () => {},
          onSpeaking: () => {},
        });
      }
    };

    await speakChunks(chunker.push(`${marker}${first}`));
    expect(speech.speak.mock.calls.length).toBeGreaterThan(0);
    expect(speech.speak.mock.calls.map(([text]) => text).join(' ')).not.toContain(marker);
    await speakChunks([...chunker.push(`${last}${marker}${literals}`), ...chunker.flush()]);

    expect(speech.speak.mock.calls.map(([text]) => text).join(' ')).toBe(`${first}${last}${literals}`);
  });

  it('speaks with device speech', async () => {
    await speak('hello', { provider: 'device' });

    expect(speech.speak).toHaveBeenCalledWith('hello', expect.anything());
    expect(getLocalVoiceState().error).toBe(null);
  });

  it('does not report a failure when device speech is stopped (web cancel fires onerror)', async () => {
    let stopper: (() => void) | null = null;
    speech.speak.mockImplementation(() => {});
    speech.stop.mockImplementation(() => {
      // Browsers report speechSynthesis.cancel() as an 'interrupted'/'canceled' utterance error.
      const options = speech.speak.mock.calls.at(-1)?.[1];
      options?.onError?.(new Error('interrupted'));
    });

    const done = speak('hello', { provider: 'device' }, (s) => {
      stopper = s;
      return () => {};
    });
    await vi.waitFor(() => expect(stopper).toBeTruthy());
    stopper!();

    await expect(done).resolves.toBe(true);
    expect(getLocalVoiceState()).toMatchObject({ error: null, errorMessage: null });
  });

  it('reports a device speech error that was not caused by a stop', async () => {
    speech.speak.mockImplementation((_text, options) => options?.onError?.(new Error('synthesis-failed')));

    await expect(speak('hello', { provider: 'device' })).resolves.toBe(false);
    expect(getLocalVoiceState()).toMatchObject({ error: 'tts_failed', errorMessage: 'synthesis-failed' });
  });

  it('synthesizes and plays OpenAI-compatible speech', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2])));

    await speak('hello', OPENAI_TTS);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('http://example.com/v1');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ input: 'hello', model: 'm', voice: 'v' }));
    expect(playedSources.length).toBe(1);
  });

  it('reports cloud TTS failures in the local voice state', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await speak('hello', OPENAI_TTS);

    expect(playedSources.length).toBe(0);
    expect(getLocalVoiceState()).toMatchObject({ error: 'tts_failed', errorMessage: 'tts_failed:500' });
  });

  it('synthesizes and plays Google Cloud speech', async () => {
    fetchMock.mockResolvedValue(Response.json({ audioContent: 'Zm9v' }));
    const previousWriteKey = Reflect.get(sync, 'settingsSecretsKey');
    const previousReadKeys = Reflect.get(sync, 'settingsSecretsReadKeys');
    const key = await deriveSettingsSecretsKey(new Uint8Array(32).fill(7));
    Reflect.set(sync, 'settingsSecretsKey', key);
    Reflect.set(sync, 'settingsSecretsReadKeys', [key]);
    try {
      const apiKey = sync.encryptSecretValue('secret-key');
      expect(apiKey).not.toBeNull();
      await speak('hello', { ...GOOGLE_TTS, googleCloud: { ...GOOGLE_TTS.googleCloud, apiKey } });

      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('texttospeech.googleapis.com');
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('key')).toBe('secret-key');
      expect(playedSources.length).toBe(1);
      expect(getLocalVoiceState().error).toBe(null);
    } finally {
      Reflect.set(sync, 'settingsSecretsKey', previousWriteKey);
      Reflect.set(sync, 'settingsSecretsReadKeys', previousReadKeys);
    }
  });

  it('reports a Kokoro failure instead of silently switching to the device voice', async () => {
    platform.OS = 'web';
    const speaking = speak('hello', {
      provider: 'local_neural',
      localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1 },
    });
    const request = await readKokoroStream();
    kokoroWorker.emit({ id: request.id, type: 'error', message: 'model_pack_not_installed' });
    await speaking;
    expect(speech.speak).not.toHaveBeenCalled();
    expect(webAudio.sources).toHaveLength(0);
    expect(getLocalVoiceState()).toMatchObject({ error: 'tts_failed', errorMessage: 'model_pack_not_installed' });
  });

  it('passes no Kokoro voice when none is configured so each platform picks its own default', async () => {
    platform.OS = 'web';
    const speaking = speak('hello', {
      provider: 'local_neural',
      localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
    });
    const request = await readKokoroStream();
    expect(request).toMatchObject({ text: 'hello', voiceId: null });
    kokoroWorker.emit({ id: request.id, type: 'stream_chunk', wavBytes: new Uint8Array([1]).buffer, sentenceText: 'hello' });
    kokoroWorker.emit({ id: request.id, type: 'stream_end' });
    await speaking;
    expect(webAudio.sources[0]?.started).toBe(true);
    expect(webAudio.sources[0]?.disconnected).toBe(true);
  });

  it('speaks plain text instead of markdown and code', async () => {
    await speak('**Done.** See [the PR](https://github.com/x/y/pull/1).\n```ts\nconst a = 1;\n```', { provider: 'device' });

    expect(speech.speak).toHaveBeenCalledWith('Done. See the PR.', expect.anything());
  });

  it('does not speak a reply that is only code', async () => {
    await speak('```sh\nls -la\n```', { provider: 'device' });

    expect(speech.speak).not.toHaveBeenCalled();
  });
});
