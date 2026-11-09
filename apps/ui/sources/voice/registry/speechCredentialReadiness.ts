import {
  type PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import {
  type VoiceProviderSettingsEnvelopeV1} from '@happier-dev/protocol/voice/realtime/providerSettings';
import {
  type VoiceReadinessRole,
} from '@happier-dev/protocol/voice/realtime/capabilities';

import type { Settings } from '@/sync/domains/settings/settings';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { projectVoiceCredentialReadiness } from '@/voice/credentials/credentialReadiness';

import {
  type VoiceProviderRegistry,
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
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  connectedPurposes: ConnectedPurposeCatalogV1 | null;
  executionMachineId: string | null | undefined;
  providerEnvelope?: VoiceProviderSettingsEnvelopeV1 | null;
  rawAuthorization?: Readonly<{
    contribution: PluginContributionIdentityV1;
    machineId: string | null;
    realm: 'daemon';
    phase: 'speech';
    status: 'ready' | 'approval_required' | 'unknown';
  }> | null;
  resolveSavedSecret?: (ref: string) => SavedSecretReferenceResolution;
}>): VoiceCredentialReadinessFact {
  const entry = input.registry.get(input.providerId);
  if (!entry || !entry.roles.includes(input.role) || !isSpeechReadinessRole(input.role)) {
    return 'unknown';
  }
  const requirement = entry.kind === 'voice.speech-engine.v1' ? entry.declaration?.credentials?.requirement : null;
  if (!requirement) return entry.requirements.includes('credential') ? 'unknown' : 'ready';
  return projectVoiceCredentialReadiness({ entry, settings: input.settings, connectedPurposes: input.connectedPurposes,
    machineId: input.executionMachineId, envelope: input.providerEnvelope, resolveSavedSecret: input.resolveSavedSecret,
    rawAuthorization: input.rawAuthorization }).credential;
}
