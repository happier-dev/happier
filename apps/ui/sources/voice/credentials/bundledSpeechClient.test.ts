import { describe, expect, it, vi } from 'vitest';

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
  const registry = createVoiceProviderRegistry({
    bundled: [{
      kind: 'voice.speech-engine.v1',
      pluginId: 'acme.voice',
      providerId: 'acme_speech',
      role: 'tts',
      roles: ['conversation_tts'],
      requirements: [],
      settingsSectionId: 'voice.tts.acme',
      internal: {
        createSettingsSpec: () => null,
        speechTarget: { localId: 'speech-v2' },
        schemas: {
          transcribeResponse: {
            safeParse: (value: unknown) => value !== null
              && typeof value === 'object'
              && 'ok' in value
              && value.ok === true
              && 'text' in value
              && typeof value.text === 'string'
              ? { success: true as const, data: { ok: true as const, requestId: 'fixture', text: value.text } }
              : { success: false as const },
          },
          synthesizeResponse: {
            safeParse: (value: unknown) => value !== null
              && typeof value === 'object'
              && 'ok' in value
              && value.ok === true
              && 'downloadId' in value
              && typeof value.downloadId === 'string'
              && 'chunkSizeBytes' in value
              && typeof value.chunkSizeBytes === 'number'
              && 'sizeBytes' in value
              && typeof value.sizeBytes === 'number'
              && 'mimeType' in value
              && (value.mimeType === 'audio/mpeg' || value.mimeType === 'audio/wav')
              ? {
                  success: true as const,
                  data: {
                    ok: true as const,
                    requestId: 'fixture',
                    downloadId: value.downloadId,
                    chunkSizeBytes: value.chunkSizeBytes,
                    sizeBytes: value.sizeBytes,
                    mimeType: value.mimeType,
                  },
                }
              : { success: false as const },
          },
        },
      },
    }],
  });
  return registry.get('acme_speech')!;
}

describe('bundled speech selected-daemon client', () => {
  it('requests a public speech target catalog without provider-private RPC selection or secret material', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      expect(request.method).toBe('daemon.voice.speech.catalog');
      expect(request.payload).toEqual({
        target: { pluginId: 'happier.voice.google', localId: 'speech' },
        providerId: 'google_gemini',
        catalog: 'models',
      });
      return { ok: true, items: [{ id: 'gemini', name: 'Gemini', metadata: {} }] };
    });
    const client = new BundledSpeechDaemonClient({ resolveMachineId: () => 'machine-1', machineRpc: rpc as never });
    const contribution = createDefaultVoiceProviderRegistry().get('google_gemini');
    expect(contribution).not.toBeNull();
    await expect(client.fetchCatalog(contribution!, 'models')).resolves.toEqual([
      { id: 'gemini', name: 'Gemini', metadata: {} },
    ]);
  });

  it('routes a second bundled speech contribution from the supplied normalized registry entry', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      expect(request.method).toBe('daemon.voice.speech.catalog');
      expect(request.payload).toEqual({
        target: { pluginId: 'acme.voice', localId: 'speech-v2' },
        providerId: 'acme_speech',
        catalog: 'voices',
      });
      return { ok: true, items: [{ id: 'acme-voice', name: 'Acme Voice', metadata: {} }] };
    });
    const contribution = createAcmeSpeechContribution();

    const client = new BundledSpeechDaemonClient({ resolveMachineId: () => 'machine-1', machineRpc: rpc as never });
    await expect(client.fetchCatalog(contribution, 'voices')).resolves.toEqual([
      { id: 'acme-voice', name: 'Acme Voice', metadata: {} },
    ]);
  });

  it('uses the same supplied contribution for transcribe and synthesize targets', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: any }>) => {
      expect(request.payload).toEqual(expect.objectContaining({
        target: { pluginId: 'acme.voice', localId: 'speech-v2' },
        providerId: 'acme_speech',
      }));
      if (request.method === 'daemon.voice.speech.transcribe') {
        return { ok: true, text: 'acme transcript' };
      }
      if (request.method === 'daemon.voice.speech.synthesize') {
        return {
          ok: true,
          downloadId: 'download-1',
          sizeBytes: 3,
          mimeType: 'audio/wav',
          chunkSizeBytes: 3,
          nonceBase64: 'nonce',
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
