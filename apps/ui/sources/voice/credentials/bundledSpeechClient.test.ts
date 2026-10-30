import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForTestEvent } from '@/dev/testkit';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { DaemonVoiceSpeechSynthesizeRequestSchema, DaemonVoiceSpeechTranscribeRequestSchema,
  DaemonVoiceSpeechTranscribeUploadChunkRequestSchema } from '@happier-dev/protocol/daemon/voiceSpeech';

import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
import { createEncryptedTransferChunkEnvelope, decryptEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';

const fileBoundary = vi.hoisted(() => ({ current: undefined as
  ReturnType<typeof import('@/dev/testkit/mocks/expoFileSystem')['createExpoFileSystemFileMock']> | undefined }));
vi.mock('expo-file-system', async () => {
  fileBoundary.current = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
  return fileBoundary.current.module;
});

vi.mock('socket.io-client', async original => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
let daemonReply: (request: Readonly<{ machineId: string; method: string; payload: unknown }>) => Promise<unknown>;
installSessionActionRpcBoundary(request => {
  const separator = request.method.indexOf(':');
  return daemonReply({ machineId: request.method.slice(0, separator),
    method: request.method.slice(separator + 1), payload: request.params });
});
const { storage } = await import('@/sync/domains/state/storage');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { resolveVoiceExecutionMachineId } = await import('@/voice/settings/executionMachine');
const { persistVoiceAutoTargetMachineId } = await import('@/voice/persistence/voiceAutoTargetMachineSettings');
const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
const { BundledSpeechDaemonClient } = await import('./bundledSpeechClient');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const features = createRootLayoutFeaturesResponse();
if (!tryWriteServerEnabledBitInPlace(features, 'machines.liveStream.serverRouted', true)) throw new Error('Expected relay feature fixture');
const relayFeatures = FeaturesResponseSchema.parse({ ...features,
  capabilities: { ...features.capabilities, machines: { ...features.capabilities.machines,
    liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
});
const machineIds = ['machine-1', 'machine-origin', 'machine-other', 'machine-a', 'machine-b', 'machine-drifted', 'machine-attempt'];

function selectMachine(machineId: string) {
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
    voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId } },
  }, storage.getState().settings));
}

function clientWithDaemonReply(reply: typeof daemonReply, machineId = 'machine-1') {
  daemonReply = reply;
  selectMachine(machineId);
  return new BundledSpeechDaemonClient();
}

await import('expo-file-system');
const filesystem = fileBoundary.current!;
const uploadRecipient = createTransferRecipientKeyPair();
const speechBytes = new Uint8Array([7, 8, 9]);

/** Daemon wire responses use the real encryption producer consumed by transfer plumbing. */
async function serveUpload(request: Readonly<{ method: string; payload: unknown }>) {
  if (request.method === 'daemon.voice.speech.transcribe.upload.init') return {
    success: true, uploadId: 'upload-1', chunkSizeBytes: 4,
    recipientPublicKeyBase64: uploadRecipient.recipientPublicKeyBase64,
  };
  if (request.method === 'daemon.voice.speech.transcribe.upload.chunk') {
    const payload = DaemonVoiceSpeechTranscribeUploadChunkRequestSchema.parse(request.payload);
    await expect(decryptEncryptedTransferChunkEnvelope({ ...payload,
      transferId: payload.uploadId, sequence: payload.index, recipientSecretKeySeed: uploadRecipient.recipientSecretKeySeed,
    })).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    return { success: true };
  }
  if (request.method === 'daemon.voice.speech.transcribe.upload.finalize') return {
    success: true, uploadId: 'upload-1', sizeBytes: 4, sha256: 'a'.repeat(64),
  };
  return null;
}

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
        {
          id: 'format',
          title: 'Audio format',
          schema: { type: 'string', enum: ['mp3', 'wav'] },
          default: 'mp3',
          presentation: {
            control: 'select',
            options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
          },
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
  beforeEach(async () => {
    filesystem.files.set('file:///recording.wav', [1, 2, 3, 4]);
    filesystem.close.mockClear();
    account = await restoreServerAccountForTest({
      serverUrl: 'https://voice-speech.test', accountId: 'account-a', credentialScope: 'restored-home',
      request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(relayFeatures);
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v1/machines') return Response.json(machineIds.map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        const machine = /^\/v1\/machines\/([^/]+)$/.exec(path);
        if (machine) return Response.json({ machine: createPlainMachineRowFixture({ id: machine[1]!, accountId: 'account-a' }) });
        return null;
      },
    });
    // Admit the real HTTP baseline before publishing app-local target changes.
    // A still-pending bootstrap is allowed to replace that unacknowledged fixture input.
    await waitForTestEvent(storage.subscribe, storage.getState, state => state.settingsScope?.serverId === account!.home.id
      && state.settingsScope.accountId === 'account-a' && state.settingsVersion === 1);
    expect(storage.getState().settingsScope).toEqual({ serverId: account!.home.id, accountId: 'account-a' });
    expect(storage.getState().settingsVersion).toBe(1);
    storage.getState().applyMachines(machineIds.map(id => createMachineFixture({ id, activeAt: Date.now() })));
  });
  afterEach(async () => { await account?.dispose(); account = null; });
  it('requests a public speech target catalog without provider-private RPC selection or secret material', async () => {
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      expect(request.method).toBe('daemon.voice.speech.catalog');
      expect(request.payload).toEqual({
        target: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
        catalog: 'models',
      });
      return { ok: true, items: [{ id: 'gemini', name: 'Gemini', metadata: {} }] };
    });
    const client = clientWithDaemonReply(rpc);
    const contribution = createDefaultVoiceProviderRegistry().get('happier.voice.google/gemini-stt');
    expect(contribution).not.toBeNull();
    await expect(client.fetchCatalog(contribution!, 'models')).resolves.toEqual([
      { id: 'gemini', name: 'Gemini', metadata: {} },
    ]);
  });

  it('routes an external speech contribution through its qualified daemon target', async () => {
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: unknown }>) => {
      expect(request.machineId).toBe('machine-origin');
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

    const client = clientWithDaemonReply(rpc, 'machine-other');
    await expect(client.fetchCatalog(contribution, 'voices', undefined, 'machine-origin')).resolves.toEqual([
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
    const client = clientWithDaemonReply(rpc);

    await expect(client.executeSettingsAction({
      entry: createAcmeSpeechContribution(),
      actionId: 'refresh-model',
      expectedSettingsVersion: 7,
    })).resolves.toEqual({ patch: { model: 'acme-speech-v2' } });
  });

  it('uses the same supplied contribution for transcribe and synthesize targets', async () => {
    const voicePreference = { providerContributionId: 'acme.voice/speech-v2', settingFieldPath: 'voiceName', value: 'bound-voice' };
    let encryptedSpeech: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
    const rpc = vi.fn(async (request: Readonly<{ method: string; payload: unknown }>) => {
      const upload = await serveUpload(request);
      if (upload) return upload;
      if (request.method === 'daemon.voice.speech.transcribe') {
        expect(request.payload).toEqual({
          target: { pluginId: 'acme.voice', localId: 'speech-v2' },
          requestId: expect.any(String),
          uploadId: 'upload-1',
          mimeType: 'audio/wav',
          capturePurpose: 'dictation',
        });
        return { ok: true, requestId: DaemonVoiceSpeechTranscribeRequestSchema.parse(request.payload).requestId, text: 'acme transcript' };
      }
      if (request.method === 'daemon.voice.speech.synthesize') {
        expect(request.payload).toEqual({
          target: { pluginId: 'acme.voice', localId: 'speech-v2' },
          requestId: expect.any(String),
          input: 'hello',
          voicePreference,
          recipientPublicKeyBase64: expect.any(String),
        });
        const synthesized = DaemonVoiceSpeechSynthesizeRequestSchema.parse(request.payload);
        encryptedSpeech = await createEncryptedTransferChunkEnvelope({ transferId: 'download-1', sequence: 0,
          payload: speechBytes, recipientPublicKeyBase64: synthesized.recipientPublicKeyBase64 });
        return {
          ok: true,
          requestId: synthesized.requestId,
          downloadId: 'download-1',
          sizeBytes: 3,
          mimeType: 'audio/wav',
          chunkSizeBytes: 3,
          appliedVoice: voicePreference,
        };
      }
      if (request.method === 'daemon.voice.speech.download.chunk') return { success: true, ...encryptedSpeech!, isLast: true };
      if (request.method === 'daemon.voice.speech.download.finalize') return { success: true };
      throw new Error(`unexpected_method:${request.method}`);
    });
    const contribution = createAcmeSpeechContribution();
    const client = clientWithDaemonReply(rpc);

    await expect(client.transcribe({
      entry: contribution,
      source: { kind: 'native', uri: 'file:///recording.wav' },
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
      capturePurpose: 'dictation',
    })).resolves.toBe('acme transcript');
    await expect(client.synthesize({
      entry: contribution,
      input: 'hello',
      voicePreference,
    })).resolves.toEqual({
      bytes: new Uint8Array([7, 8, 9]),
      mimeType: 'audio/wav',
      appliedVoice: voicePreference,
    });
    expect(filesystem.close.mock.calls).toEqual([['file:///recording.wav']]);
  });

  it('keeps every upload phase of one transcribe on the machine the upload started on', async () => {
    // Auto selection is re-derived from mutable ordering on every read. When
    // `chunk` reaches a machine that never saw `init` the daemon answers
    // `transfer_not_found`, the abort lands on the wrong machine too, and the
    // real staged upload survives on the initiating machine until its TTL.
    const dispatched: Array<Readonly<{ machineId: string; method: string }>> = [];
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: unknown }>) => {
      dispatched.push({ machineId: request.machineId, method: request.method });
      if (request.method === 'daemon.voice.speech.transcribe.upload.init') selectMachine('machine-b');
      const upload = await serveUpload(request);
      if (upload) return upload;
      if (request.method === 'daemon.voice.speech.transcribe') {
        return { ok: true, requestId: DaemonVoiceSpeechTranscribeRequestSchema.parse(request.payload).requestId, text: 'bound transcript' };
      }
      throw new Error(`unexpected_method:${request.method}`);
    });

    const client = clientWithDaemonReply(rpc, 'machine-a');
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
    expect(resolveVoiceExecutionMachineId()).toBe('machine-b');
  });

  it('uploads to the machine the originating attempt captured rather than the current automatic target', async () => {
    const dispatchedMachineIds: string[] = [];
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: unknown }>) => {
      dispatchedMachineIds.push(request.machineId);
      const upload = await serveUpload(request);
      if (upload) return upload;
      if (request.method === 'daemon.voice.speech.transcribe') {
        return { ok: true, requestId: DaemonVoiceSpeechTranscribeRequestSchema.parse(request.payload).requestId, text: 'attempt transcript' };
      }
      throw new Error(`unexpected_method:${request.method}`);
    });

    const client = clientWithDaemonReply(rpc, 'machine-drifted');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
      voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'auto', machineId: null } },
    }, storage.getState().settings));
    persistVoiceAutoTargetMachineId('machine-drifted', storage.getState().settingsScope);
    expect(resolveVoiceExecutionMachineId()).toBe('machine-drifted');
    await expect(client.transcribe({
      entry: createAcmeSpeechContribution(),
      source: { kind: 'native', uri: 'file:///recording.wav' },
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
      originMachineId: 'machine-attempt',
    })).resolves.toBe('attempt transcript');

    expect(resolveVoiceExecutionMachineId()).toBe('machine-drifted');
    expect(dispatchedMachineIds).toEqual(['machine-attempt', 'machine-attempt', 'machine-attempt', 'machine-attempt']);
  });

  it('keeps every synthesis download phase on the machine that produced the download', async () => {
    const dispatched: Array<Readonly<{ machineId: string; method: string }>> = [];
    let encryptedSpeech: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
    const rpc = vi.fn(async (request: Readonly<{ machineId: string; method: string; payload: unknown }>) => {
      dispatched.push({ machineId: request.machineId, method: request.method });
      if (request.method === 'daemon.voice.speech.synthesize') {
        selectMachine('machine-b');
        const synthesized = DaemonVoiceSpeechSynthesizeRequestSchema.parse(request.payload);
        encryptedSpeech = await createEncryptedTransferChunkEnvelope({ transferId: 'download-1', sequence: 0,
          payload: speechBytes, recipientPublicKeyBase64: synthesized.recipientPublicKeyBase64 });
        return {
          ok: true,
          requestId: synthesized.requestId,
          downloadId: 'download-1',
          sizeBytes: 3,
          mimeType: 'audio/wav',
          chunkSizeBytes: 3,
        };
      }
      if (request.method === 'daemon.voice.speech.download.chunk') {
        return {
          success: true,
          ...encryptedSpeech!,
          isLast: true,
        };
      }
      if (request.method === 'daemon.voice.speech.download.finalize') return { success: true };
      throw new Error(`unexpected_method:${request.method}`);
    });

    const client = clientWithDaemonReply(rpc, 'machine-a');
    await expect(client.synthesize({
      entry: createAcmeSpeechContribution(),
      input: 'hello',
    })).resolves.toEqual({ bytes: new Uint8Array([7, 8, 9]), mimeType: 'audio/wav' });

    expect(dispatched.map((entry) => entry.machineId)).toEqual([
      'machine-a', 'machine-a', 'machine-a',
    ]);
    expect(resolveVoiceExecutionMachineId()).toBe('machine-b');
  });

  it('retires the staged upload and closes the native reader when an encrypted chunk is refused', async () => {
    const methods: string[] = [];
    const client = clientWithDaemonReply(async request => {
      methods.push(request.method);
      if (request.method === 'daemon.voice.speech.transcribe.upload.chunk') return { success: false,
        error: 'transfer_not_found', errorCode: 'transfer_not_found' };
      if (request.method === 'daemon.voice.speech.transcribe.upload.abort') return { success: true };
      const response = await serveUpload(request);
      if (response) return response;
      throw new Error(`unexpected_method:${request.method}`);
    });
    await expect(client.transcribe({ entry: createAcmeSpeechContribution(),
      source: { kind: 'native', uri: 'file:///recording.wav' }, mimeType: 'audio/wav', fileName: 'recording.wav',
    })).rejects.toMatchObject({ code: 'transfer_failed' });
    expect(methods).toEqual(['daemon.voice.speech.transcribe.upload.init',
      'daemon.voice.speech.transcribe.upload.chunk', 'daemon.voice.speech.transcribe.upload.abort']);
    expect(filesystem.close.mock.calls).toEqual([['file:///recording.wav']]);
  });

  it('rejects a corrupt encrypted download and retires its daemon custody', async () => {
    const methods: string[] = [];
    const client = clientWithDaemonReply(async request => {
      methods.push(request.method);
      if (request.method === 'daemon.voice.speech.synthesize') return { ok: true,
        requestId: DaemonVoiceSpeechSynthesizeRequestSchema.parse(request.payload).requestId,
        downloadId: 'download-corrupt', sizeBytes: 3, mimeType: 'audio/wav', chunkSizeBytes: 3 };
      if (request.method === 'daemon.voice.speech.download.chunk') return {
        success: true, payloadBase64: 'BwgJ', encryptedDataKeyEnvelopeBase64: 'ZW52ZWxvcGU=', isLast: true,
      };
      if (request.method === 'daemon.voice.speech.download.abort') return { success: true };
      throw new Error(`unexpected_method:${request.method}`);
    });
    await expect(client.synthesize({ entry: createAcmeSpeechContribution(), input: 'hello' }))
      .rejects.toMatchObject({ code: 'transfer_failed' });
    expect(methods).toEqual(['daemon.voice.speech.synthesize',
      'daemon.voice.speech.download.chunk', 'daemon.voice.speech.download.abort']);
  });
});
