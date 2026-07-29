import type {
  VoiceRuntimePlatform,
} from '@happier-dev/protocol';

import { resolveOpenAiCompatEndpointConsent } from '@/voice/local/openaiCompat/endpoint';
import {
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import {
  resolveVoiceRoleReadiness,
  type VoiceReadinessFact,
  type VoiceRoleReadiness,
} from '@/voice/registry/readiness';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import type {
  VoiceDaemonModelAvailability,
  VoiceDaemonRuntimeAvailability,
} from '@/voice/settings/resolveVoiceProviderAvailability';
import {
  resolveVoiceProviderAvailability,
} from '@/voice/settings/resolveVoiceProviderAvailability';
import type {
  VoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';

import {
  createVoiceDictationRuntimeSettingsSnapshot,
} from './voiceDictationRuntimeSettings';

type DictationDaemonFacts = Readonly<{
  modelState: VoiceDaemonModelAvailability;
  runtimeState?: VoiceDaemonRuntimeAvailability;
}> | null;

function projectRuntimeFact(daemon: DictationDaemonFacts): VoiceReadinessFact {
  if (daemon?.runtimeState === 'available') return 'ready';
  if (daemon?.runtimeState === 'unavailable') return 'missing';
  return 'unknown';
}

function projectModelFact(daemon: DictationDaemonFacts): VoiceReadinessFact {
  if (daemon?.modelState === 'ready') return 'ready';
  if (daemon?.modelState === 'missing') return 'missing';
  if (daemon?.modelState === 'installing') return 'installing';
  if (daemon?.modelState === 'error') return 'incompatible';
  return 'unknown';
}

function projectOpenAiEndpointFact(
  settings: any,
  executionMachineId: string | null,
): VoiceReadinessFact {
  const stt = resolveLocalVoiceAdapterSettings(settings).config.stt;
  const openAiCompat = stt?.openaiCompat;
  const baseUrl = typeof openAiCompat?.baseUrl === 'string'
    ? openAiCompat.baseUrl.trim()
    : '';
  if (!baseUrl) return 'missing';
  try {
    const endpoint = resolveOpenAiCompatEndpointConsent(
      baseUrl,
      openAiCompat.insecureLocalOriginConsent,
      openAiCompat.insecureLocalConsentMachineId,
      executionMachineId,
    );
    return endpoint.requiresInsecureConsent
      && endpoint.insecureLocalOriginConsent === null
      ? 'missing'
      : 'ready';
  } catch {
    return 'incompatible';
  }
}

function projectDeviceSttReadiness(input: Readonly<{
  platform: VoiceRuntimePlatform;
  localAvailability: VoiceProviderLocalAvailability;
}>): VoiceRoleReadiness | null {
  const local = resolveVoiceProviderAvailability({
    happierVoiceSupported: true,
    platformOs: input.platform,
    local: input.localAvailability,
  });
  const path = input.platform === 'web'
    ? local.local.paths.browserSpeech
    : local.local.paths.nativeDevice;
  if (path.runnable) return null;

  const code = path.readiness === 'unknown'
    ? 'device_stt_availability_unknown'
    : 'device_stt_unavailable';
  return Object.freeze({
    role: 'dictation_stt',
    providerId: 'device',
    status: 'unavailable',
    code,
    reasonKey: `voice.readiness.${code}`,
    recoveryAction: 'switch_provider',
  });
}

/**
 * Passive readiness projection. It reads only already-loaded settings,
 * machine, runtime, and model facts; it never opens a microphone, sends audio,
 * or starts a provider operation.
 */
export function resolveVoiceDictationReadiness(input: Readonly<{
  registry: VoiceProviderRegistry;
  settings: any;
  platform: VoiceRuntimePlatform | 'unknown';
  executionMachineId: string | null;
  daemon: DictationDaemonFacts;
  localAvailability: VoiceProviderLocalAvailability;
}>): VoiceRoleReadiness {
  const runtimeSettings = createVoiceDictationRuntimeSettingsSnapshot(input.settings);
  const providerId = resolveLocalSttProvider(runtimeSettings);
  const readiness = resolveVoiceRoleReadiness({
    registry: input.registry,
    role: 'dictation_stt',
    providerId,
    platform: input.platform,
    facts: {
      settings: 'ready',
      executionMachine: input.executionMachineId ? 'ready' : 'missing',
      endpoint: providerId === 'openai_compat'
        ? projectOpenAiEndpointFact(runtimeSettings, input.executionMachineId)
        : 'unknown',
      runtime: projectRuntimeFact(input.daemon),
      model: projectModelFact(input.daemon),
      // Credential stores intentionally do not expose secrets to this
      // projection. Providers that require one stay unknown until their
      // canonical credential owner reports a readiness fact.
      credential: 'unknown',
    },
  });
  if (providerId !== 'device' || readiness.status !== 'ready' || input.platform === 'unknown') {
    return readiness;
  }
  return projectDeviceSttReadiness({
    platform: input.platform,
    localAvailability: input.localAvailability,
  }) ?? readiness;
}
