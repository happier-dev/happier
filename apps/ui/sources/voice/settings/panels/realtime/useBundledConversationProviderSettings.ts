import * as React from 'react';

import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceProviderSettingsConfig, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createBundledConversationUi } from '@/voice/credentials/bundledConversationClient';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveSelectedVoiceProviderTitleKey } from '@/voice/registry/providerSelection';
import { BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION, BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, readSessionVoiceSettingFieldV1, type SessionVoiceDeclarationV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { VoiceProviderSettingsJsonValueV1Schema, type VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol/voice/realtime/providerSettings';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import { storage } from '@/sync/domains/state/storage';
import {
  getExternalVoiceProviderRegistrationsRevision,
  subscribeExternalVoiceProviderRegistrations,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { readBundledSpeechSettingsDescriptorFromEntry } from '../bundledSpeech/descriptor';

import {
  parseRealtimeSettingsDescriptor,
  resolveRealtimeProviderConfig,
  readRealtimeProviderConfigPath,
  updateRealtimeProviderConfig,
  type RealtimeProviderSettingsOwner,
  type RealtimeSettingsDescriptor,
  type ResolvedRealtimeProviderConfig,
} from './descriptor';

const registry = createDefaultVoiceProviderRegistry();
export type ConversationSessionVoiceChoice = Readonly<{
  providerId: string;
  providerTitleKey: string | null;
  declaration: SessionVoiceDeclarationV1 | null;
  config: VoiceProviderSettingsJsonValueV1;
  catalogAvailable: boolean;
  targetKey: string;
  canPreview?: boolean;
}>;

function createUiSafely(providerId: string) {
  try {
    return createBundledConversationUi(providerId);
  } catch {
    return null;
  }
}

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCatalogCredentialBindings(voice: VoiceSettings, providerId: string) {
  const entry = registry.get(providerId);
  return entry && entry.kind !== 'voice.turn-support.v1' && entry.declaration ? voice.credentialBindings.filter(binding =>
    binding.contribution.pluginId === entry.pluginId && binding.contribution.localId === entry.declaration?.id) : [];
}

function readCatalogConfig(providerId: string, config: Readonly<Record<string, unknown>>) {
  const entry = registry.get(providerId);
  const owner = entry?.providerSettings;
  const field = entry && entry.kind !== 'voice.turn-support.v1' && entry.declaration
    ? readSessionVoiceSettingFieldV1(entry.declaration) : null;
  if (!owner || !field) return config;
  // Selecting a voice does not change the catalog that names it. Preserve every other
  // provider-owned input, and normalize only its declared voice field through its parser.
  const catalogOwner = {
    schemaVersion: owner.schemaVersion,
    defaultConfig: owner.defaultConfig,
    parseConfig(value: unknown) {
      const parsed = owner.parseConfig(value);
      return isConfigRecord(parsed) ? parsed : null;
    },
  };
  return updateRealtimeProviderConfig(catalogOwner, config, field.path,
    readRealtimeProviderConfigPath(owner.defaultConfig, field.path.split('.'))) ?? config;
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
  const machineId = useVoiceExecutionMachineId();
  const scope = storage(state => state.settingsScope);
  const sessionChoice = React.useMemo<ConversationSessionVoiceChoice | null>(() => {
    if (!providerId) return null;
    const local = providerId === 'local_conversation' ? readLocalConversationVoiceSettings(voice)
      : providerId === 'local_direct' ? readLocalDirectVoiceSettings(voice) : null;
    if (local) {
      const tts = local.tts;
      const entry = registry.get(tts.provider);
      const providerTitleKey = entry?.processingDisclosures?.tts?.titleKey
        ?? readBundledSpeechSettingsDescriptorFromEntry(tts.provider, entry)?.titleKey ?? null;
      if (tts.provider === 'local_neural') return {
        providerId: BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID,
        providerTitleKey,
        declaration: BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION,
        config: { voiceId: tts.localNeural.voiceId },
        canPreview: true,
        targetKey: JSON.stringify([BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, tts.localNeural.assetId,
          tts.localNeural.execution, machineId, scope]),
        catalogAvailable: true,
      };
      const declaration = entry?.kind === 'voice.speech-engine.v1' ? entry.declaration ?? null : null;
      const speechConfig = readVoiceProviderSettingsConfig(voice, tts.provider) ?? {};
      return { providerId: tts.provider, providerTitleKey, declaration,
        config: VoiceProviderSettingsJsonValueV1Schema.parse(speechConfig),
        targetKey: JSON.stringify([tts.provider, entry?.providerSettings?.schemaVersion ?? voice.providers[tts.provider]?.schemaVersion,
          readCatalogConfig(tts.provider, speechConfig), readCatalogCredentialBindings(voice, tts.provider),
          machineId, scope]),
        catalogAvailable: Boolean(entry && declaration) };
    }
    const entry = registry.get(providerId);
    const declaration = entry && entry.kind !== 'voice.turn-support.v1' ? entry.declaration ?? null : null;
    return { providerId, providerTitleKey: resolveSelectedVoiceProviderTitleKey(voice, registry),
      declaration, config: VoiceProviderSettingsJsonValueV1Schema.parse(config ?? {}),
      catalogAvailable: Boolean(declaration && readSessionVoiceSettingFieldV1(declaration)), targetKey: JSON.stringify([providerId, owner?.schemaVersion ?? envelope?.schemaVersion,
        config ? readCatalogConfig(providerId, config) : envelope, readCatalogCredentialBindings(voice, providerId),
        machineId, scope]) };
  }, [bundledUi, config, envelope, machineId, owner, providerId, registrationsRevision, scope, voice]);
  return { providerId, bundledUi, descriptor, owner, resolved, config, sessionChoice };
}
