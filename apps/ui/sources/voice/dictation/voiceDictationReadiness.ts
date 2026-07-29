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
}>): VoiceRoleReadiness {
  const runtimeSettings = createVoiceDictationRuntimeSettingsSnapshot(input.settings);
  const providerId = resolveLocalSttProvider(runtimeSettings);
  return resolveVoiceRoleReadiness({
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
}
