import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import { BundledSpeechDaemonClient } from './bundledSpeechClient';

const closeUploadSource = vi.fn(async () => undefined);
vi.mock('@/sync/runtime/files/localUploadSourceReader', () => ({
  openLocalUploadSourceReader: vi.fn(async () => ({
    sizeBytes: 4,
    readBytes: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    close: closeUploadSource,
  })),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient', () => ({
  createTransferRecipientKeyPair: () => ({
    recipientPublicKeyBase64: 'recipient-public-key',
    recipientSecretKeySeed: new Uint8Array(32),
  }),
  uploadInChunks: vi.fn(async () => ({ success: true, uploadId: 'upload-1' })),
  downloadInChunks: vi.fn(async (input: Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
  }>) => {
    await input.writeBytes(new Uint8Array([7, 8, 9]));
    return { ok: true };
  }),
}));

function createAcmeSpeechContribution() {
  const declaration = VoiceProviderContributionSchema.parse({
    id: 'speech-v2',
    title: 'Acme Speech',
    kind: 'speech',
    roles: ['dictation_stt', 'conversation_tts'],
    platforms: ['web'],
    catalogs: [
      { kind: 'models', settingFieldId: 'model', allowCustom: true },
      { kind: 'voices', settingFieldId: 'voiceName', allowCustom: true },
    ],
    credentials: {
      slot: { id: 'api_key', purpose: 'voice.speech', title: 'API key' },
      requirement: { kind: 'always' },
      sources: [{
        kind: 'savedSecret',
        secretKinds: ['apiKey'],
        rawGrants: [{
          realm: 'daemon',
          phase: 'speech',
          request: { kind: 'environment', keys: ['ACME_VOICE_API_KEY'] },
        }],
      }],
    },
    settings: {
      schemaVersion: 2,
      fields: [
        {
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'acme-stt',
          presentation: { control: 'select' },
        },
        {
          id: 'voiceName',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'acme-voice',
          presentation: { control: 'select' },
        },
      ],
    },
  });
  if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
  const providerId = 'acme.voice/speech-v2';
  const registry = createVoiceProviderRegistry({
    bundledContributions: [{
      pluginId: 'acme.voice',
      providerId,
      declaration,
    }],
    bundledPresentations: [{
      providerId,
      settingsSectionId: 'voice.tts.acme',
      createSettingsSpec: () => null,
    }],
  });
  return registry.get(providerId)!;
}

describe('bundled speech selected-daemon client', () => {
  it('requests a public speech target catalog without provider-private RPC selection or secret material', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      expect(request.method).toBe('daemon.voice.speech.catalog');
      expect(request.payload).toEqual({
        target: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
        catalog: 'models',
      });
      return { ok: true, items: [{ id: 'gemini', name: 'Gemini', metadata: {} }] };
    });
    const client = new BundledSpeechDaemonClient({ resolveMachineId: () => 'machine-1', machineRpc: rpc as never });
    const contribution = createDefaultVoiceProviderRegistry().get('happier.voice.google/gemini-stt');
    expect(contribution).not.toBeNull();
    await expect(client.fetchCatalog(contribution!, 'models')).resolves.toEqual([
      { id: 'gemini', name: 'Gemini', metadata: {} },
    ]);
  });

  it('routes an external speech contribution through its qualified daemon target', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      expect(request.method).toBe('daemon.voice.speech.catalog');
      expect(request.payload).toEqual({
        target: { pluginId: 'acme.voice', localId: 'speech-v2' },
        catalog: 'voices',
      });
      return { ok: true, items: [{ id: 'acme-voice', name: 'Acme Voice', metadata: {} }] };
    });
    const contribution = Object.freeze({
      ...createAcmeSpeechContribution(),
      source: Object.freeze({
        kind: 'external' as const,
        pluginId: 'acme.voice',
        localId: 'speech-v2',
      }),
    });

    const client = new BundledSpeechDaemonClient({ resolveMachineId: () => 'machine-1', machineRpc: rpc as never });
    await expect(client.fetchCatalog(contribution, 'voices')).resolves.toEqual([
      { id: 'acme-voice', name: 'Acme Voice', metadata: {} },
    ]);
  });

  it('uses the same supplied contribution for transcribe and synthesize targets', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: any }>) => {
      expect(request.payload).toEqual(expect.objectContaining({
        target: { pluginId: 'acme.voice', localId: 'speech-v2' },
      }));
      if (request.method === 'daemon.voice.speech.transcribe') {
        return { ok: true, requestId: request.payload.requestId, text: 'acme transcript' };
      }
      if (request.method === 'daemon.voice.speech.synthesize') {
        return {
          ok: true,
          requestId: request.payload.requestId,
          downloadId: 'download-1',
          sizeBytes: 3,
          mimeType: 'audio/wav',
          chunkSizeBytes: 3,
        };
      }
      throw new Error(`unexpected_method:${request.method}`);
    });
    const contribution = createAcmeSpeechContribution();
    const client = new BundledSpeechDaemonClient({ resolveMachineId: () => 'machine-1', machineRpc: rpc as never });

    await expect(client.transcribe({
      entry: contribution,
      source: { kind: 'native', uri: 'file:///recording.wav' },
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
      model: 'acme-stt',
      language: 'de',
    })).resolves.toBe('acme transcript');
    await expect(client.synthesize({
      entry: contribution,
      input: 'hello',
      model: null,
      voiceName: 'acme-voice',
      languageCode: 'en',
      format: 'wav',
      speakingRate: null,
      pitch: null,
    })).resolves.toEqual({
      bytes: new Uint8Array([7, 8, 9]),
      mimeType: 'audio/wav',
    });
    expect(closeUploadSource).toHaveBeenCalledTimes(1);
  });
});
