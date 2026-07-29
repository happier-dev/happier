import { describe, expect, it } from 'vitest';

import {
  createVoiceInferenceWorkerFrameDecoder,
  encodeVoiceInferenceWorkerFrame,
  parseVoiceInferenceWorkerRequestFrame,
  parseVoiceInferenceWorkerResponseFrame,
  type VoiceInferenceWorkerFrame,
} from './ipcProtocol';

describe('voice inference worker ipc protocol', () => {
  const manifest = {
    packId: 'pack-1',
    kind: 'tts_sherpa' as const,
    model: 'kokoro',
    version: '2026-04-17',
    files: [],
  };
  const publicRuntimeDescriptor = {
    family: 'sherpa_zipformer_streaming' as const,
    artifacts: {
      encoder: { type: 'file' as const, path: 'encoder.onnx' },
      decoder: { type: 'file' as const, path: 'decoder.onnx' },
      joiner: { type: 'file' as const, path: 'joiner.onnx' },
      tokens: { type: 'file' as const, path: 'tokens.txt' },
    },
    abiVersion: 1,
    minHostVersion: '0.2.10',
    platforms: ['darwin' as const],
    architectures: ['arm64' as const],
  };

  it('round-trips a request frame through encode/decode', () => {
    const frame: VoiceInferenceWorkerFrame = {
      kind: 'synthesize',
      id: 'req-1',
      requestId: 'tts-1',
      text: 'hello',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: 'af_bella',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    };

    const decoder = createVoiceInferenceWorkerFrameDecoder();
    const decoded = decoder.push(encodeVoiceInferenceWorkerFrame(frame));
    expect(decoded).toEqual([frame]);
  });

  it('reassembles a frame split across multiple byte chunks', () => {
    const frame: VoiceInferenceWorkerFrame = { kind: 'ping', id: 'p-1' };
    const encoded = encodeVoiceInferenceWorkerFrame(frame);
    const decoder = createVoiceInferenceWorkerFrameDecoder();

    // Split mid-prefix and mid-payload to exercise partial reads.
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2, 6))).toEqual([]);
    expect(decoder.push(encoded.subarray(6))).toEqual([frame]);
  });

  it('decodes multiple frames delivered in a single chunk', () => {
    const a: VoiceInferenceWorkerFrame = { kind: 'ready', id: 'a' };
    const b: VoiceInferenceWorkerFrame = {
      kind: 'partial',
      id: 'b',
      partialKind: 'stt',
      text: 'partial hypothesis',
      language: 'en',
    };
    const c: VoiceInferenceWorkerFrame = {
      kind: 'result',
      id: 'b',
      result: { kind: 'transcribe', text: 'final', language: 'en' },
    };

    const decoder = createVoiceInferenceWorkerFrameDecoder();
    const combined = Buffer.concat([
      encodeVoiceInferenceWorkerFrame(a),
      encodeVoiceInferenceWorkerFrame(b),
      encodeVoiceInferenceWorkerFrame(c),
    ]);
    expect(decoder.push(combined)).toEqual([a, b, c]);
  });

  it('preserves binary audio payloads through base64 chunk frames', () => {
    const audio = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    const frame: VoiceInferenceWorkerFrame = {
      kind: 'partial',
      id: 'tts',
      partialKind: 'tts',
      index: 0,
      chunkBase64: audio.toString('base64'),
    };
    const decoder = createVoiceInferenceWorkerFrameDecoder();
    const [decoded] = decoder.push(encodeVoiceInferenceWorkerFrame(frame));
    expect(decoded).toEqual(frame);
    if (decoded?.kind === 'partial' && decoded.partialKind === 'tts') {
      expect(Buffer.from(decoded.chunkBase64, 'base64')).toEqual(audio);
    } else {
      throw new Error('expected tts partial frame');
    }
  });

  it('rejects an oversized declared frame length', () => {
    const decoder = createVoiceInferenceWorkerFrameDecoder();
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(0xffffffff, 0);
    expect(() => decoder.push(prefix)).toThrow(/too_large/);
  });

  it('honors a custom per-frame byte ceiling on decode (M2)', () => {
    const maxFrameBytes = 1_024;
    const decoder = createVoiceInferenceWorkerFrameDecoder(maxFrameBytes);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(maxFrameBytes + 1, 0);
    expect(() => decoder.push(prefix)).toThrow(/too_large/);
  });

  it('accepts a frame exactly at the custom ceiling but rejects one byte over on encode (M2)', () => {
    const small: VoiceInferenceWorkerFrame = { kind: 'ping', id: 'p' };
    const encoded = encodeVoiceInferenceWorkerFrame(small, 64);
    expect(createVoiceInferenceWorkerFrameDecoder(64).push(encoded)).toEqual([small]);

    const big: VoiceInferenceWorkerFrame = {
      kind: 'partial',
      id: 'tts',
      partialKind: 'tts',
      index: 0,
      chunkBase64: 'a'.repeat(64),
    };
    expect(() => encodeVoiceInferenceWorkerFrame(big, 32)).toThrow(/too_large/);
  });

  describe('response frame schema validation (L4)', () => {
    it('accepts well-formed ready / result / error / snapshot / partial frames', () => {
      expect(parseVoiceInferenceWorkerResponseFrame({ kind: 'ready', id: 'p' })).toMatchObject({ kind: 'ready' });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'error', id: 'p', code: 'runtime_unavailable', message: 'x' }),
      ).toMatchObject({ kind: 'error', code: 'runtime_unavailable' });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'snapshot', packId: 'p', runtimeState: 'ready', residentMemoryBytes: null }),
      ).toMatchObject({ kind: 'snapshot' });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'result', id: 'p', result: { kind: 'transcribe', text: 'hi', language: null } }),
      ).toMatchObject({ kind: 'result' });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'partial', id: 'p', partialKind: 'tts', index: 0, chunkBase64: 'AAA=' }),
      ).toMatchObject({ kind: 'partial', partialKind: 'tts', index: 0 });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'partial', id: 'p', partialKind: 'stt', text: 'hel', language: 'en' }),
      ).toMatchObject({ kind: 'partial', partialKind: 'stt' });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'result', id: 'p', result: { kind: 'stt_stream_start', sessionId: 'worker-stream-1' } }),
      ).toMatchObject({ kind: 'result', result: { kind: 'stt_stream_start' } });
      expect(
        parseVoiceInferenceWorkerResponseFrame({
          kind: 'result',
          id: 'p',
          result: {
            kind: 'stt_stream_append',
            events: [{ type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null }],
          },
        }),
      ).toMatchObject({ kind: 'result', result: { kind: 'stt_stream_append' } });
      expect(
        parseVoiceInferenceWorkerResponseFrame({
          kind: 'result',
          id: 'p',
          result: {
            kind: 'stt_stream_finish',
            text: 'hello',
            language: 'en',
            events: [{ type: 'final', seq: 0, text: 'hello', language: 'en', modelPackId: 'pack-1' }],
          },
        }),
      ).toMatchObject({ kind: 'result', result: { kind: 'stt_stream_finish' } });
      expect(
        parseVoiceInferenceWorkerResponseFrame({ kind: 'result', id: 'p', result: { kind: 'stt_stream_cancel' } }),
      ).toMatchObject({ kind: 'result', result: { kind: 'stt_stream_cancel' } });
    });

    it('rejects a tts partial whose index is negative or non-integer (used directly as an array key)', () => {
      expect(() =>
        parseVoiceInferenceWorkerResponseFrame({ kind: 'partial', id: 'p', partialKind: 'tts', index: -1, chunkBase64: 'AAA=' }),
      ).toThrow();
      expect(() =>
        parseVoiceInferenceWorkerResponseFrame({ kind: 'partial', id: 'p', partialKind: 'tts', index: 1.5, chunkBase64: 'AAA=' }),
      ).toThrow();
    });

    it('rejects a tts partial whose chunkBase64 is not a string', () => {
      expect(() =>
        parseVoiceInferenceWorkerResponseFrame({ kind: 'partial', id: 'p', partialKind: 'tts', index: 0, chunkBase64: 123 }),
      ).toThrow();
    });

    it('rejects an unknown frame kind or a request-kind frame leaking onto the response path', () => {
      expect(() => parseVoiceInferenceWorkerResponseFrame({ kind: 'bogus', id: 'p' })).toThrow();
      expect(() =>
        parseVoiceInferenceWorkerResponseFrame({ kind: 'warm', id: 'p', packId: 'p', packDir: '/d', manifest: {} }),
      ).toThrow();
    });

    it('rejects a synthesize result with a malformed audio output descriptor', () => {
      expect(() =>
        parseVoiceInferenceWorkerResponseFrame({
          kind: 'result',
          id: 'p',
          result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/mpeg' }, bytesBase64: '', name: null },
        }),
      ).toThrow();
    });
  });

  describe('request frame schema validation (LB-M2)', () => {
    it('accepts well-formed control / synthesize / transcribe / streaming-STT request frames', () => {
      expect(parseVoiceInferenceWorkerRequestFrame({ kind: 'ping', id: 'p' })).toMatchObject({ kind: 'ping' });
      expect(parseVoiceInferenceWorkerRequestFrame({ kind: 'abort', id: 'p', targetId: 't' })).toMatchObject({
        kind: 'abort',
        targetId: 't',
      });
      expect(
        parseVoiceInferenceWorkerRequestFrame({ kind: 'warm', id: 'p', packId: 'pack-1', packDir: '/d', manifest }),
      ).toMatchObject({ kind: 'warm' });
      expect(
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'synthesize',
          id: 'p',
          requestId: 'r',
          text: 'hello',
          packId: 'pack-1',
          packDir: '/d',
          manifest,
          voiceId: null,
          speed: null,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        }),
      ).toMatchObject({ kind: 'synthesize' });
      expect(
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'transcribe',
          id: 'p',
          requestId: 'r',
          filePath: '/tmp/a.wav',
          inputMimeType: 'audio/wav',
          packId: 'pack-1',
          packDir: '/d',
          manifest,
          language: null,
          normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
        }),
      ).toMatchObject({ kind: 'transcribe' });
      expect(
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'stt_stream_start',
          id: 'p',
          requestId: 'r',
          packId: 'pack-1',
          packDir: '/d',
          manifest,
          runtimeDescriptor: publicRuntimeDescriptor,
          supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt' }],
          language: 'en',
          format: {
            sampleRateHz: 16_000,
            channelCount: 1,
            bitsPerSample: 16,
            ffmpegCodec: 'pcm_s16le',
          },
        }),
      ).toMatchObject({
        kind: 'stt_stream_start',
        runtimeDescriptor: publicRuntimeDescriptor,
        supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt' }],
      });
      expect(
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'stt_stream_append',
          id: 'p',
          sessionId: 'worker-stream-1',
          seq: 0,
          pcm16Base64: 'AAA=',
        }),
      ).toMatchObject({ kind: 'stt_stream_append' });
      expect(
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'stt_stream_finish',
          id: 'p',
          sessionId: 'worker-stream-1',
          finalSeq: 0,
        }),
      ).toMatchObject({ kind: 'stt_stream_finish' });
      expect(
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'stt_stream_cancel',
          id: 'p',
          sessionId: 'worker-stream-1',
        }),
      ).toMatchObject({ kind: 'stt_stream_cancel' });
    });

    it('rejects a transcribe request missing its manifest (would be cast straight into the engine)', () => {
      expect(() =>
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'transcribe',
          id: 'p',
          requestId: 'r',
          filePath: '/tmp/a.wav',
          inputMimeType: 'audio/wav',
          packId: 'pack-1',
          packDir: '/d',
          language: null,
          normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
        }),
      ).toThrow();
    });

    it('rejects a synthesize request whose text is not a string', () => {
      expect(() =>
        parseVoiceInferenceWorkerRequestFrame({
          kind: 'synthesize',
          id: 'p',
          requestId: 'r',
          text: 123,
          packId: 'pack-1',
          packDir: '/d',
          manifest,
          voiceId: null,
          speed: null,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        }),
      ).toThrow();
    });

    it('rejects an unknown request kind or a response-kind frame leaking onto the request path', () => {
      expect(() => parseVoiceInferenceWorkerRequestFrame({ kind: 'bogus', id: 'p' })).toThrow();
      expect(() => parseVoiceInferenceWorkerRequestFrame({ kind: 'ready', id: 'p' })).toThrow();
    });
  });
});
