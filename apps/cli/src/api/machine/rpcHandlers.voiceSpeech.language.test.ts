import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/openai-compat/src/manifest';
import { registerMachineVoiceSpeechRpcHandlers } from './rpcHandlers.voiceSpeech';
import { readVoiceSpeechSettingsSnapshot } from './voiceSpeechSettings';

const target = { pluginId: PLUGIN_MANIFEST.id, localId: 'stt' };
const providerId = `${target.pluginId}/${target.localId}`;
const declaration = VoiceProviderContributionSchema.parse((PLUGIN_MANIFEST.contributes.voiceProviders ?? []).find((value) => value.id === target.localId));
if (declaration.kind !== 'speech') throw new Error('expected actual speech contribution');
const contribution = declaration;

function snapshot(language: string | null, settingsVersion = 1): ActiveAccountSettingsSnapshot {
  return { source: 'network', scopeKey: 'language-account', settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [],
    connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } },
    settings: accountSettingsParse({ voiceSettingsV1: {
    assistantLanguage: 'es', dictation: { language },
    providers: { [providerId]: { schemaVersion: contribution.settings.schemaVersion, config: Object.fromEntries(contribution.settings.fields.map((field) => [field.id, field.id === 'language' ? 'fr' : field.id === 'baseUrl' ? 'https://93.184.216.34/v1' : field.default])) } },
  } }) };
}

describe('registered speech recognition language at the real daemon/plugin boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearActiveAccountSettingsSnapshot();
  });

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
    const publishLanguage = (language: string | null) => {
      current = snapshot(language, current.settingsVersion + 1);
      setActiveAccountSettingsSnapshot(current);
    };
    setActiveAccountSettingsSnapshot(current);
    // Only the DNS/socket and Account inputs are fixtures; source admission,
    // the first-party module, codec, HTTP policy, RPC and upload stay real.
    const openPinnedStream: PinnedHttpStreamTransport = async (request) => {
      if (!(request.body instanceof Uint8Array)) throw new Error('expected actual multipart bytes');
      bodies.push(new TextDecoder().decode(request.body));
      if (changeLanguageDuringRequest) publishLanguage('it');
      let body: Uint8Array | null = new TextEncoder().encode(JSON.stringify({ text: 'recognized' }));
      return { status: 200, headers: { 'content-type': 'application/json' }, contentLength: body.byteLength,
        async read() { const next = body; body = null; return next; }, cancel() { body = null; } };
    };
    const fixture = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: [target.pluginId], networkDependencies: {
        resolveNetworkAddresses: async () => ['93.184.216.34'], openPinnedStream,
      } },
    });
    const handlers = new RpcHandlerManager({ scopePrefix: 'speech-language-test', encryptionMode: 'plain', logger: () => {} });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: handlers,
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
      publishLanguage(null);
      await expect(invoke('dictation')).resolves.toMatchObject({ ok: true });
      expect(bodies[2]).not.toContain('name="language"');
      const root = current.settings.voiceSettingsV1;
      expect(root).toMatchObject({ assistantLanguage: 'es', providers: { [providerId]: { config: { language: 'fr' } } } });
      publishLanguage('de');
      changeLanguageDuringRequest = true;
      await expect(invoke('dictation')).resolves.toMatchObject({ ok: false, errorCode: 'provider_unavailable' });
    } finally {
      await registration.dispose();
      await fixture.dispose();
    }
  });
});
