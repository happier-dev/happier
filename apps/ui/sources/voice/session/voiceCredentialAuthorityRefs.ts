import {
  PluginContributionIdentityV1Schema,
  VoiceCredentialBindingV1Schema,
  VoiceProviderSettingsEnvelopeV1Schema,
  buildQualifiedPluginContributionKey,
  type VoiceCredentialBindingV1,
  type VoiceProviderSettingsEnvelopeV1,
} from '@happier-dev/protocol';

import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type VoiceCredentialRuntimeAuthoritySnapshot = Readonly<{
  accountScopeAuthority: string;
  agentConnectedServiceBindingAuthority: string;
  credentialBindingAuthority: string;
  providerEnvelopeAuthority: string;
  selectedCredentialAuthority: string;
}>;

export function createVoiceCredentialRuntimeAuthoritySnapshot(input: Readonly<{
  accountScope: unknown;
  agentConnectedServiceBindingAuthority: string;
  credentialBinding: unknown;
  providerEnvelope: unknown;
  selectedCredentialAuthority: unknown;
}>): VoiceCredentialRuntimeAuthoritySnapshot {
  return Object.freeze({
    accountScopeAuthority: stableJsonStringify(input.accountScope),
    agentConnectedServiceBindingAuthority: input.agentConnectedServiceBindingAuthority,
    credentialBindingAuthority: stableJsonStringify(input.credentialBinding),
    providerEnvelopeAuthority: stableJsonStringify(input.providerEnvelope),
    selectedCredentialAuthority: stableJsonStringify(input.selectedCredentialAuthority),
  });
}

export function hasVoiceCredentialRuntimeAuthorityChanged(
  previous: VoiceCredentialRuntimeAuthoritySnapshot,
  next: VoiceCredentialRuntimeAuthoritySnapshot,
): boolean {
  return previous.accountScopeAuthority !== next.accountScopeAuthority
    || previous.agentConnectedServiceBindingAuthority
      !== next.agentConnectedServiceBindingAuthority
    || previous.credentialBindingAuthority !== next.credentialBindingAuthority
    || previous.providerEnvelopeAuthority !== next.providerEnvelopeAuthority
    || previous.selectedCredentialAuthority !== next.selectedCredentialAuthority;
}

/**
 * Composes only the already-selected non-secret credential authority. Source
 * selection, SavedSecret lookup and Connected Account health/revision remain
 * with their canonical owners; this lifecycle projection merely compares the
 * facts they produced.
 */
export function createVoiceSelectedCredentialAuthorityFingerprint(input: Readonly<{
  sourceResolution: unknown;
  selectedSavedSecret: unknown;
  selectedConnectedAccountAuthority: string;
}>): string {
  return stableJsonStringify({
    sourceResolution: input.sourceResolution,
    selectedSavedSecret: input.selectedSavedSecret,
    selectedConnectedAccountAuthority: input.selectedConnectedAccountAuthority,
  });
}

function readQualifiedContribution(providerId: string | 'off' | null) {
  if (!providerId || providerId === 'off') return null;
  const separator = providerId.indexOf('/');
  if (separator <= 0 || separator === providerId.length - 1) return null;
  const parsed = PluginContributionIdentityV1Schema.safeParse({
    pluginId: providerId.slice(0, separator),
    localId: providerId.slice(separator + 1),
  });
  return parsed.success
    && buildQualifiedPluginContributionKey(parsed.data) === providerId
    ? parsed.data
    : null;
}

export function readVoiceCredentialAuthorityRefs(
  rawVoice: unknown,
  providerId: string | 'off' | null,
  credentialSlotId: string | null,
): Readonly<{
  credentialBinding: VoiceCredentialBindingV1 | null;
  providerEnvelope: VoiceProviderSettingsEnvelopeV1 | null;
}> {
  const contribution = readQualifiedContribution(providerId);
  if (!contribution || !rawVoice || typeof rawVoice !== 'object' || Array.isArray(rawVoice)) {
    return { credentialBinding: null, providerEnvelope: null };
  }
  const qualifiedProviderId = buildQualifiedPluginContributionKey(contribution);

  const voice = rawVoice as Readonly<{
    credentialBindings?: unknown;
    providers?: unknown;
  }>;
  const credentialBinding = credentialSlotId !== null && Array.isArray(voice.credentialBindings)
    ? voice.credentialBindings.find((candidate) => {
        const parsed = VoiceCredentialBindingV1Schema.safeParse(candidate);
        return parsed.success
          && parsed.data.contribution.pluginId === contribution.pluginId
          && parsed.data.contribution.localId === contribution.localId
          && parsed.data.credentialSlotId === credentialSlotId;
      }) as VoiceCredentialBindingV1 | undefined
    : undefined;
  const providers = voice.providers;
  const rawProviderEnvelope = providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Readonly<Record<string, unknown>>)[qualifiedProviderId]
    : undefined;
  const providerEnvelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(rawProviderEnvelope);

  return {
    credentialBinding: credentialBinding ?? null,
    providerEnvelope: providerEnvelope.success
      ? rawProviderEnvelope as VoiceProviderSettingsEnvelopeV1
      : null,
  };
}
