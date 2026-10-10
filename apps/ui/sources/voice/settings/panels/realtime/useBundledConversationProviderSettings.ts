import * as React from 'react';

import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceProviderSettingsConfig, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createBundledConversationUi } from '@/voice/credentials/bundledConversationClient';
import { BundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION, BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, type SessionVoiceDeclarationV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { VoiceProviderSettingsJsonValueV1Schema, type VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol/voice/realtime/providerSettings';
import { readLocalNeuralVoiceCatalog } from '@/voice/kokoro/assets/readLocalNeuralVoiceCatalog';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import { storage } from '@/sync/domains/state/storage';
import type { VoiceCatalogClient } from './voiceCatalog';
import type { VoiceCatalogPreviewSynthesizer } from './catalogPreview';
import { previewLocalNeuralTts } from '@/voice/settings/panels/localTts/providers/localNeural/previewLocalNeuralTts';
import { t } from '@/text';
import {
  getExternalVoiceProviderRegistrationsRevision,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

import {
  parseRealtimeSettingsDescriptor,
  resolveRealtimeProviderConfig,
  type RealtimeProviderSettingsOwner,
  type RealtimeSettingsDescriptor,
  type ResolvedRealtimeProviderConfig,
} from './descriptor';

const registry = createDefaultVoiceProviderRegistry();
export type ConversationSessionVoiceChoice = Readonly<{
  providerId: string;
  declaration: SessionVoiceDeclarationV1 | null;
  config: VoiceProviderSettingsJsonValueV1;
  client: VoiceCatalogClient | null;
  targetKey: string;
  preview?: VoiceCatalogPreviewSynthesizer;
}>;

function createUiSafely(providerId: string) {
  try {
    return createBundledConversationUi(providerId);
  } catch {
    return null;
  }
}

/**
 * The account's selected bundled conversation provider as its settings surfaces read it: the bundled
 * UI (client, descriptor, settings owner) and the account's resolved provider config. One derivation
 * for Voice settings and a Session's Work voice picker.
 */
export function useBundledConversationProviderSettings(voice: VoiceSettings): Readonly<{
  providerId: string | null;
  bundledUi: ReturnType<typeof createBundledConversationUi>;
  descriptor: RealtimeSettingsDescriptor | null;
  owner: RealtimeProviderSettingsOwner | null;
  resolved: ResolvedRealtimeProviderConfig | null;
  config: Readonly<Record<string, unknown>> | null;
  sessionChoice: ConversationSessionVoiceChoice | null;
}> {
  const providerId = resolveVoiceProviderId(voice.providerId);
  const registrationsRevision = React.useSyncExternalStore(
    subscribeExternalVoiceProviderRegistrations,
    getExternalVoiceProviderRegistrationsRevision,
    getExternalVoiceProviderRegistrationsRevision,
  );
  const bundledUi = React.useMemo(
    () => providerId ? createUiSafely(providerId) : null,
    // The external registrations revision re-resolves a provider contributed after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providerId, registrationsRevision],
  );
  const descriptor = React.useMemo(
    () => providerId && bundledUi ? parseRealtimeSettingsDescriptor(providerId, bundledUi.settingsDescriptor) : null,
    [bundledUi, providerId],
  );
  const owner = React.useMemo<RealtimeProviderSettingsOwner | null>(() => bundledUi ? Object.freeze({
    ...bundledUi.settingsOwner,
    schemaVersion: bundledUi.settingsOwner.currentSchemaVersion,
  }) : null, [bundledUi]);
  const envelope = providerId ? voice.providers?.[providerId] ?? null : null;
  const resolved = React.useMemo(() => owner ? resolveRealtimeProviderConfig(owner, envelope) : null, [envelope, owner]);
  const config = resolved?.status === 'ready' ? resolved.config : null;
  const machineId = storage(state => resolveVoiceExecutionMachineIdFromState(state));
  const scope = storage(state => state.settingsScope);
  const sessionChoice = React.useMemo<ConversationSessionVoiceChoice | null>(() => {
    if (!providerId) return null;
    const local = providerId === 'local_conversation' ? readLocalConversationVoiceSettings(voice)
      : providerId === 'local_direct' ? readLocalDirectVoiceSettings(voice) : null;
    if (local) {
      const tts = local.tts;
      if (tts.provider === 'local_neural') return {
        providerId: BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID,
        declaration: BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION,
        config: { voiceId: tts.localNeural.voiceId },
        preview: input => previewLocalNeuralTts({ config: { ...tts.localNeural, voiceId: input.row.id },
          sample: t('settingsVoice.local.testTtsSample'), timeoutMs: local.networkTimeoutMs,
          signal: input.signal, isCurrent: input.isCurrent, registerPlaybackStopper: input.registerPlaybackStopper }),
        targetKey: JSON.stringify([BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, tts.localNeural.assetId,
          tts.localNeural.execution, machineId, scope]),
        client: { fetchVoiceCatalog: async signal => {
          signal?.throwIfAborted();
          const catalog = await readLocalNeuralVoiceCatalog({ config: tts.localNeural, originMachineId: machineId });
          signal?.throwIfAborted();
          return catalog.rows;
        } },
      };
      const entry = registry.get(tts.provider);
      const declaration = entry?.kind === 'voice.speech-engine.v1' ? entry.declaration ?? null : null;
      return { providerId: tts.provider, declaration,
        config: VoiceProviderSettingsJsonValueV1Schema.parse(readVoiceProviderSettingsConfig(voice, tts.provider) ?? {}),
        targetKey: JSON.stringify([tts.provider, voice.providers[tts.provider], machineId, scope, registrationsRevision]),
        client: entry && declaration ? { fetchVoiceCatalog: signal =>
          new BundledSpeechDaemonClient().fetchCatalog(entry, 'voices', signal, machineId) } : null };
    }
    const declaration = registry.get(providerId)?.declaration ?? null;
    return { providerId, declaration, config: VoiceProviderSettingsJsonValueV1Schema.parse(config ?? {}),
      client: bundledUi?.client ?? null, targetKey: JSON.stringify([providerId, envelope, machineId, scope, registrationsRevision]) };
  }, [bundledUi, config, envelope, machineId, providerId, registrationsRevision, scope, voice]);
  return { providerId, bundledUi, descriptor, owner, resolved, config, sessionChoice };
}
