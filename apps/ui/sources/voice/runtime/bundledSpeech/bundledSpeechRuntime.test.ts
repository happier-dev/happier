import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { createDeferred, createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema, tryWriteServerEnabledBitInPlace, type VoiceProviderContribution } from '@happier-dev/protocol';
import { DaemonVoiceSpeechCatalogRequestSchema, DaemonVoiceSpeechTranscribeRequestSchema,
  DaemonVoiceSpeechTranscribeUploadInitRequestSchema, DaemonVoiceSpeechTranscribeUploadInitResponseSchema,
  DaemonVoiceSpeechTranscribeUploadChunkRequestSchema, DaemonVoiceSpeechTranscribeUploadChunkResponseSchema,
  DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema, DaemonVoiceSpeechTranscribeResponseSchema,
  type DaemonVoiceSpeechTranscribeRequest } from '@happier-dev/protocol/daemon/voiceSpeech';
import { VoiceProviderCatalogResponseSchema } from '@happier-dev/protocol/voice/providerOperations';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
import { decryptEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { createHash } from 'node:crypto';
import type { SessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const speech = createVoiceSpeechOutputBoundary({ getAccount: () => account });
let reply: (request: Readonly<{ method: string; payload: unknown }>, signal: AbortSignal) => Promise<unknown>;
const wireRequests = installSessionActionRpcBoundary((request, context) => {
  const split = request.method.indexOf(':');
  expect(request.method.slice(0, split)).toBe('runtime-machine');
  return reply({ method: request.method.slice(split + 1), payload: request.params }, context.signal);
});
await loadSyncSingletonForTests();
// Storage, the registry and speech controllers share the Sync/client module
// graph. Establish their dependencies in the incumbent client-fixture order.
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
const { createBundledSpeechRuntime } = await import('./bundledSpeechRuntime');
const { prepareLocalVoiceTtsRequest } = await import('@/voice/backends/tts/localVoiceTtsProviderControllers');
const { parseLocalVoiceTtsSettings } = await import('@/voice/local/localVoiceSettings');
const { voiceSessionBindingStore, bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner } =
  await import('@/voice/binding/voiceConversationBindingStore');
const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
const features = createRootLayoutFeaturesResponse();
if (!tryWriteServerEnabledBitInPlace(features, 'machines.liveStream.serverRouted', true)) throw new Error('Missing relay feature fixture');
const relayFeatures = FeaturesResponseSchema.parse({ ...features,
  capabilities: { ...features.capabilities, machines: { ...features.capabilities.machines,
    liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
});
const transcribeReply = vi.fn<(request: DaemonVoiceSpeechTranscribeRequest) => Promise<string>>();
let synthesisSignal: AbortSignal | undefined;
let uploadedBytes: Uint8Array;
const wav = { bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' as const };

beforeEach(async () => {
  const { filesystem } = speech.reset();
  filesystem.files.set('file:///recording.wav', new Uint8Array([1, 2, 3, 4]));
  wireRequests.length = 0;
  synthesisSignal = undefined;
  uploadedBytes = new Uint8Array();
  transcribeReply.mockReset();
  transcribeReply.mockResolvedValue(' hello from package ');
  speech.speechSynthesizeRpc.mockResolvedValue(wav);
  const recipient = createTransferRecipientKeyPair();
  const speechReply = speech.machineRpc.getMockImplementation()!;
  reply = async (request, signal) => {
    if (request.method === 'daemon.voice.speech.catalog') {
      DaemonVoiceSpeechCatalogRequestSchema.parse(request.payload);
      return VoiceProviderCatalogResponseSchema.parse({ ok: true, items: [] });
    }
    if (request.method === 'daemon.voice.speech.transcribe.upload.init') {
      const input = DaemonVoiceSpeechTranscribeUploadInitRequestSchema.parse(request.payload);
      expect(input.sizeBytes).toBe(4);
      return DaemonVoiceSpeechTranscribeUploadInitResponseSchema.parse({ success: true, uploadId: 'runtime-upload',
        chunkSizeBytes: 4, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 });
    }
    if (request.method === 'daemon.voice.speech.transcribe.upload.chunk') {
      const input = DaemonVoiceSpeechTranscribeUploadChunkRequestSchema.parse(request.payload);
      uploadedBytes = await decryptEncryptedTransferChunkEnvelope({ ...input, transferId: input.uploadId,
        sequence: input.index, recipientSecretKeySeed: recipient.recipientSecretKeySeed });
      return DaemonVoiceSpeechTranscribeUploadChunkResponseSchema.parse({ success: true });
    }
    if (request.method === 'daemon.voice.speech.transcribe.upload.finalize') return DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema.parse({
      success: true, uploadId: 'runtime-upload', sizeBytes: uploadedBytes.byteLength,
      sha256: createHash('sha256').update(uploadedBytes).digest('hex'),
    });
    if (request.method === 'daemon.voice.speech.transcribe') {
      const input = DaemonVoiceSpeechTranscribeRequestSchema.parse(request.payload);
      return DaemonVoiceSpeechTranscribeResponseSchema.parse({ ok: true, requestId: input.requestId,
        text: await transcribeReply(input) });
    }
    if (request.method === 'daemon.voice.speech.synthesize') synthesisSignal = signal;
    return await speechReply(request);
  };
  account = await restoreServerAccountForTest({ serverUrl: 'https://bundled-runtime.test',
    accountId: 'runtime-account', credentialScope: 'restored-home', request: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return Response.json({ status: 'ok' });
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(relayFeatures);
      const machine = speech.answerMachineHttpRequest(input, 'runtime-machine', 'runtime-account', init);
      if (machine) return machine;
      return null;
    } });
  storage.getState().applyMachines([createMachineFixture({ id: 'runtime-machine', activeAt: Date.now() })]);
  const currentSettings = storage.getState().settings;
  const voiceDelta = normalizeVoiceSettingsLocalDelta({ voice: { ...currentSettings.voice,
    executionMachine: { mode: 'fixed', machineId: 'runtime-machine' } } }, currentSettings);
  storage.getState().applySettingsForScope(storage.getState().settingsScope!, settingsParse({ ...currentSettings, ...voiceDelta }),
    (storage.getState().settingsVersion ?? 0) + 1);
});
afterEach(async () => {
  voiceSessionBindingStore.getState().unbind('runtime-conversation');
  voiceConversationRuntimeMachine.reset();
  await account?.dispose(); speech.disposeNativeSdkBridge();
});
afterAll(() => speech.disposeAudioSession());

type SpeechDeclaration = Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;

const CATALOG_STT_DECLARATION = Object.freeze({
  id: 'catalog-stt',
  title: 'Catalog speech-to-text',
  kind: 'speech',
  roles: ['dictation_stt'],
  platforms: ['web'],
  settings: {
    schemaVersion: 2,
    fields: [{
      id: 'catalogModel',
      title: 'Model',
      schema: { type: 'string', minLength: 1, maxLength: 256 },
      default: 'acme-default',
      presentation: { control: 'select' },
    }, {
      id: 'language',
      title: 'Language',
      schema: { type: 'string', maxLength: 64 },
      default: '',
      presentation: { control: 'text' },
    }],
  },
  catalogs: [{ kind: 'models', settingFieldId: 'catalogModel', allowCustom: true }],
} satisfies SpeechDeclaration);

const CATALOG_TTS_DECLARATION = Object.freeze({
  id: 'catalog-tts',
  title: 'Catalog text-to-speech',
  kind: 'speech',
  roles: ['conversation_tts'],
  platforms: ['web'],
  settings: {
    schemaVersion: 2,
    fields: [{
      id: 'catalogVoice',
      title: 'Voice',
      schema: { type: 'string', maxLength: 256 },
      default: '',
      presentation: { control: 'select' },
    }, {
      id: 'languageCode',
      title: 'Language',
      schema: { type: 'string', maxLength: 64 },
      default: '',
      presentation: { control: 'text' },
    }, {
      id: 'format',
      title: 'Audio format',
      schema: { type: 'string', enum: ['mp3', 'wav'] },
      default: 'mp3',
      presentation: {
        control: 'select',
        options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
      },
    }, {
      id: 'speakingRate',
      title: 'Speaking rate',
      schema: { type: 'number', minimum: 0.25, maximum: 4 },
      default: 1,
      presentation: { control: 'number', step: 0.05 },
    }, {
      id: 'pitch',
      title: 'Pitch',
      schema: { type: 'number', minimum: -20, maximum: 20 },
      default: 0,
      presentation: { control: 'number', step: 0.5 },
    }],
    readiness: [{ kind: 'setting_nonempty', settingId: 'catalogVoice' }],
  },
  catalogs: [{ kind: 'voices', settingFieldId: 'catalogVoice', allowCustom: true }],
} satisfies SpeechDeclaration);

const CATALOG_STT_ID = 'happier.voice.acme/catalog-stt';
const CATALOG_TTS_ID = 'happier.voice.acme/catalog-tts';

function createSpeechRegistry(
  declarations: readonly SpeechDeclaration[],
  enabledPluginIds: ReadonlySet<string> | null = null,
) {
  const pluginId = 'happier.voice.acme';
  const contributions = declarations.map((declaration) => Object.freeze({
    pluginId,
    providerId: `${pluginId}/${declaration.id}`,
    declaration,
  }));
  const presentations = declarations.map((declaration) => Object.freeze({
    providerId: `${pluginId}/${declaration.id}`,
    settingsSectionId: `voice.speech.${declaration.id}`,
    createSettingsSpec: () => null,
  }));
  return Object.freeze({
    registry: createVoiceProviderRegistry({
      bundledContributions: contributions,
      bundledPresentations: presentations,
      enabledPluginIds,
    }),
    providerId: (localId: string) => `${pluginId}/${localId}`,
    entries: contributions,
  });
}

describe('bundledSpeechRuntime', () => {
  const config = { catalogVoice: 'voice', format: 'wav', languageCode: '', speakingRate: 1, pitch: 0 };
  const runtimeFor = (declarations: readonly SpeechDeclaration[]) => createBundledSpeechRuntime({
    registry: createSpeechRegistry(declarations).registry,
  });
  const inputs = () => speech.speechSynthesizeRpc.mock.calls.map(([request]) => request.input);
  it('does not start a prepared audio file after its playback attempt was interrupted', async () => {
    const filesystem = speech.reset().filesystem;
    const controller = createVoicePlaybackController();
    const write = vi.spyOn(filesystem.fs.File.prototype, 'write').mockImplementationOnce(() => {
      controller.interrupt();
    });
    try {
      await runtimeFor([CATALOG_TTS_DECLARATION]).speak(CATALOG_TTS_ID, {
        text: 'Hello.', providerConfig: config,
        registerPlaybackStopper: controller.registerStopper.captureAttempt!(),
      });

      expect(speech.encodedAudio.start).not.toHaveBeenCalled();
      expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    } finally {
      write.mockRestore();
    }
  });
  const prepare = (preference: SessionVoicePreferenceV1 | null) => {
    const target = createSessionFixture({ id: 'runtime-target', serverId: account.home.id, encryptionMode: 'plain',
      metadata: { path: '/runtime', host: 'runtime.test', machineId: 'runtime-machine',
        work: { voicePreference: preference } } });
    const conversation = createSessionFixture({ id: 'runtime-conversation', serverId: account.home.id, encryptionMode: 'plain',
      metadata: { path: '/runtime-voice', host: 'runtime.test', machineId: 'runtime-machine',
        work: { voicePreference: preference ? { ...preference, value: 'history-voice' } : null } } });
    storage.setState({ sessions: { ...storage.getState().sessions, [target.id]: target, [conversation.id]: conversation } });
    voiceConversationRuntimeMachine.reset();
    bindVoiceRuntimeAttemptBinding({ owner: createVoiceRuntimeAttemptBindingOwner(), binding: {
      adapterId: 'local_direct', controlSessionId: 'runtime-control', conversationSessionId: 'runtime-conversation',
      conversationSessionAddress: { serverId: account.home.id, sessionId: 'runtime-conversation' },
      targetSessionAddress: { serverId: account.home.id, sessionId: target.id },
      lifetime: 'runtime_attempt', transcriptMode: 'native_session', updatedAt: Date.now(),
    } });
    voiceConversationRuntimeMachine.transitionToConnecting({ controlSessionId: 'runtime-control' });
    voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: 'runtime-control' });
    const preparation = prepareLocalVoiceTtsRequest({ sessionId: 'runtime-control', text: 'hello',
      settings: storage.getState().settings, tts: parseLocalVoiceTtsSettings({ provider: CATALOG_TTS_ID }),
      networkTimeoutMs: 15_000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });
    if (!preparation) throw new Error('Real bound Session speech preparation unavailable');
    return preparation;
  };
  const assertPrivateSettingsStayLocal = () => {
    for (const request of wireRequests) {
      expect(request.params).not.toHaveProperty('model');
      expect(request.params).not.toHaveProperty('language');
      expect(request.params).not.toHaveProperty('voiceName');
      expect(request.params).not.toHaveProperty('format');
    }
  };

  it('carries the captured Session voice into synthesis and publishes only the actually accepted playback voice', async () => {
    const playbackEntered = createDeferred<void>();
    const preference = { providerContributionId: CATALOG_TTS_ID, settingFieldPath: 'catalogVoice', value: ' bound-voice ' };
    const actualVoice = { ...preference, value: 'bound-voice' };
    speech.speechSynthesizeRpc.mockResolvedValueOnce({ ...wav, appliedVoice: actualVoice });
    speech.encodedAudio.start.mockImplementationOnce(async () => { playbackEntered.resolve(); });
    const preparation = prepare(preference);
    const speaking = runtimeFor([CATALOG_TTS_DECLARATION]).speak(CATALOG_TTS_ID, {
      text: 'hello', providerConfig: config,
      preparation, registerPlaybackStopper: () => () => {},
    });
    await playbackEntered.promise;
    expect(speech.encodedAudio.start).toHaveBeenCalledOnce();
    expect(speech.speechSynthesizeRpc.mock.calls[0]?.[0].voicePreference).toEqual(preference);
    expect(voiceConversationRuntimeMachine.getSnapshot().inUseVoice).toBeUndefined();
    speech.encodedAudio.emit('started');
    expect(voiceConversationRuntimeMachine.getSnapshot().inUseVoice).toMatchObject(actualVoice);
    speech.encodedAudio.emit('finished');
    await speaking;
    expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });

  it('drops a synthesis completed after its captured target retires', async () => {
    const pending = createDeferred<typeof wav>();
    const synthesisEntered = createDeferred<void>();
    const preparation = prepare(null);
    speech.speechSynthesizeRpc.mockImplementationOnce(() => {
      synthesisEntered.resolve();
      voiceSessionBindingStore.getState().unbind('runtime-conversation');
      return pending.promise;
    });
    const speaking = runtimeFor([CATALOG_TTS_DECLARATION]).speak(CATALOG_TTS_ID, {
      text: 'hello', providerConfig: config,
      preparation, registerPlaybackStopper: () => () => {},
    });
    await synthesisEntered.promise;
    expect(speech.speechSynthesizeRpc).toHaveBeenCalledOnce();
    pending.resolve(wav);
    await speaking;
    expect(speech.encodedAudio.start).not.toHaveBeenCalled();
  });

  it.each([
    ['multibyte replies', 9, '😀界你好。 继续。'],
    ['unfinished brackets', 5000, `[ ${'a'.repeat(5100)}`],
    ['literal long links', 5000, `[${'a'.repeat(5100)}](https://example.test/docs)`],
  ])('batches %s by the declared UTF-8 cap through the real settings owner', async (_kind, maxInputUtf8Bytes, text) => {
    const declaration = { ...CATALOG_TTS_DECLARATION, limits: { synthesize: { maxInputUtf8Bytes } } };
    await runtimeFor([declaration]).speak(CATALOG_TTS_ID, { text, providerConfig: config, registerPlaybackStopper: () => () => {} });
    const received = inputs();
    expect(received.length).toBeGreaterThan(1);
    expect(received.every(batch => new TextEncoder().encode(batch).byteLength <= maxInputUtf8Bytes)).toBe(true);
    expect(received.join('').replace(/\s/gu, '')).toBe(text.replace(/\s/gu, ''));
    expect(speech.encodedAudio.start).toHaveBeenCalledTimes(received.length);
  });

  it('batches whole replies by the selected character limit and cancels remaining batches during playback', async () => {
    const declaration = { ...CATALOG_TTS_DECLARATION, limits: { synthesize: { maxInputCharacters: 20 } } };
    let stop: (() => void) | undefined;
    speech.encodedAudio.start.mockImplementation(async () => {
      speech.encodedAudio.emit('started');
      if (inputs().length === 2) stop?.();
      else speech.encodedAudio.emit('finished');
    });
    await runtimeFor([declaration]).speak(CATALOG_TTS_ID, {
      text: 'First short reply. Second short reply. Third short reply.', providerConfig: config,
      registerPlaybackStopper: stopper => { stop = stopper; return () => {}; },
    });
    expect(inputs()).toEqual(['First short reply.', 'Second short reply.']);
    expect(speech.encodedAudio.stop).toHaveBeenCalledOnce();
    expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });

  it('projects enabled bundled speech engines and removes them fail-closed when their package is disabled', () => {
    const declarations = [CATALOG_STT_DECLARATION, CATALOG_TTS_DECLARATION];
    const enabled = runtimeFor(declarations);
    const disabled = createBundledSpeechRuntime({ registry: createSpeechRegistry(declarations, new Set()).registry });
    expect(enabled.sttProviderIds()).toContain(CATALOG_STT_ID);
    expect(enabled.ttsProviderIds()).toContain(CATALOG_TTS_ID);
    expect(disabled.sttProviderIds()).not.toContain(CATALOG_STT_ID);
    expect(disabled.ttsProviderIds()).not.toContain(CATALOG_TTS_ID);
  });

  it('transcribes through the package-owned descriptor without a provider branch in the host', async () => {
    await expect(runtimeFor([CATALOG_STT_DECLARATION]).transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav', providerConfig: { catalogModel: 'gemini-test', language: 'fr' }, capturePurpose: 'dictation',
    })).resolves.toBe('hello from package');
    expect(transcribeReply).toHaveBeenCalledWith(expect.objectContaining({
      target: { pluginId: 'happier.voice.acme', localId: 'catalog-stt' }, mimeType: 'audio/wav', capturePurpose: 'dictation',
    }));
    expect(uploadedBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    assertPrivateSettingsStayLocal();
  });

  it('fails closed before STT dispatch when the canonical root settings envelope is missing', async () => {
    await expect(runtimeFor([CATALOG_STT_DECLARATION]).transcribeRecordedAudio(CATALOG_STT_ID, {
      uri: 'file:///recording.wav', providerConfig: null,
    })).rejects.toMatchObject({ code: 'provider_settings_invalid' });
    expect(transcribeReply).not.toHaveBeenCalled();
    expect(wireRequests).toEqual([]);
  });

  it('synthesizes and plays through host substrate while package config validation fails closed', async () => {
    const playbackEntered = createDeferred<void>();
    speech.encodedAudio.start.mockImplementationOnce(async () => { playbackEntered.resolve(); });
    const onPlaybackStarted = vi.fn();
    const runtime = runtimeFor([CATALOG_TTS_DECLARATION]);
    const speaking = runtime.speak(CATALOG_TTS_ID, { text: 'hello', providerConfig: config,
      registerPlaybackStopper: () => () => {}, onPlaybackStarted });
    await playbackEntered.promise;
    expect(speech.encodedAudio.start).toHaveBeenCalledOnce();
    expect(speech.speechSynthesizeRpc.mock.calls[0]?.[0]).toMatchObject({
      target: { pluginId: 'happier.voice.acme', localId: 'catalog-tts' }, input: 'hello',
    });
    assertPrivateSettingsStayLocal();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    speech.encodedAudio.emit('started');
    speech.encodedAudio.emit('finished');
    await speaking;
    expect(onPlaybackStarted).toHaveBeenCalledOnce();
    await expect(runtime.speak(CATALOG_TTS_ID, { text: 'bad', providerConfig: { speakingRate: 99 },
      registerPlaybackStopper: () => () => {} })).rejects.toMatchObject({ code: 'provider_settings_invalid' });
    expect(speech.speechSynthesizeRpc).toHaveBeenCalledOnce();
  });

  it('cancels in-flight bundled synthesis before playback and suppresses a late result', async () => {
    const pending = createDeferred<typeof wav>();
    const synthesisEntered = createDeferred<void>();
    speech.speechSynthesizeRpc.mockImplementationOnce(() => {
      synthesisEntered.resolve();
      return pending.promise;
    });
    const cancellation: { current: (() => void) | null } = { current: null };
    const speaking = runtimeFor([CATALOG_TTS_DECLARATION]).speak(CATALOG_TTS_ID, { text: 'cancel me', providerConfig: config,
      registerPlaybackStopper: stopper => {
        cancellation.current = stopper;
        return () => { if (cancellation.current === stopper) cancellation.current = null; };
      } });
    const outcome = expect(speaking).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
    await synthesisEntered.promise;
    expect(speech.speechSynthesizeRpc).toHaveBeenCalledOnce();
    cancellation.current!();
    expect(synthesisSignal?.aborted).toBe(true);
    pending.resolve(wav);
    await outcome;
    expect(cancellation.current).toBeNull();
    expect(speech.encodedAudio.start).not.toHaveBeenCalled();
  });

  it('does not report speaking when bundled synthesis fails before playback', async () => {
    speech.failNextSynthesis('provider_unavailable');
    const onPlaybackStarted = vi.fn();
    await expect(runtimeFor([CATALOG_TTS_DECLARATION]).speak(CATALOG_TTS_ID, { text: 'hello', providerConfig: config,
      registerPlaybackStopper: () => () => {}, onPlaybackStarted })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(speech.encodedAudio.start).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('validates a declared text model without carrying it over the daemon RPC', async () => {
    transcribeReply.mockResolvedValueOnce('openai-compatible result');
    const declaration: SpeechDeclaration = { id: 'text-stt', title: 'Text-configured speech-to-text', kind: 'speech',
      roles: ['dictation_stt'], platforms: ['ios'], settings: { schemaVersion: 2, fields: [{
        id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'whisper-1', presentation: { control: 'text' },
      }] } };
    await expect(runtimeFor([declaration]).transcribeRecordedAudio('happier.voice.acme/text-stt', {
      uri: 'file:///recording.wav', providerConfig: { model: 'whisper-custom' },
    })).resolves.toBe('openai-compatible result');
    expect(transcribeReply).toHaveBeenCalledOnce();
    assertPrivateSettingsStayLocal();
  });

  it('validates declared text voice and model settings without carrying them over the daemon RPC', async () => {
    const declaration: SpeechDeclaration = { id: 'text-tts', title: 'Text-configured text-to-speech', kind: 'speech',
      roles: ['conversation_tts'], platforms: ['ios'], settings: { schemaVersion: 2, fields: [
        { id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'tts-1', presentation: { control: 'text' } },
        { id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'alloy', presentation: { control: 'text' } },
        { id: 'format', title: 'Format', schema: { type: 'string', enum: ['mp3', 'wav'] }, default: 'mp3',
          presentation: { control: 'select', options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }] } },
      ] } };
    await runtimeFor([declaration]).speak('happier.voice.acme/text-tts', { text: 'hello',
      providerConfig: { model: 'tts-custom', voiceName: 'verse', format: 'mp3' }, registerPlaybackStopper: () => () => {} });
    expect(speech.speechSynthesizeRpc).toHaveBeenCalledOnce();
    expect(speech.encodedAudio.start).toHaveBeenCalledOnce();
    assertPrivateSettingsStayLocal();
  });
});
