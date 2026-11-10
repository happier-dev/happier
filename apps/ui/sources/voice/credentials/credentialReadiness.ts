import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { VoiceCredentialSourceSelection } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

import type { Settings } from '@/sync/domains/settings/settings';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { projectVoiceProviderCredentialReadiness, type VoiceProviderCredentialReadinessProjection, type VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { resolveVoiceProviderCredentialFact, type VoiceCredentialReadinessFact } from '@/voice/registry/readiness';
import { resolveAccountVoiceCredentialSourceSelection, resolveAccountVoiceCredentialStatus, resolveSelectedVoiceCredentialRawGrants, type AccountVoiceCredentialStatus } from './accountVoiceCredential';
import type { VoiceConnectedAccountTargetEligibility } from './sourceEligibility';

export type VoiceRawCredentialReadiness = Readonly<{
  contribution: PluginContributionIdentityV1;
  machineId: string | null;
  realm: 'daemon';
  phase: 'speech';
  status: 'ready' | 'approval_required' | 'unknown';
}>;

type VoiceSelectedSource = VoiceCredentialSourceSelection & Readonly<{ connectedAccountEligibility: VoiceConnectedAccountTargetEligibility }>;

/** A person's own selected Saved Secret is already approved by linking it. */
export function projectVoiceCredentialAccessReviewRequirement(
  credential: AccountVoiceCredentialStatus,
): 'linked' | 'approval_required' {
  return credential.savedSecret?.entry?.relationship === 'owner' ? 'linked' : 'approval_required';
}

/** Page, Settings Action and speech/dictation share this selected-credential composition. */
export function projectVoiceCredentialReadiness(input: Readonly<{
  entry: VoiceProviderRegistryEntry;
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  connectedPurposes: ConnectedPurposeCatalogV1 | null;
  machineId?: string | null;
  envelope?: Readonly<{ schemaVersion: number; config: unknown }> | null;
  resolveSavedSecret?: (ref: string) => SavedSecretReferenceResolution;
  resolveConnectedAccountEligibility?: (selection: Extract<VoiceCredentialSourceSelection, { kind: 'connectedAccount' }>,
    declaredServices: readonly PluginContributionIdentityV1[]) => VoiceConnectedAccountTargetEligibility;
  rawAuthorization?: VoiceRawCredentialReadiness | null;
}>): Readonly<{
  credential: VoiceCredentialReadinessFact;
  sourceSelection: VoiceSelectedSource | null;
  projectedCredential: VoiceProviderCredentialReadinessProjection | null;
  accountCredentialReference: AccountVoiceCredentialStatus['reference'];
  credentialResolving: boolean;
}> {
  const entry = input.entry;
  const declaration = entry.kind === 'voice.conversation-provider.v1' || entry.kind === 'voice.speech-engine.v1'
    ? entry.declaration : null;
  const credentials = declaration?.credentials;
  const unavailable = { credential: 'unknown' as const, sourceSelection: null, projectedCredential: null, accountCredentialReference: null, credentialResolving: false };
  if (!declaration || !credentials) return unavailable;
  const contribution = { pluginId: entry.pluginId, localId: declaration.id };
  let sourceSelection: VoiceSelectedSource;
  try {
    const selected = resolveAccountVoiceCredentialSourceSelection({ settings: input.settings,
      connectedPurposes: input.connectedPurposes, contribution, credentialSlotId: credentials.slot.id,
      purpose: { consumer: contribution, purpose: credentials.slot.purpose }, machineId: input.machineId ?? null }).selection;
    const declaredServices = credentials.sources.flatMap(source => source.kind === 'connectedAccount'
      ? [qualifyPluginContributionReferenceV1(source.service, entry.pluginId)] : []);
    sourceSelection = { ...selected, connectedAccountEligibility: selected.kind === 'connectedAccount'
      ? input.resolveConnectedAccountEligibility?.(selected, declaredServices) ?? 'usable' : 'unusable' };
  } catch {
    return unavailable;
  }
  const savedSecret: AccountVoiceCredentialStatus = sourceSelection.kind === 'savedSecret'
    ? resolveAccountVoiceCredentialStatus({ settings: input.settings, contribution,
      credentialSlotId: credentials.slot.id, machineId: input.machineId, resolveSavedSecret: input.resolveSavedSecret })
    : { status: 'missing' as const, reference: null };
  const projected = projectVoiceProviderCredentialReadiness(entry, input.envelope ?? null, { sourceSelection, savedSecret });
  let credential: VoiceCredentialReadinessFact = declaration.kind === 'speech' ? projected?.status ?? 'ready'
    : resolveVoiceProviderCredentialFact({ sourceKind: entry.source.kind, projectedCredential: projected,
      hasAccountCredentialSlot: Boolean(entry.accountCredentialSlot), hasAccountCredentialReference: savedSecret.status === 'ready' });
  if (credential === 'ready' && declaration.kind === 'speech' && sourceSelection.kind !== 'none'
    && resolveSelectedVoiceCredentialRawGrants({ declaration, contribution, selection: sourceSelection,
      access: { realm: 'daemon', phase: 'speech' } }).length > 0) {
    const raw = input.rawAuthorization;
    credential = raw?.contribution.pluginId === contribution.pluginId
      && raw.contribution.localId === contribution.localId && raw.machineId === (input.machineId ?? null)
      && raw.realm === 'daemon' && raw.phase === 'speech' ? raw.status : 'unknown';
  }
  return { credential, sourceSelection, projectedCredential: projected,
    credentialResolving: savedSecret.savedSecret?.resolving === true,
    accountCredentialReference: savedSecret.status === 'ready' ? savedSecret.reference : null };
}
