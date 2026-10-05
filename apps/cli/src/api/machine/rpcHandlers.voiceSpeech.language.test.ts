import { describe, expect, it } from 'vitest';
import { accountSettingsParse, VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/openai-compat/src/manifest';
import { OPENAI_COMPAT_STT_RUNTIME } from '../../../../../packages/plugins/openai-compat/src/voice/speech';
import { registerMachineVoiceSpeechRpcHandlers } from './rpcHandlers.voiceSpeech';
import { readVoiceSpeechSettingsSnapshot } from './voiceSpeechSettings';

const target = { pluginId: PLUGIN_MANIFEST.id, localId: 'stt' };
const providerId = `${target.pluginId}/${target.localId}`;
const declaration = VoiceProviderContributionSchema.parse((PLUGIN_MANIFEST.contributes.voiceProviders ?? []).find((value) => value.id === target.localId));
if (declaration.kind !== 'speech') throw new Error('expected actual speech contribution');
const contribution = declaration;

function snapshot(language: string | null): ActiveAccountSettingsSnapshot {
  return { source: 'network', scopeKey: 'language-account', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({ voiceSettingsV1: {
    assistantLanguage: 'es', dictation: { language },
    providers: { [providerId]: { schemaVersion: contribution.settings.schemaVersion, config: Object.fromEntries(contribution.settings.fields.map((field) => [field.id, field.id === 'language' ? 'fr' : field.id === 'baseUrl' ? 'https://speech.example.test/v1' : field.default])) } },
  } }) };
}

describe('registered speech recognition language at the real daemon/plugin boundary', () => {
  it('invalidates only the Dictation settings snapshot when its captured language changes', () => {
    let current = snapshot('de');
    const input = { providerId, contribution, readSnapshot: () => current, isRuntimeCurrent: () => true };
    const conversation = readVoiceSpeechSettingsSnapshot(input);
    const dictation = readVoiceSpeechSettingsSnapshot({ ...input, capturePurpose: 'dictation' });
    expect(dictation.isCurrent()).toBe(true);
    current = snapshot('it');
    expect(dictation.isCurrent()).toBe(false);
    expect(conversation.isCurrent()).toBe(true);
  });

  it('sends independent conversation, Dictation and engine-default language without writing provider settings', async () => {
    let current = snapshot('de');
    const bodies: string[] = [];
    let changeLanguageDuringRequest = false;
    // Only external HTTP and persisted Account snapshots are fixtures. The actual
    // plugin codec, admitted settings reader, RPC, upload and schemas stay real.
    const http: Pick<HttpService, 'request'> = { request: async (request) => {
      if (!(request.body instanceof Uint8Array)) throw new Error('expected actual multipart bytes');
      bodies.push(new TextDecoder().decode(request.body));
      if (changeLanguageDuringRequest) current = snapshot('it');
      return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ text: 'recognized' })) };
    } };
    const handlers = new RpcHandlerManager({ scopePrefix: 'speech-language-test', encryptionMode: 'plain', logger: () => {} });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: handlers,
      resolveSpeechRuntime: async () => ({
        runtime: OPENAI_COMPAT_STT_RUNTIME, contribution,
        readSettings: (capturePurpose?: 'dictation' | 'conversation') => ({
          ...readVoiceSpeechSettingsSnapshot({ providerId, contribution, readSnapshot: () => current, isRuntimeCurrent: () => true, capturePurpose }),
          resolveCredentials: () => ({ phase: 'speech', mediated: null, raw: null }),
        }),
        createHttp: () => http, isCurrent: () => true, retirementSignal: new AbortController().signal, release: async () => {},
      }),
    });
    const invoke = async (capturePurpose?: 'dictation' | 'conversation') => {
      const init = await handlers.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT, { target, sizeBytes: 3, mimeType: 'audio/wav', fileName: 'recording.wav' });
      const { DaemonVoiceSpeechTranscribeUploadInitResponseSchema } = await import('@happier-dev/protocol');
      const response = DaemonVoiceSpeechTranscribeUploadInitResponseSchema.parse(init);
      if (!response.success) throw new Error('upload was not admitted');
      const encrypted = createEncryptedTransferChunkEnvelope({ transferId: response.uploadId, sequence: 0, payload: Buffer.from([1, 2, 3]), recipientPublicKeyBase64: response.recipientPublicKeyBase64 });
      await expect(handlers.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK, { uploadId: response.uploadId, index: 0, ...encrypted })).resolves.toMatchObject({ success: true });
      await expect(handlers.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE, { uploadId: response.uploadId })).resolves.toMatchObject({ success: true });
      return handlers.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE, { target, requestId: 'language-request', uploadId: response.uploadId, mimeType: 'audio/wav', ...(capturePurpose ? { capturePurpose } : {}) });
    };
    try {
      await expect(invoke()).resolves.toEqual({ ok: true, requestId: 'language-request', text: 'recognized' });
      expect(bodies[0]).toContain('name="language"\r\n\r\nfr\r\n');
      await expect(invoke('dictation')).resolves.toEqual({ ok: true, requestId: 'language-request', text: 'recognized' });
      expect(bodies[1]).toContain('name="language"\r\n\r\nde\r\n');
      current = snapshot(null);
      await expect(invoke('dictation')).resolves.toMatchObject({ ok: true });
      expect(bodies[2]).not.toContain('name="language"');
      const root = current.settings.voiceSettingsV1;
      expect(root).toMatchObject({ assistantLanguage: 'es', providers: { [providerId]: { config: { language: 'fr' } } } });
      current = snapshot('de');
      changeLanguageDuringRequest = true;
      await expect(invoke('dictation')).resolves.toMatchObject({ ok: false, errorCode: 'provider_unavailable' });
    } finally { await registration.dispose(); }
  });
});
