import { describe, expect, it } from 'vitest';
import { createVoiceSettingsOwner } from './voiceSettings.js';
import { applyVoiceDictationEngineChoice } from './providerSelection.js';
import type { VoiceSettingsRegistryEntry } from './providerRegistry.js';
import { createVoiceSettingBindingsV1 } from './voiceSettingBindings.js';

const owner = createVoiceSettingsOwner({ bundledContributions: [] });
const neural = { providerId: 'local_neural', kind: 'voice.speech-engine.v1', roles: ['dictation_stt'] } as const satisfies VoiceSettingsRegistryEntry;
const registry = { get: (id: string) => id === neural.providerId ? neural : null, list: () => [neural] };
const june = 'sherpa-onnx-streaming-zipformer-en-2023-06-26';
const parakeet = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

describe('Voice scalar model preference writes', () => {
  it('clears only the deliberately replaced exact role selection and retains unrelated preferences', () => {
    const { voiceLocalConversationBinding } = createVoiceSettingBindingsV1({ owner, registry, unavailableValue: null });
    const selected = { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 1,
      deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'shared' } as const;
    const voice = owner.voiceSettingsParse({ providers: { local_conversation: { schemaVersion: 1, config: { agent: {
      chatModelSelection: selected, commitModelSelection: selected,
      providerChat: { status: 'configured', chat: { agentTargetKey: selected.agentTargetKey, providerConnectionId: null, modelId: 'old' },
        commit: { agentTargetKey: selected.agentTargetKey, providerConnectionId: null, modelId: 'old' } },
    } } } } });
    const unchanged = voiceLocalConversationBinding('agent.idleTtlSeconds').mutate({ voice }, 30)!;
    expect(owner.readLocalConversationVoiceSettings(unchanged.voice).agent.chatModelSelection).toEqual(selected);
    expect(owner.readLocalConversationVoiceSettings(unchanged.voice).agent.providerChat?.status).toBe('configured');
    for (const role of ['chat', 'commit'] as const) {
      const changed = voiceLocalConversationBinding(`agent.${role}ModelId`).mutate({ voice }, 'new-model')!;
      const agent = owner.readLocalConversationVoiceSettings(changed.voice).agent;
      expect(agent[`${role}ModelSelection`]).toBeNull();
      expect(agent[role === 'chat' ? 'commitModelSelection' : 'chatModelSelection']).toEqual(selected);
      expect(agent.providerChat).toBeNull();
      expect(agent[`${role}ModelId`]).toBe('new-model');
    }
  });
});

describe('Dictation neural model selection (owner decision 2026-11-09)', () => {
  it.each(['daemon', 'device'] as const)('uses the host execution policy through the %s settings Action', execution => {
    const { voiceSettingBinding } = createVoiceSettingBindingsV1({ owner, registry, unavailableValue: null,
      resolveDictationNeuralExecution: () => execution });
    const next = voiceSettingBinding('dictation.stt.provider').mutate({ voice: owner.voiceSettingsParse({}) }, 'local_neural');
    expect(next?.voice.dictation.stt.localNeural.assetId).toBe(execution === 'daemon' ? parakeet : june);
  });
  it.each(['daemon', 'device'] as const)('selects the %s model once at the engine choice and retains it after persistence', execution => {
    const before = owner.voiceSettingsParse({});
    const next = applyVoiceDictationEngineChoice(before, registry, 'local_neural', execution)!;
    expect(next.dictation.stt.localNeural.assetId).toBe(execution === 'daemon' ? parakeet : june);
    expect(owner.voiceSettingsParse(JSON.parse(JSON.stringify(next))).dictation.stt).toEqual(next.dictation.stt);
    expect(next.providers).toEqual(before.providers);
    expect(owner.readLocalConversationVoiceSettings(next).stt.localNeural.assetId).toBe(june);
    expect(before.dictation.stt.provider).toBe('device');
  });

  it.each([undefined, null, june])('keeps an existing June installation usable when its unchosen persisted model is %s', assetId => {
    const before = owner.voiceSettingsParse({ dictation: { stt: {
      provider: 'local_neural', localNeural: { execution: 'daemon', assetId },
    } } });
    expect(before.dictation.stt.localNeural.assetId).toBe(june);
    const next = applyVoiceDictationEngineChoice(before, registry, 'local_neural', 'daemon')!;
    expect(next.dictation.stt.localNeural.assetId).toBe(june);
  });

  it('preserves a deliberate smaller model and the same-as-Conversations binding', () => {
    const assetId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
    const before = owner.voiceSettingsParse({ dictation: { stt: { provider: 'device', localNeural: { assetId } } } });
    expect(applyVoiceDictationEngineChoice(before, registry, 'local_neural', 'daemon')?.dictation.stt.localNeural.assetId).toBe(assetId);
    expect(applyVoiceDictationEngineChoice(before, registry, 'same_as_local', 'daemon')?.dictation).toEqual({ ...before.dictation, sttBinding: 'same_as_local' });
  });
});
