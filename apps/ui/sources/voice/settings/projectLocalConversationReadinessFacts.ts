import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveOpenAiCompatEndpointConsent } from '@/voice/local/openaiCompat/endpoint';
import type { VoiceReadinessFact } from '@/voice/registry/readiness';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';

import type {
  ResolveVoiceProviderAvailabilityInput,
  VoiceLocalProviderModeAvailability,
} from './resolveVoiceProviderAvailability';

type VoiceReadinessPlatform = 'web' | 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown';

function projectPathFact(
  path: VoiceLocalProviderModeAvailability['paths'][keyof VoiceLocalProviderModeAvailability['paths']],
): VoiceReadinessFact {
  if (path.runnable) return 'ready';
  if (path.readiness === 'installing') return 'installing';
  if (path.readiness === 'installable') return 'missing';
  if (path.readiness === 'unknown') return 'unknown';
  if (path.readiness === 'error') return 'incompatible';
  return 'missing';
}

function projectOpenAiCompatEndpointFact(
  config: Readonly<{
    baseUrl: string | null;
    insecureLocalOriginConsent: string | null;
    insecureLocalConsentMachineId: string | null;
  }>,
  executionMachineId: string | null | undefined,
): VoiceReadinessFact {
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  if (!baseUrl) return 'missing';
  try {
    const endpoint = resolveOpenAiCompatEndpointConsent(
      baseUrl,
      config.insecureLocalOriginConsent,
      config.insecureLocalConsentMachineId,
      executionMachineId ?? null,
    );
    return endpoint.requiresInsecureConsent
      && endpoint.insecureLocalOriginConsent === null
      ? 'missing'
      : 'ready';
  } catch {
    return 'incompatible';
  }
}

function projectUnselectedRuntimeFact(
  local: VoiceLocalProviderModeAvailability,
  input: ResolveVoiceProviderAvailabilityInput['local'],
): VoiceReadinessFact {
  if (input?.daemon?.runtimeState === 'available') return 'ready';
  if (local.runnable) return 'ready';
  if (Object.values(local.paths).some((path) => path.readiness === 'installing')) return 'installing';
  if (local.enabled) return 'missing';
  if (Object.values(local.paths).some((path) => path.readiness === 'unknown')) return 'unknown';
  return 'incompatible';
}

export function projectLocalConversationReadinessFacts(input: Readonly<{
  voice: VoiceSettings;
  platform: VoiceReadinessPlatform;
  local: VoiceLocalProviderModeAvailability;
  localInput: ResolveVoiceProviderAvailabilityInput['local'];
  executionMachineId: string | null | undefined;
}>): Readonly<{
  runtime: VoiceReadinessFact;
  model: VoiceReadinessFact;
  endpoint: VoiceReadinessFact;
}> {
  if (input.voice.providerId !== 'local_conversation') {
    return {
      runtime: projectUnselectedRuntimeFact(input.local, input.localInput),
      model: 'ready',
      endpoint: 'ready',
    };
  }

  const local = resolveLocalVoiceAdapterSettings({ voice: input.voice });
  const stt = parseLocalVoiceSttSettings(local.config.stt);
  const tts = parseLocalVoiceTtsSettings(local.config.tts);
  const selectedExecutions = [
    stt.provider === 'local_neural' ? stt.localNeural.execution : null,
    tts.provider === 'local_neural' ? tts.localNeural.execution : null,
  ].filter((execution): execution is NonNullable<typeof execution> => execution !== null);
  const requiresDaemon = selectedExecutions.some((execution) => (
    resolveLocalNeuralExecutionPolicy({
      requestedExecution: execution,
      platformOs: input.platform,
    }).preferredExecution === 'daemon'
  ));

  let runtime: VoiceReadinessFact;
  if (requiresDaemon) {
    runtime = input.localInput?.daemon?.runtimeState === 'available'
      ? 'ready'
      : input.localInput?.daemon?.runtimeState === 'unavailable'
        ? 'missing'
        : 'unknown';
  } else if (stt.provider === 'device') {
    runtime = projectPathFact(
      input.platform === 'web'
        ? input.local.paths.browserSpeech
        : input.local.paths.nativeDevice,
    );
  } else {
    runtime = projectUnselectedRuntimeFact(input.local, input.localInput);
  }

  let model: VoiceReadinessFact = 'ready';
  if (selectedExecutions.length > 0) {
    model = !requiresDaemon
      ? 'unknown'
      : input.localInput?.daemon?.modelState === 'ready'
        ? 'ready'
        : input.localInput?.daemon?.modelState === 'missing'
          ? 'missing'
          : input.localInput?.daemon?.modelState === 'installing'
            ? 'installing'
            : input.localInput?.daemon?.modelState === 'error'
              ? 'incompatible'
              : 'unknown';
  }

  let endpoint: VoiceReadinessFact = 'ready';
  const selectedEndpoints = [
    stt.provider === 'openai_compat' ? stt.openaiCompat : null,
    tts.provider === 'openai_compat' ? tts.openaiCompat : null,
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  for (const selectedEndpoint of selectedEndpoints) {
    endpoint = projectOpenAiCompatEndpointFact(selectedEndpoint, input.executionMachineId);
    if (endpoint !== 'ready') break;
  }

  return { runtime, model, endpoint };
}
