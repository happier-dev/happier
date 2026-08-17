import type {
  VoiceProviderSettingsEnvelopeV1,
  VoiceRuntimePlatform,
} from '@happier-dev/protocol';

import {
  parseLocalVoiceSttSettings,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import {
  projectVoiceProviderRequirements,
  resolveVoiceRoleReadiness,
  type VoiceRoleReadiness,
} from '@/voice/registry/readiness';
import {
  projectVoiceProviderSettings,
  type VoiceProviderRegistry,
  type VoiceProviderRegistryEntry,
  type VoiceProviderSettingsProjection,
} from '@/voice/registry/providerRegistry';
import { projectVoiceSpeechCredentialReadiness } from '@/voice/registry/speechCredentialReadiness';
import { projectVoiceSpeechEndpointReadiness } from '@/voice/registry/speechEndpointReadiness';
import type {
  VoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';
import {
  projectVoiceDaemonModelReadinessFact,
  projectVoiceDaemonRuntimeReadinessFact,
  resolveVoiceDaemonHeavyAudioReadiness,
} from '@/voice/settings/voiceProviderLocalAvailability';
import {
  resolveLocalNeuralExecutionPolicy,
} from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';

import {
  createVoiceDictationRuntimeSettingsSnapshot,
} from './voiceDictationRuntimeSettings';

type VoiceDictationProviderProjection = Readonly<{
  providerId: string;
  providerEnvelope: VoiceProviderSettingsEnvelopeV1 | null;
  entry: VoiceProviderRegistryEntry | null;
  settingsProjection: VoiceProviderSettingsProjection | null;
  usesDaemonLocalNeural: boolean;
}>;

function projectVoiceDictationProvider(input: Readonly<{
  registry: VoiceProviderRegistry;
  settings: any;
  platform: VoiceRuntimePlatform | 'unknown';
}>): VoiceDictationProviderProjection {
  const runtimeSettings = createVoiceDictationRuntimeSettingsSnapshot(input.settings);
  const providerId = resolveLocalSttProvider(runtimeSettings);
  const localStt = parseLocalVoiceSttSettings(
    resolveLocalVoiceAdapterSettings(runtimeSettings).config.stt,
  );
  const providerEnvelope = runtimeSettings.voice.providers[providerId] ?? null;
  const entry = input.registry.get(providerId);
  const settingsProjection = entry
    ? projectVoiceProviderSettings(entry, providerEnvelope)
    : null;
  return Object.freeze({
    providerId,
    providerEnvelope,
    entry,
    settingsProjection,
    usesDaemonLocalNeural: providerId === 'local_neural'
      && resolveLocalNeuralExecutionPolicy({
        requestedExecution: localStt.localNeural.execution,
        platformOs: input.platform,
      }).preferredExecution === 'daemon',
  });
}

/**
 * Sole Dictation projection for whether its selected STT path needs the shared
 * execution-machine setting. Provider declarations own static requirements;
 * Local Neural adds the canonical device/daemon execution policy.
 */
export function resolveVoiceDictationExecutionMachineRequirement(input: Readonly<{
  registry: VoiceProviderRegistry;
  settings: any;
  platform: VoiceRuntimePlatform | 'unknown';
}>): boolean {
  const projection = projectVoiceDictationProvider(input);
  if (projection.usesDaemonLocalNeural) return true;
  if (!projection.entry) return false;
  if (projection.settingsProjection !== null && projection.settingsProjection.status !== 'ready') return false;
  return projectVoiceProviderRequirements(
    projection.entry,
    projection.settingsProjection?.modeId ?? null,
  )?.includes('execution_machine') === true;
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
  executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
  localAvailability: VoiceProviderLocalAvailability;
}>): VoiceRoleReadiness {
  const projection = projectVoiceDictationProvider(input);
  const { providerId, providerEnvelope, settingsProjection } = projection;
  const daemonPrerequisiteReadiness = projection.usesDaemonLocalNeural
    ? resolveVoiceDaemonHeavyAudioReadiness({
        role: 'dictation_stt',
        providerId,
        daemon: input.localAvailability.daemon,
        executionMachineId: input.executionMachineId,
        executionMachineSelectionKind: input.executionMachineSelectionKind,
      })
    : null;
  if (
    daemonPrerequisiteReadiness?.code === 'server_feature_disabled'
    || daemonPrerequisiteReadiness?.code === 'execution_machine_missing'
    || daemonPrerequisiteReadiness?.code === 'execution_machine_incompatible'
  ) {
    return daemonPrerequisiteReadiness;
  }
  const readiness = resolveVoiceRoleReadiness({
    registry: input.registry,
    role: 'dictation_stt',
    providerId,
    platform: input.platform,
    modeId: settingsProjection?.modeId ?? null,
    localAvailability: input.localAvailability,
    facts: {
      settings: settingsProjection?.status ?? 'ready',
      executionMachine: input.executionMachineSelectionKind === 'selected_unreachable'
        ? 'incompatible'
        : input.executionMachineId ? 'ready' : 'missing',
      endpoint: projectVoiceSpeechEndpointReadiness({
        registry: input.registry,
        role: 'dictation_stt',
        providerId,
        providerEnvelope,
        executionMachineId: input.executionMachineId,
      }),
      runtime: projection.usesDaemonLocalNeural
        ? projectVoiceDaemonRuntimeReadinessFact(input.localAvailability.daemon)
        : 'ready',
      model: projection.usesDaemonLocalNeural
        ? projectVoiceDaemonModelReadinessFact(input.localAvailability.daemon)
        // Native Local Neural installation is currently component-local. Do
        // not reinterpret daemon catalog facts as native state or claim ready
        // until that owner exposes a passive shared projection.
        : providerId === 'local_neural'
          ? 'unknown'
          : 'ready',
      credential: projectVoiceSpeechCredentialReadiness({
        registry: input.registry,
        role: 'dictation_stt',
        providerId,
        settings: {
          voiceSettingsV1: input.settings.voiceSettingsV1,
          secrets: Array.isArray(input.settings?.secrets) ? input.settings.secrets : [],
        },
        executionMachineId: input.executionMachineId,
        providerEnvelope,
      }),
    },
  });
  if (readiness.status === 'ready' && daemonPrerequisiteReadiness) {
    return daemonPrerequisiteReadiness;
  }
  return readiness;
}
