import { describe, expect, it } from 'vitest';

import { VOICE_SPEECH_OUTPUT_MAX_BYTES, VoiceProviderContributionSchema, resolveVoiceSpeechSettingsCorrespondence } from '../plugins/contributions/voiceProviders.js';

import {
  DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES,
  DAEMON_VOICE_SPEECH_OUTPUT_MAX_BYTES,
  DaemonVoiceSpeechCatalogRequestSchema,
  DaemonVoiceSpeechDownloadChunkResponseSchema,
  DaemonVoiceSpeechSettingsActionRequestSchema,
  DaemonVoiceSpeechSynthesizeRequestSchema,
  DaemonVoiceSpeechSynthesizeResponseSchema,
  DaemonVoiceSpeechTranscribeRequestSchema,
  DaemonVoiceSpeechTranscribeUploadInitRequestSchema,
  DaemonVoiceSpeechTranscribeUploadInitResponseSchema,
  DaemonVoiceSpeechTranscribeResponseSchema,
} from './voiceSpeech.js';

describe('daemon provider-neutral Voice speech RPC contract', () => {
  it('admits Dictation purpose without accepting caller-selected language or provider configuration', () => {
    const request = { target: { pluginId: 'acme.speech', localId: 'stt' }, requestId: 'dictation-1', mimeType: 'audio/wav', uploadId: 'upload-1', capturePurpose: 'dictation' };
    expect(DaemonVoiceSpeechTranscribeRequestSchema.parse(request)).toMatchObject({ capturePurpose: 'dictation' });
    expect(DaemonVoiceSpeechTranscribeRequestSchema.safeParse({ ...request, language: 'de' }).success).toBe(false);
    expect(DaemonVoiceSpeechTranscribeRequestSchema.safeParse({ ...request, settings: { language: 'de' } }).success).toBe(false);
  });

  it('validates invocation-local recognition against the declared field and preserves stored configuration', () => {
    const contribution = VoiceProviderContributionSchema.parse({ id: 'stt', title: 'STT', kind: 'speech', roles: ['conversation_stt', 'dictation_stt'], platforms: ['web'], settings: { schemaVersion: 1, fields: [
      { id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'stt-model', presentation: { control: 'text' } },
      { id: 'language', title: 'Language', schema: { type: 'string', minLength: 1, maxLength: 64, enum: ['en', 'fr', 'de'] }, default: 'en', presentation: { control: 'select', options: [{ value: 'en', title: 'English' }, { value: 'fr', title: 'French' }, { value: 'de', title: 'German' }] } },
    ] } });
    if (contribution.kind !== 'speech') throw new Error('expected speech declaration');
    const settings = Object.freeze({ model: 'stt-model', language: 'fr' });
    expect(resolveVoiceSpeechSettingsCorrespondence({ contribution, settings }).transcribe?.language).toBe('fr');
    expect(resolveVoiceSpeechSettingsCorrespondence({ contribution, settings, recognitionLanguage: 'de' }).transcribe?.language).toBe('de');
    expect(resolveVoiceSpeechSettingsCorrespondence({ contribution, settings, recognitionLanguage: null }).transcribe?.language).toBe('en');
    expect(settings.language).toBe('fr');
    expect(() => resolveVoiceSpeechSettingsCorrespondence({ contribution, settings, recognitionLanguage: 'es' })).toThrow();
    expect(() => resolveVoiceSpeechSettingsCorrespondence({ contribution, settings: { ...settings, language: 1 }, recognitionLanguage: 'de' })).toThrow();
    const withoutLanguage = { ...contribution, settings: { ...contribution.settings, fields: contribution.settings.fields.filter((field) => field.id !== 'language') } };
    const unsupported = resolveVoiceSpeechSettingsCorrespondence({ contribution: withoutLanguage, settings: { model: 'stt-model' }, recognitionLanguage: 'de' });
    expect(unsupported.transcribe?.language).toBeNull();
    expect(unsupported.settings).not.toHaveProperty('language');
    const ttsOnly = VoiceProviderContributionSchema.parse({ ...contribution, roles: ['conversation_tts'], settings: { ...contribution.settings, fields: [
      ...contribution.settings.fields,
      { id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'voice', presentation: { control: 'text' } },
      { id: 'format', title: 'Format', schema: { type: 'string', enum: ['mp3', 'wav'] }, default: 'mp3', presentation: { control: 'select', options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }] } },
    ] } });
    if (ttsOnly.kind !== 'speech') throw new Error('expected speech declaration');
    const synthesis = resolveVoiceSpeechSettingsCorrespondence({ contribution: ttsOnly, settings: { ...settings, voiceName: 'voice', format: 'mp3' }, recognitionLanguage: 'de' });
    expect(synthesis.transcribe).toBeNull();
    expect(synthesis.settings.language).toBe('fr');
  });
  it('uses one canonical 16 MiB speech output ceiling at the provider and wire boundary', () => {
    expect(VOICE_SPEECH_OUTPUT_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(DAEMON_VOICE_SPEECH_OUTPUT_MAX_BYTES).toBe(VOICE_SPEECH_OUTPUT_MAX_BYTES);
  });

  it('owns every strict provider-neutral operation request without predecessor selectors', () => {
    const target = { pluginId: 'happier.voice.google', localId: 'gemini-stt' } as const;

    expect(DaemonVoiceSpeechCatalogRequestSchema.parse({ target, catalog: 'models' }))
      .toEqual({ target, catalog: 'models' });
    expect(DaemonVoiceSpeechTranscribeRequestSchema.parse({
      target,
      requestId: 'stt-1',
      mimeType: 'audio/wav',
      uploadId: 'upload-1',
    })).toMatchObject({ requestId: 'stt-1', uploadId: 'upload-1' });
    expect(DaemonVoiceSpeechSynthesizeRequestSchema.parse({
      target: { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' },
      requestId: 'tts-1',
      input: 'Hello',
      recipientPublicKeyBase64: 'recipient-key',
    })).toMatchObject({ requestId: 'tts-1', input: 'Hello' });

    expect(() => DaemonVoiceSpeechCatalogRequestSchema.parse({
      target: { ...target, providerId: 'google_gemini' },
      catalog: 'models',
    })).toThrow();
    expect(() => DaemonVoiceSpeechTranscribeRequestSchema.parse({
      target,
      providerId: 'google_gemini',
      requestId: 'stt-1',
      mimeType: 'audio/wav',
      uploadId: 'upload-1',
    })).toThrow();
    expect(() => DaemonVoiceSpeechSynthesizeRequestSchema.parse({
      target,
      requestId: 'tts-1',
      input: 'Hello',
      recipientPublicKeyBase64: 'recipient-key',
      retiredSelector: 'google_cloud',
    })).toThrow();
    expect(() => DaemonVoiceSpeechSynthesizeRequestSchema.parse({
      target,
      requestId: 'tts-1',
      input: 'Hello',
      recipientPublicKeyBase64: 'recipient-key',
      voiceName: 'caller-must-not-select-settings',
    })).toThrow();
  });

  it('accepts the strict current transcription success and rejects the predecessor shape', () => {
    const current = {
      ok: true,
      requestId: 'speech-request-1',
      text: 'hello',
    } as const;

    expect(DaemonVoiceSpeechTranscribeResponseSchema.parse(current)).toEqual(current);
    expect(() => DaemonVoiceSpeechTranscribeResponseSchema.parse({
      ok: true,
      text: 'missing request identity',
    })).toThrow();
    expect(() => DaemonVoiceSpeechTranscribeResponseSchema.parse({
      ...current,
      providerId: 'retired_nested_selector',
    })).toThrow();
  });

  it('binds a settings action to the exact canonical Account Settings revision only', () => {
    const target = { pluginId: 'acme.voice', localId: 'speech' } as const;
    const request = {
      target,
      actionId: 'refresh-model',
      expectedSettingsVersion: 7,
    } as const;

    expect(DaemonVoiceSpeechSettingsActionRequestSchema.parse(request)).toEqual(request);
    expect(DaemonVoiceSpeechSettingsActionRequestSchema.safeParse({
      target,
      actionId: 'refresh-model',
    }).success).toBe(false);
    expect(DaemonVoiceSpeechSettingsActionRequestSchema.safeParse({
      ...request,
      expectedSettingsVersion: -1,
    }).success).toBe(false);
    expect(DaemonVoiceSpeechSettingsActionRequestSchema.safeParse({
      ...request,
      settings: { model: 'caller-must-not-supply-settings' },
    }).success).toBe(false);
  });

  it('accepts the strict current synthesis transfer metadata and bounded provider error', () => {
    const current = {
      ok: true,
      requestId: 'speech-request-2',
      downloadId: 'download-1',
      chunkSizeBytes: 64 * 1024,
      sizeBytes: 1024,
      mimeType: 'audio/wav',
    } as const;

    expect(DaemonVoiceSpeechSynthesizeResponseSchema.parse(current)).toEqual(current);
    expect(DaemonVoiceSpeechSynthesizeResponseSchema.parse({
      ok: false,
      errorCode: 'provider_unavailable',
    })).toEqual({ ok: false, errorCode: 'provider_unavailable' });
    expect(() => DaemonVoiceSpeechSynthesizeResponseSchema.parse({
      ...current,
      nonceBase64: 'predecessor-only-field',
    })).toThrow();
  });

  it('owns strict provider-neutral transfer schemas without accepting predecessor selectors', () => {
    const currentInitRequest = {
      target: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      sizeBytes: 1024,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    } as const;
    expect(DaemonVoiceSpeechTranscribeUploadInitRequestSchema.parse(currentInitRequest)).toEqual(currentInitRequest);
    expect(() => DaemonVoiceSpeechTranscribeUploadInitRequestSchema.parse({
      sizeBytes: 1024,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    })).toThrow();
    expect(() => DaemonVoiceSpeechTranscribeUploadInitRequestSchema.parse({
      ...currentInitRequest,
      providerId: 'google',
    })).toThrow();
    expect(DaemonVoiceSpeechTranscribeUploadInitRequestSchema.safeParse({
      ...currentInitRequest,
      sizeBytes: DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES,
    }).success).toBe(true);
    expect(DaemonVoiceSpeechTranscribeUploadInitRequestSchema.safeParse({
      ...currentInitRequest,
      sizeBytes: DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES + 1,
    }).success).toBe(false);
    expect(DaemonVoiceSpeechTranscribeUploadInitRequestSchema.safeParse({
      ...currentInitRequest,
      mimeType: 'audio/flac',
    }).success).toBe(false);

    expect(DaemonVoiceSpeechTranscribeUploadInitResponseSchema.parse({
      success: true,
      uploadId: 'upload-1',
      chunkSizeBytes: 64 * 1024,
      recipientPublicKeyBase64: 'recipient-key',
    })).toMatchObject({ uploadId: 'upload-1' });
    expect(() => DaemonVoiceSpeechDownloadChunkResponseSchema.parse({
      success: true,
      payloadBase64: 'payload',
      encryptedDataKeyEnvelopeBase64: 'envelope',
      isLast: true,
      nonceBase64: 'predecessor-only-field',
    })).toThrow();
  });
});
