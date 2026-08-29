import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { downloadInChunks, uploadInChunks } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';

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

  it('routes a declared speech settings action through the qualified daemon target', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      expect(request.method).toBe('daemon.voice.speech.settingsAction.execute');
      expect(request.payload).toEqual({
        target: { pluginId: 'acme.voice', localId: 'speech-v2' },
        actionId: 'refresh-model',
        expectedSettingsVersion: 7,
      });
      return { ok: true, patch: { model: 'acme-speech-v2' } };
    });
    const client = new BundledSpeechDaemonClient({ resolveMachineId: () => 'machine-1', machineRpc: rpc as never });

    await expect(client.executeSettingsAction({
      entry: createAcmeSpeechContribution(),
      actionId: 'refresh-model',
      expectedSettingsVersion: 7,
    })).resolves.toEqual({ patch: { model: 'acme-speech-v2' } });
  });

  it('uses the same supplied contribution for transcribe and synthesize targets', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: any }>) => {
      if (request.method === 'daemon.voice.speech.transcribe') {
        expect(request.payload).toEqual({
          target: { pluginId: 'acme.voice', localId: 'speech-v2' },
          requestId: expect.any(String),
          uploadId: 'upload-1',
          mimeType: 'audio/wav',
        });
        return { ok: true, requestId: request.payload.requestId, text: 'acme transcript' };
      }
      if (request.method === 'daemon.voice.speech.synthesize') {
        expect(request.payload).toEqual({
          target: { pluginId: 'acme.voice', localId: 'speech-v2' },
          requestId: expect.any(String),
          input: 'hello',
          recipientPublicKeyBase64: 'recipient-public-key',
        });
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
    })).resolves.toBe('acme transcript');
    await expect(client.synthesize({
      entry: contribution,
      input: 'hello',
    })).resolves.toEqual({
      bytes: new Uint8Array([7, 8, 9]),
      mimeType: 'audio/wav',
    });
    expect(closeUploadSource).toHaveBeenCalledTimes(1);
  });

  it('keeps every upload phase of one transcribe on the machine the upload started on', async () => {
    // Auto selection is re-derived from mutable ordering on every read. When
    // `chunk` reaches a machine that never saw `init` the daemon answers
    // `transfer_not_found`, the abort lands on the wrong machine too, and the
    // real staged upload survives on the initiating machine until its TTL.
    const resolveMachineId = vi.fn<(override?: unknown) => string | null>()
      .mockReturnValueOnce('machine-a')
      .mockReturnValue('machine-b');
    const dispatched: Array<Readonly<{ machineId: string; method: string }>> = [];
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: any }>) => {
      dispatched.push({ machineId: request.machineId, method: request.method });
      if (request.method === 'daemon.voice.speech.transcribe.upload.init') {
        return {
          success: true,
          uploadId: 'upload-1',
          chunkSizeBytes: 4,
          recipientPublicKeyBase64: 'recipient-public-key',
        };
      }
      if (request.method === 'daemon.voice.speech.transcribe.upload.chunk') return { success: true };
      if (request.method === 'daemon.voice.speech.transcribe.upload.finalize') {
        return { success: true, uploadId: 'upload-1', sizeBytes: 4, sha256: 'a'.repeat(64) };
      }
      if (request.method === 'daemon.voice.speech.transcribe') {
        return { ok: true, requestId: request.payload.requestId, text: 'bound transcript' };
      }
      throw new Error(`unexpected_method:${request.method}`);
    });
    vi.mocked(uploadInChunks).mockImplementationOnce((async (transfer: any) => {
      const started = await transfer.init();
      await transfer.sendChunk({ uploadId: started.uploadId, index: 0 });
      await transfer.finalize({ uploadId: started.uploadId });
      return { success: true, uploadId: started.uploadId };
    }) as never);

    const client = new BundledSpeechDaemonClient({ resolveMachineId, machineRpc: rpc as never });
    await expect(client.transcribe({
      entry: createAcmeSpeechContribution(),
      source: { kind: 'native', uri: 'file:///recording.wav' },
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
    })).resolves.toBe('bound transcript');

    expect(dispatched.map((entry) => entry.machineId)).toEqual([
      'machine-a', 'machine-a', 'machine-a', 'machine-a',
    ]);
    expect(dispatched.map((entry) => entry.method)).toEqual([
      'daemon.voice.speech.transcribe.upload.init',
      'daemon.voice.speech.transcribe.upload.chunk',
      'daemon.voice.speech.transcribe.upload.finalize',
      'daemon.voice.speech.transcribe',
    ]);
    expect(resolveMachineId).toHaveBeenCalledTimes(1);
  });

  it('uploads to the machine the originating attempt captured rather than the current automatic target', async () => {
    const resolveMachineId = vi.fn<(override?: Readonly<{ machineId: string }> | null) => string | null>(
      (override) => override?.machineId ?? 'machine-drifted',
    );
    const dispatchedMachineIds: string[] = [];
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: any }>) => {
      dispatchedMachineIds.push(request.machineId);
      if (request.method === 'daemon.voice.speech.transcribe') {
        return { ok: true, requestId: request.payload.requestId, text: 'attempt transcript' };
      }
      throw new Error(`unexpected_method:${request.method}`);
    });

    const client = new BundledSpeechDaemonClient({ resolveMachineId, machineRpc: rpc as never });
    await expect(client.transcribe({
      entry: createAcmeSpeechContribution(),
      source: { kind: 'native', uri: 'file:///recording.wav' },
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
      originMachineId: 'machine-attempt',
    })).resolves.toBe('attempt transcript');

    expect(resolveMachineId).toHaveBeenCalledWith({ machineId: 'machine-attempt' });
    expect(dispatchedMachineIds).toEqual(['machine-attempt']);
  });

  it('keeps every synthesis download phase on the machine that produced the download', async () => {
    const resolveMachineId = vi.fn<(override?: unknown) => string | null>()
      .mockReturnValueOnce('machine-a')
      .mockReturnValue('machine-b');
    const dispatched: Array<Readonly<{ machineId: string; method: string }>> = [];
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: any }>) => {
      dispatched.push({ machineId: request.machineId, method: request.method });
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
      if (request.method === 'daemon.voice.speech.download.chunk') {
        return {
          success: true,
          payloadBase64: 'BwgJ',
          encryptedDataKeyEnvelopeBase64: 'ZW52ZWxvcGU=',
          isLast: true,
        };
      }
      if (request.method === 'daemon.voice.speech.download.finalize') return { success: true };
      throw new Error(`unexpected_method:${request.method}`);
    });
    vi.mocked(downloadInChunks).mockImplementationOnce((async (transfer: any) => {
      const started = await transfer.init();
      await transfer.readChunk({ downloadId: started.downloadId, index: 0 });
      await transfer.writeBytes(new Uint8Array([7, 8, 9]));
      await transfer.finalize({ downloadId: started.downloadId });
      return { ok: true };
    }) as never);

    const client = new BundledSpeechDaemonClient({ resolveMachineId, machineRpc: rpc as never });
    await expect(client.synthesize({
      entry: createAcmeSpeechContribution(),
      input: 'hello',
    })).resolves.toEqual({ bytes: new Uint8Array([7, 8, 9]), mimeType: 'audio/wav' });

    expect(dispatched.map((entry) => entry.machineId)).toEqual([
      'machine-a', 'machine-a', 'machine-a',
    ]);
    expect(resolveMachineId).toHaveBeenCalledTimes(1);
  });
});
