import { describe, expect, it } from 'vitest';

import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
  saveAndUseAccountVoiceCredential,
  upsertAccountVoiceCredential,
} from '@/voice/credentials/accountVoiceCredential';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import {
  resolveVoiceProviderAvailability,
  type ResolveVoiceProviderAvailabilityInput,
} from './resolveVoiceProviderAvailability';
import { projectLocalConversationReadinessFacts } from './projectLocalConversationReadinessFacts';

const registry = createDefaultVoiceProviderRegistry();
const executionMachineId = 'machine-a';
const localInput = {
  browserSpeech: { support: 'cloud_only' as const, onDevice: 'unsupported' as const },
  daemon: {
    featureEnabled: true,
    route: 'direct' as const,
    modelState: 'ready' as const,
    runtimeState: 'available' as const,
    pcmCapture: 'available' as const,
  },
  nativeDevice: { requested: false },
};
const local = resolveVoiceProviderAvailability({
  happierVoiceSupported: true,
  platformOs: 'web',
  local: localInput,
}).local;

function createLocalSettings(sttProvider: string, ttsProvider: string): Settings {
  const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  const voice = writeLocalConversationVoiceSettings(
    {
      ...voiceSettingsDefaults,
      providerId: 'local_conversation',
    },
    {
      ...defaults,
      stt: { ...defaults.stt, provider: sttProvider },
      tts: { ...defaults.tts, provider: ttsProvider },
    },
  );
  return settingsParse({ voice });
}

function addCredential(
  settings: Settings,
  providerId: string,
  credentialSlotId: string,
  machineId: string | null = executionMachineId,
): Settings {
  const contribution = providerId === 'happier.voice.google/gemini-stt'
    ? { pluginId: 'happier.voice.google', localId: 'gemini-stt' }
    : providerId === 'happier.voice.google/google-cloud-tts'
      ? { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' }
      : { pluginId: 'happier.voice.openai-compat', localId: 'stt' };
  const entry = registry.get(providerId);
  if (entry?.kind !== 'voice.speech-engine.v1' || entry.declaration?.kind !== 'speech') {
    throw new Error(`Expected speech fixture ${providerId}`);
  }
  return saveAndUseAccountVoiceCredential({
    settings,
    contribution,
    credentialSlotId: 'api_key',
    expectedSettingsVersion: 0,
    currentDeclaration: entry.declaration,
    machineId,
    value: `${providerId}-${credentialSlotId}`,
    generateId: () => `${providerId}-${credentialSlotId}-${machineId ?? 'account'}`,
    now: 1,
    expectedSecretId: null,
    expectedSecretUpdatedAt: null,
  }).settings;
}

function project(settings: Settings) {
  return projectLocalConversationReadinessFacts({
    registry,
    voice: settings.voice,
    voiceSettingsV1: settings.voiceSettingsV1,
    secrets: settings.secrets,
    connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
    platform: 'web',
    local,
    localInput,
    executionMachineId,
    voiceAgentEnabled: true,
    rawCredentialAuthorizationByContribution: Object.fromEntries(([
      ['happier.voice.google/gemini-stt', { pluginId: 'happier.voice.google', localId: 'gemini-stt' }],
      ['happier.voice.google/google-cloud-tts', { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' }],
      ['happier.voice.openai-compat/stt', { pluginId: 'happier.voice.openai-compat', localId: 'stt' }],
    ] as const).map(([providerId, contribution]) => [providerId, {
      contribution,
      machineId: executionMachineId,
      realm: 'daemon' as const,
      phase: 'speech' as const,
      status: 'ready' as const,
    }])),
  });
}

describe('projectLocalConversationReadinessFacts credential readiness', () => {
  it('requires voice.agent only for Agent-backed Local Voice', () => {
    const direct = createLocalSettings('device', 'device');
    expect(projectLocalConversationReadinessFacts({
      registry,
      voice: direct.voice,
      voiceSettingsV1: direct.voiceSettingsV1,
      connectedAccountPurposeBindingsV1: direct.connectedAccountPurposeBindingsV1,
      secrets: direct.secrets,
      platform: 'web',
      local,
      localInput,
      executionMachineId,
      voiceAgentEnabled: false,
    }).serverFeature).toBe('ready');

    const current = readLocalConversationVoiceSettings(direct.voice);
    const agentVoice = writeLocalConversationVoiceSettings(direct.voice, {
      ...current,
      conversationMode: 'agent',
    });
    expect(projectLocalConversationReadinessFacts({
      registry,
      voice: agentVoice,
      voiceSettingsV1: direct.voiceSettingsV1,
      connectedAccountPurposeBindingsV1: direct.connectedAccountPurposeBindingsV1,
      secrets: direct.secrets,
      platform: 'web',
      local,
      localInput,
      executionMachineId,
      voiceAgentEnabled: false,
    }).serverFeature).toBe('missing');
  });

  it('requires every selected credentialed STT/TTS leaf and accepts selected-machine credentials', () => {
    const missing = createLocalSettings('happier.voice.google/gemini-stt', 'happier.voice.google/google-cloud-tts');
    expect(project(missing).credential).toBe('missing');

    const sttReady = addCredential(missing, 'happier.voice.google/gemini-stt', 'api_key');
    expect(project(sttReady).credential).toBe('missing');

    const bothReady = addCredential(sttReady, 'happier.voice.google/google-cloud-tts', 'api_key');
    expect(project(bothReady).credential).toBe('ready');
  });

  it('keeps an unselected optional credential ready and validates it once selected', () => {
    const missing = createLocalSettings('happier.voice.openai-compat/stt', 'device');
    expect(project(missing).credential).toBe('ready');

    const ready = addCredential(missing, 'happier.voice.openai-compat/stt', 'api_key');
    expect(project(ready).credential).toBe('ready');

    const rotated = upsertAccountVoiceCredential({
      settings: ready,
      contribution: { pluginId: 'happier.voice.openai-compat', localId: 'stt' },
      credentialSlotId: 'api_key',
      machineId: executionMachineId,
      value: 'rotated-openai-key',
      generateId: () => 'openai-rotated-machine-key',
      now: 2,
      expectedSecretId: 'happier.voice.openai-compat/stt-api_key-machine-a',
      expectedSecretUpdatedAt: 1,
    }).settings;
    expect(project(rotated).credential).toBe('ready');
    expect(project(settingsParse({
      ...rotated,
      secrets: ready.secrets,
    })).credential).toBe('missing');

    const removed = settingsParse({
      ...rotated,
      secrets: [],
    });
    expect(project(removed).credential).toBe('missing');
  });

  it('keeps Device and local inference credential-neutral', () => {
    expect(project(createLocalSettings('device', 'local_neural')).credential).toBe('ready');
  });

  it('applies heavy-audio route readiness only when the selected Local Voice leaves require daemon execution', () => {
    const relayDisabledInput = {
      ...localInput,
      daemon: {
        ...localInput.daemon,
        route: 'relay_disabled' as const,
      },
    };
    const relayDisabledLocal = resolveVoiceProviderAvailability({
      happierVoiceSupported: true,
      platformOs: 'web',
      local: relayDisabledInput,
    }).local;
    const projectWithRelayDisabled = (settings: Settings) => (
      projectLocalConversationReadinessFacts({
        registry,
        voice: settings.voice,
        voiceSettingsV1: settings.voiceSettingsV1,
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        secrets: settings.secrets,
        platform: 'web',
        local: relayDisabledLocal,
        localInput: relayDisabledInput,
        executionMachineId,
        voiceAgentEnabled: true,
      })
    );

    expect(projectWithRelayDisabled(
      createLocalSettings('local_neural', 'device'),
    ).daemonRouteReadiness).toMatchObject({
      status: 'unavailable',
      code: 'daemon_relay_disabled',
    });
    expect(projectWithRelayDisabled(
      createLocalSettings('device', 'device'),
    ).daemonRouteReadiness).toBeNull();
  });

  it('prioritizes exact daemon prerequisites over unknown model and runtime catalog facts', () => {
    const settings = createLocalSettings('local_neural', 'device');
    const projectDaemon = (
      daemon: NonNullable<NonNullable<ResolveVoiceProviderAvailabilityInput['local']>['daemon']>,
      machineId: string | null,
    ) => {
      const input = { ...localInput, daemon };
      return projectLocalConversationReadinessFacts({
        registry,
        voice: settings.voice,
        voiceSettingsV1: settings.voiceSettingsV1,
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        secrets: settings.secrets,
        platform: 'web',
        local: resolveVoiceProviderAvailability({
          happierVoiceSupported: true,
          platformOs: 'web',
          local: input,
        }).local,
        localInput: input,
        executionMachineId: machineId,
        voiceAgentEnabled: true,
      }).daemonRouteReadiness;
    };

    expect(projectDaemon({
      ...localInput.daemon,
      modelState: 'unknown',
      runtimeState: 'unknown',
    }, null)).toMatchObject({
      status: 'needs_setup',
      code: 'execution_machine_missing',
      recoveryAction: 'select_execution_machine',
    });
    expect(projectDaemon({
      ...localInput.daemon,
      featureEnabled: false,
      modelState: 'unknown',
      runtimeState: 'unknown',
    }, executionMachineId)).toMatchObject({
      status: 'unavailable',
      code: 'server_feature_disabled',
      recoveryAction: 'switch_provider',
    });
  });
});
