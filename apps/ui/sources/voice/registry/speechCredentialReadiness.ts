import {
  type PluginContributionIdentityV1,
  type VoiceProviderSettingsEnvelopeV1,
  type VoiceReadinessRole,
} from '@happier-dev/protocol';

import type { Settings } from '@/sync/domains/settings/settings';
import {
  resolveAccountVoiceCredentialSourceSelection,
  resolveAccountVoiceCredentialStatus,
  resolveSelectedVoiceCredentialRawGrants,
} from '@/voice/credentials/accountVoiceCredential';

import {
  type VoiceProviderRegistry,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';
import type { VoiceCredentialReadinessFact } from './readiness';

type SpeechReadinessRole =
  | 'dictation_stt'
  | 'conversation_stt'
  | 'conversation_tts';

function isSpeechReadinessRole(role: VoiceReadinessRole): role is SpeechReadinessRole {
  return role === 'dictation_stt'
    || role === 'conversation_stt'
    || role === 'conversation_tts';
}

function resolveSpeechCredentialSlotId(
  entry: VoiceProviderRegistryEntry,
  role: SpeechReadinessRole,
): string | null {
  if (entry.kind !== 'voice.speech-engine.v1') return null;
  const declaration = entry.declaration;
  if (declaration?.kind !== 'speech' || !declaration.roles.includes(role)) return null;
  return declaration.credentials?.slot.id ?? null;
}

function resolveSpeechContribution(
  entry: VoiceProviderRegistryEntry,
  role: SpeechReadinessRole,
): PluginContributionIdentityV1 | null {
  if (entry.kind !== 'voice.speech-engine.v1') return null;
  if (entry.declaration?.kind === 'speech' && entry.source.kind !== 'built_in') {
    return Object.freeze({
      pluginId: entry.pluginId,
      localId: entry.declaration.id,
    });
  }
  return null;
}

/**
 * Passive credential fact for one selected speech leaf. This reads only the
 * canonical selected source, including its selected-machine SavedSecret
 * override. It only inspects settings authority; it never materializes a
 * secret or Connected Account and never invokes a provider.
 */
export function projectVoiceSpeechCredentialReadiness(input: Readonly<{
  registry: VoiceProviderRegistry;
  role: VoiceReadinessRole;
  providerId: string;
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets' | 'connectedAccountPurposeBindingsV1'>;
  executionMachineId: string | null | undefined;
  providerEnvelope?: VoiceProviderSettingsEnvelopeV1 | null;
  rawAuthorization?: Readonly<{
    contribution: PluginContributionIdentityV1;
    machineId: string | null;
    realm: 'daemon';
    phase: 'speech';
    status: 'ready' | 'approval_required' | 'unknown';
  }> | null;
}>): VoiceCredentialReadinessFact {
  const entry = input.registry.get(input.providerId);
  if (!entry || !entry.roles.includes(input.role) || !isSpeechReadinessRole(input.role)) {
    return 'unknown';
  }
  const requirement = entry.kind === 'voice.speech-engine.v1'
    ? entry.declaration?.credentials?.requirement
    : undefined;
  if (!requirement) return entry.requirements.includes('credential') ? 'unknown' : 'ready';
  if (requirement.kind === 'when_setting_equals') {
    const owner = entry.providerSettings;
    const envelope = input.providerEnvelope;
    if (!owner || !envelope || envelope.schemaVersion !== owner.schemaVersion) return 'unknown';
    const config = owner.parseConfig(envelope.config);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'unknown';
    if ((config as Readonly<Record<string, unknown>>)[requirement.settingId] !== requirement.value) {
      return 'ready';
    }
  }

  const declaration = entry.kind === 'voice.speech-engine.v1'
    ? entry.declaration
    : null;
  const credentialSlotId = resolveSpeechCredentialSlotId(entry, input.role);
  const contribution = resolveSpeechContribution(entry, input.role);
  if (!credentialSlotId || !contribution || declaration?.kind !== 'speech' || !declaration.credentials) {
    return 'unknown';
  }
  let selected: ReturnType<typeof resolveAccountVoiceCredentialSourceSelection>;
  try {
    selected = resolveAccountVoiceCredentialSourceSelection({
      settings: input.settings,
      contribution,
      credentialSlotId,
      purpose: {
        consumer: contribution,
        purpose: declaration.credentials.slot.purpose,
      },
      machineId: input.executionMachineId ?? null,
    });
  } catch {
    return 'unknown';
  }
  if (selected.selection.kind === 'none') {
    return requirement.kind === 'optional' ? 'ready' : 'missing';
  }
  if (selected.selection.kind === 'savedSecret') {
    const status = resolveAccountVoiceCredentialStatus({
      settings: input.settings,
      contribution,
      credentialSlotId,
      machineId: input.executionMachineId ?? null,
      requiredRecipientContractDigest: entry.accountCredentialSlot?.recipientContractDigest ?? null,
    }).status;
    if (status !== 'ready') {
      return status === 'review_required' ? 'approval_required' : status;
    }
  }
  const selectedSourceHasRawSpeechGrant = resolveSelectedVoiceCredentialRawGrants({
    declaration,
    contribution,
    selection: selected.selection,
  }).some((grant) => grant.realm === 'daemon' && grant.phase === 'speech');
  const rawAuthorization = input.rawAuthorization;
  if (selectedSourceHasRawSpeechGrant
    && rawAuthorization
    && rawAuthorization.contribution.pluginId === contribution.pluginId
    && rawAuthorization.contribution.localId === contribution.localId
    && rawAuthorization.machineId === (input.executionMachineId ?? null)
    && rawAuthorization.realm === 'daemon'
    && rawAuthorization.phase === 'speech') {
    return rawAuthorization.status;
  }
  if (selectedSourceHasRawSpeechGrant) return 'unknown';
  if (selected.selection.kind === 'connectedAccount') return 'ready';
  return 'ready';
}
