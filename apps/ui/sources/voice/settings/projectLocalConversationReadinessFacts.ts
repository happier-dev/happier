import type { Settings } from '@/sync/domains/settings/settings';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import type {
  VoiceCredentialReadinessFact,
  VoiceReadinessFact,
  VoiceRoleReadiness,
  VoiceSettingsReadinessFact,
} from '@/voice/registry/readiness';
import { resolveVoiceRoleReadiness } from '@/voice/registry/readiness';
import { projectVoiceProviderSettings, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
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

export type LocalVoiceSpeechReadiness = Readonly<{
  hear: VoiceRoleReadiness | null;
  speak: VoiceRoleReadiness | null;
}>;

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
  connectedPurposes: ConnectedPurposeCatalogV1 | null;
  platform: VoiceReadinessPlatform;
  local: VoiceLocalProviderModeAvailability;
  localInput: ResolveVoiceProviderAvailabilityInput['local'];
  executionMachineId: string | null | undefined;
  executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
  voiceAgentEnabled: boolean;
  /** Existing configured-Agent/catalog availability; never a speech runtime fact. */
  voiceAgentRuntime?: VoiceReadinessFact;
  rawCredentialAuthorizationByContribution?: Readonly<Record<string, Readonly<{
    contribution: Readonly<{ pluginId: string; localId: string }>;
    machineId: string | null;
    realm: 'daemon';
    phase: 'speech';
    status: 'ready' | 'approval_required' | 'unknown';
  }>>>;
  resolveSavedSecret?: (ref: string) => SavedSecretReferenceResolution;
}>): Readonly<{
  settings: VoiceSettingsReadinessFact;
  serverFeature: VoiceReadinessFact;
  executionMachine: VoiceReadinessFact;
  runtime: VoiceReadinessFact;
  model: VoiceReadinessFact;
  endpoint: VoiceReadinessFact;
  credential: VoiceCredentialReadinessFact;
  daemonRouteReadiness: VoiceRoleReadiness | null;
  speechReadiness: LocalVoiceSpeechReadiness;
  thinkReadiness: VoiceRoleReadiness;
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
  ] as const;
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
      settings: {
        voiceSettingsV1: input.voiceSettingsV1,
        secrets: input.secrets,
      },
      connectedPurposes: input.connectedPurposes,
      executionMachineId: input.executionMachineId,
      providerEnvelope: input.voice.providers[stt.provider] ?? null,
      rawAuthorization: input.rawCredentialAuthorizationByContribution?.[stt.provider] ?? null,
      resolveSavedSecret: input.resolveSavedSecret,
    }),
    projectVoiceSpeechCredentialReadiness({
      registry: input.registry,
      role: 'conversation_tts',
      providerId: tts.provider,
      settings: {
        voiceSettingsV1: input.voiceSettingsV1,
        secrets: input.secrets,
      },
      connectedPurposes: input.connectedPurposes,
      executionMachineId: input.executionMachineId,
      providerEnvelope: input.voice.providers[tts.provider] ?? null,
      rawAuthorization: input.rawCredentialAuthorizationByContribution?.[tts.provider] ?? null,
      resolveSavedSecret: input.resolveSavedSecret,
    }),
  ] as const;
  const credential: VoiceCredentialReadinessFact = credentialFacts.includes('missing')
    ? 'missing'
    : credentialFacts.includes('approval_required')
      ? 'approval_required'
    : credentialFacts.includes('unknown')
      ? 'unknown'
      : 'ready';
  const serverFeature: VoiceReadinessFact = local.config.conversationMode !== 'agent'
    || input.voiceAgentEnabled
    ? 'ready'
    : 'missing';
  const adapterEntry = input.registry.get(local.adapterId);
  const adapterSettings = adapterEntry
    ? projectVoiceProviderSettings(adapterEntry, input.voice.providers[local.adapterId] ?? null)
    : null;
  const needsAgent = local.config.conversationMode === 'agent';
  const thinkSettings: VoiceSettingsReadinessFact = adapterSettings?.status !== 'ready'
    ? adapterSettings?.status ?? 'unknown'
    : needsAgent && local.config.agent.agentSource === 'agent' && !local.config.agent.agentId.trim()
      ? 'missing_required_setting'
      : 'ready';
  const agentRuntime = input.voiceAgentRuntime ?? 'unknown';
  const thinkReadiness = resolveVoiceRoleReadiness({
    registry: input.registry,
    role: 'conversation_stt',
    providerId: local.adapterId,
    platform: input.platform,
    settingsRequirements: needsAgent ? ['server_feature', 'execution_machine', 'runtime'] : [],
    facts: {
      settings: thinkSettings,
      serverFeature,
      executionMachine: input.executionMachineSelectionKind === 'selected_unreachable'
        ? 'incompatible' : input.executionMachineId ? 'ready' : 'missing',
      runtime: agentRuntime,
    },
  });
  const projectSpeechReadiness = (
    role: 'conversation_stt' | 'conversation_tts',
    providerId: string,
    roleEndpoint: VoiceReadinessFact,
    roleCredential: VoiceCredentialReadinessFact,
  ) => {
    const entry = input.registry.get(providerId);
    const settings = entry
      ? projectVoiceProviderSettings(entry, input.voice.providers[providerId] ?? null)
      : null;
    const settingsStatus: VoiceSettingsReadinessFact = adapterSettings?.status !== 'ready'
      ? adapterSettings?.status ?? 'unknown'
      : settings?.status ?? (entry?.projectSettings ? 'unknown' : 'ready');
    const readiness = resolveVoiceRoleReadiness({
      registry: input.registry,
      role,
      providerId,
      platform: input.platform,
      localAvailability: input.localInput,
      modeId: settings?.modeId,
      settingsRequirements: settings?.requirements,
      facts: {
        settings: settingsStatus,
        executionMachine: input.executionMachineSelectionKind === 'selected_unreachable'
          ? 'incompatible'
          : input.executionMachineId ? 'ready' : 'missing',
        endpoint: roleEndpoint,
        credential: roleCredential,
        // The available neural model/runtime check combines selected packs.
        // It cannot attribute a partial failure to either speech role.
      },
    });
    return { settings: settingsStatus, readiness: readiness.code.endsWith('_unknown') ? null : readiness };
  };
  const hear = projectSpeechReadiness('conversation_stt', stt.provider, endpointFacts[0], credentialFacts[0]);
  const speak = projectSpeechReadiness('conversation_tts', tts.provider, endpointFacts[1], credentialFacts[1]);
  // Preserve the aggregate's exact endpoint repair before a leaf's generic
  // missing-setting result. Other required leaf settings still block readiness.
  const speechSettings = endpoint === 'missing' && adapterSettings?.status === 'ready'
    ? 'ready'
    : [hear.settings, speak.settings].find((fact) => fact !== 'ready') ?? 'ready';
  const settings = thinkSettings !== 'ready' ? thinkSettings : speechSettings;
  const speechReadiness: LocalVoiceSpeechReadiness = {
    hear: hear.readiness,
    speak: speak.readiness,
  };

  if (input.voice.providerId !== 'local_conversation') {
    return {
      settings,
      serverFeature,
      executionMachine: input.executionMachineId != null ? 'ready' : 'missing',
      runtime: projectUnselectedRuntimeFact(input.local),
      model: 'ready',
      endpoint: 'ready',
      credential,
      daemonRouteReadiness: null,
      speechReadiness,
      thinkReadiness,
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
  const executionMachine: VoiceReadinessFact = needsAgent && input.executionMachineSelectionKind === 'selected_unreachable'
    ? 'incompatible' : requiresDaemon
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
    settings,
    serverFeature,
    executionMachine,
    runtime: needsAgent && agentRuntime !== 'ready' ? agentRuntime : runtime,
    model,
    endpoint,
    credential,
    daemonRouteReadiness,
    speechReadiness,
    thinkReadiness,
  };
}
