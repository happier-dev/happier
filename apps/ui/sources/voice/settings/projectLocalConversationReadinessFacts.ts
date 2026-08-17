import type { Settings } from '@/sync/domains/settings/settings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import type { VoiceReadinessFact, VoiceRoleReadiness } from '@/voice/registry/readiness';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectVoiceSpeechCredentialReadiness } from '@/voice/registry/speechCredentialReadiness';
import { projectVoiceSpeechEndpointReadiness } from '@/voice/registry/speechEndpointReadiness';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';

import {
  resolveVoiceDeviceSpeechRolePath,
  type ResolveVoiceProviderAvailabilityInput,
  type VoiceLocalProviderModeAvailability,
} from './resolveVoiceProviderAvailability';
import {
  projectVoiceDaemonExecutionMachineReadinessFact,
  projectVoiceDaemonModelReadinessFact,
  projectVoiceDaemonRuntimeReadinessFact,
  resolveVoiceDaemonHeavyAudioReadiness,
} from './voiceProviderLocalAvailability';

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

function projectUnselectedRuntimeFact(
  local: VoiceLocalProviderModeAvailability,
): VoiceReadinessFact {
  if (local.runnable) return 'ready';
  if (Object.values(local.paths).some((path) => path.readiness === 'installing')) return 'installing';
  if (local.enabled) return 'missing';
  if (Object.values(local.paths).some((path) => path.readiness === 'unknown')) return 'unknown';
  return 'incompatible';
}

export function projectLocalConversationReadinessFacts(input: Readonly<{
  registry: VoiceProviderRegistry;
  voice: VoiceSettings;
  voiceSettingsV1: Settings['voiceSettingsV1'];
  secrets: Settings['secrets'];
  platform: VoiceReadinessPlatform;
  local: VoiceLocalProviderModeAvailability;
  localInput: ResolveVoiceProviderAvailabilityInput['local'];
  executionMachineId: string | null | undefined;
  executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
  voiceAgentEnabled: boolean;
}>): Readonly<{
  serverFeature: VoiceReadinessFact;
  executionMachine: VoiceReadinessFact;
  runtime: VoiceReadinessFact;
  model: VoiceReadinessFact;
  endpoint: VoiceReadinessFact;
  credential: VoiceReadinessFact;
  daemonRouteReadiness: VoiceRoleReadiness | null;
}> {
  const local = resolveLocalVoiceAdapterSettings({ voice: input.voice });
  const stt = parseLocalVoiceSttSettings(local.config.stt);
  const tts = parseLocalVoiceTtsSettings(local.config.tts);
  const endpointFacts = [
    projectVoiceSpeechEndpointReadiness({
      registry: input.registry,
      role: 'conversation_stt',
      providerId: stt.provider,
      providerEnvelope: input.voice.providers[stt.provider] ?? null,
      executionMachineId: input.executionMachineId ?? null,
    }),
    projectVoiceSpeechEndpointReadiness({
      registry: input.registry,
      role: 'conversation_tts',
      providerId: tts.provider,
      providerEnvelope: input.voice.providers[tts.provider] ?? null,
      executionMachineId: input.executionMachineId ?? null,
    }),
  ];
  const endpoint: VoiceReadinessFact = endpointFacts.includes('missing')
    ? 'missing'
    : endpointFacts.includes('incompatible')
      ? 'incompatible'
      : endpointFacts.includes('unknown')
        ? 'unknown'
        : 'ready';
  const credentialFacts = [
    projectVoiceSpeechCredentialReadiness({
      registry: input.registry,
      role: 'conversation_stt',
      providerId: stt.provider,
      settings: { voiceSettingsV1: input.voiceSettingsV1, secrets: input.secrets },
      executionMachineId: input.executionMachineId,
      providerEnvelope: input.voice.providers[stt.provider] ?? null,
    }),
    projectVoiceSpeechCredentialReadiness({
      registry: input.registry,
      role: 'conversation_tts',
      providerId: tts.provider,
      settings: { voiceSettingsV1: input.voiceSettingsV1, secrets: input.secrets },
      executionMachineId: input.executionMachineId,
      providerEnvelope: input.voice.providers[tts.provider] ?? null,
    }),
  ];
  const credential: VoiceReadinessFact = credentialFacts.includes('missing')
    ? 'missing'
    : credentialFacts.includes('unknown')
      ? 'unknown'
      : 'ready';
  const serverFeature: VoiceReadinessFact = local.config.conversationMode !== 'agent'
    || input.voiceAgentEnabled
    ? 'ready'
    : 'missing';

  if (input.voice.providerId !== 'local_conversation') {
    return {
      serverFeature,
      executionMachine: input.executionMachineId != null ? 'ready' : 'missing',
      runtime: projectUnselectedRuntimeFact(input.local),
      model: 'ready',
      endpoint: 'ready',
      credential,
      daemonRouteReadiness: null,
    };
  }

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
  const executionMachine: VoiceReadinessFact = requiresDaemon
    ? input.executionMachineSelectionKind === 'selected_unreachable'
      ? 'incompatible'
      : projectVoiceDaemonExecutionMachineReadinessFact(
        input.localInput?.daemon,
        input.executionMachineId,
      )
    : input.executionMachineId != null ? 'ready' : 'missing';
  const daemonRouteReadiness = requiresDaemon
    ? resolveVoiceDaemonHeavyAudioReadiness({
        role: 'conversation_stt',
        providerId: 'local_conversation',
        daemon: input.localInput?.daemon,
        executionMachineId: input.executionMachineId,
        executionMachineSelectionKind: input.executionMachineSelectionKind,
      })
    : null;

  let runtime: VoiceReadinessFact;
  if (requiresDaemon) {
    runtime = projectVoiceDaemonRuntimeReadinessFact(input.localInput?.daemon);
  } else if (stt.provider === 'device') {
    const path = resolveVoiceDeviceSpeechRolePath({
      role: 'conversation_stt',
      platformOs: input.platform,
      local: input.localInput,
    });
    runtime = path ? projectPathFact(path) : 'unknown';
  } else {
    runtime = projectUnselectedRuntimeFact(input.local);
  }

  let model: VoiceReadinessFact = 'ready';
  if (selectedExecutions.length > 0) {
    model = !requiresDaemon
      ? 'unknown'
      : projectVoiceDaemonModelReadinessFact(input.localInput?.daemon);
  }

  return {
    serverFeature,
    executionMachine,
    runtime,
    model,
    endpoint,
    credential,
    daemonRouteReadiness,
  };
}
