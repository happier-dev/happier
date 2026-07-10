import { describe, expect, it } from 'vitest';

import {
  DaemonVoiceOpenAiCompatChatRequestSchema,
  DaemonVoiceOpenAiCompatDownloadAbortRequestSchema,
  DaemonVoiceOpenAiCompatDownloadChunkRequestSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatModelsListRequestSchema,
  DaemonVoiceOpenAiCompatRequestCancelRequestSchema,
  DaemonVoiceOpenAiCompatSynthesizeRequestSchema,
  DaemonVoiceOpenAiCompatSynthesizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeRequestSchema,
} from './voiceOpenAiCompat.js';

const connection = {
  baseUrl: 'https://gateway.example.test/v1',
  insecureLocalOriginConsent: null,
  credentialKind: 'api_key',
} as const;

describe('daemon OpenAI-compatible voice RPC contract', () => {
  it('defines closed, bounded chat and catalog operations', () => {
    expect(DaemonVoiceOpenAiCompatChatRequestSchema.parse({
      ...connection,
      requestId: 'chat-1',
      model: 'voice-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).toMatchObject({ model: 'voice-model' });
    expect(DaemonVoiceOpenAiCompatModelsListRequestSchema.parse(connection)).toEqual(connection);
    expect(() => DaemonVoiceOpenAiCompatChatRequestSchema.parse({
      ...connection,
      requestId: 'chat-1',
      model: 'voice-model',
      messages: [{ role: 'user', content: 'hello' }],
      url: 'https://attacker.example',
    })).toThrow();
    expect(() => DaemonVoiceOpenAiCompatChatRequestSchema.parse({
      ...connection,
      requestId: 'chat-1',
      model: 'voice-model',
      messages: Array.from({ length: 11 }, () => ({ role: 'user', content: 'x'.repeat(100_000) })),
    })).toThrow();
  });

  it('uses bounded transfer-session identities instead of embedding base64 media', () => {
    const uploadInit = DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema.parse({
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    });
    expect(uploadInit).toEqual({ sizeBytes: 3, mimeType: 'audio/wav', fileName: 'speech.wav' });
    expect(() => DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema.parse({
      ...uploadInit,
      sizeBytes: 8 * 1024 * 1024 + 1,
    })).toThrow();

    expect(DaemonVoiceOpenAiCompatTranscribeRequestSchema.parse({
      ...connection,
      requestId: 'stt-1',
      model: 'whisper-1',
      uploadId: 'upload-1',
    })).toMatchObject({ model: 'whisper-1', uploadId: 'upload-1' });
    expect(() => DaemonVoiceOpenAiCompatTranscribeRequestSchema.parse({
      ...connection,
      requestId: 'stt-1',
      model: 'whisper-1',
      uploadId: 'upload-1',
      audio: { bytesBase64: 'd2F2' },
    })).toThrow();

    const synthesize = DaemonVoiceOpenAiCompatSynthesizeRequestSchema.parse({
      ...connection,
      requestId: 'tts-1',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      recipientPublicKeyBase64: 'recipient-key',
    });
    expect(synthesize).toMatchObject({ responseFormat: 'wav', requestId: 'tts-1' });
    expect(() => DaemonVoiceOpenAiCompatSynthesizeResponseSchema.parse({
      ok: true,
      downloadId: 'download-1',
      chunkSizeBytes: 64 * 1024,
      sizeBytes: 3,
      mimeType: 'audio/wav',
      audioBase64: 'AQID',
    })).toThrow();
    expect(() => DaemonVoiceOpenAiCompatSynthesizeRequestSchema.parse({
      ...connection,
      requestId: 'tts-1',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'exe',
      recipientPublicKeyBase64: 'recipient-key',
    })).toThrow();

    expect(DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema.safeParse({
      uploadId: 'upload-1', index: 0, payloadBase64: 'payload', encryptedDataKeyEnvelopeBase64: 'envelope',
    }).success).toBe(true);
    expect(DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema.parse({ uploadId: 'upload-1' })).toEqual({ uploadId: 'upload-1' });
    expect(DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema.parse({ uploadId: 'upload-1' })).toEqual({ uploadId: 'upload-1' });
    expect(DaemonVoiceOpenAiCompatDownloadChunkRequestSchema.parse({ downloadId: 'download-1', index: 0 })).toEqual({ downloadId: 'download-1', index: 0 });
    expect(DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema.parse({ downloadId: 'download-1' })).toEqual({ downloadId: 'download-1' });
    expect(DaemonVoiceOpenAiCompatDownloadAbortRequestSchema.parse({ downloadId: 'download-1' })).toEqual({ downloadId: 'download-1' });
    expect(DaemonVoiceOpenAiCompatRequestCancelRequestSchema.parse({ requestId: 'tts-1' })).toEqual({ requestId: 'tts-1' });
  });
});
