import type { PluginMachineMaterializationRefV1, RecipientOperationV1, VoiceCredentialAccessPhase, VoiceCredentialBindingIdentityV1, VoiceProviderContribution } from '@happier-dev/protocol';
import { resolveVoiceCredentialMediatedGrantDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/voice';

import { resolveCurrentPluginPermissionGrantAuthoritySource } from '@/daemon/identity/currentMachineInstallation';
import type { StoredCredentials } from '@/persistence';
import { createAccountLifetimePluginPermissionGrantListReader } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantListReader';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { admitPluginCredentialGrant, credentialApprovalRequired, savedSecretCredentialGrantRequirement } from './credentialGrantAdmission';
import { createPluginRawCredentialAuthorizationInspector, type CurrentPluginPermissionGrantAuthoritySourceReader, type PluginPermissionGrantListReader } from './rawCredentialMaterializer';
import { createRegistryInstallReviewPrincipalReader } from './registryInstallReviewPrincipalReader';

/** Host boundary ports shared by mediated acquisition and raw-grant tests. */
export type MediatedCredentialGrantContext = Readonly<{
  caller: PluginMachineMaterializationRefV1;
  grants: PluginPermissionGrantListReader;
  readCurrentGrantAuthoritySource: CurrentPluginPermissionGrantAuthoritySourceReader;
}>;

export type MediatedCredentialAdmission = Readonly<{
  contribution: VoiceProviderContribution;
  operation: RecipientOperationV1;
  phase: VoiceCredentialAccessPhase;
  realm?: 'web' | 'ios' | 'android' | 'daemon';
  signal: AbortSignal;
}>;

/**
 * A mediated recipient uses the existing rawGrant review record for the same
 * source and header tuple. Inspection does not grant raw materialization.
 */
export async function admitMediatedSavedSecretCredential(input: Readonly<{
  identity: VoiceCredentialBindingIdentityV1;
  relationship: 'owner' | 'recipient';
  snapshot: ActiveAccountSettingsSnapshot;
  machineId: string | null;
  readCredentials(): Promise<StoredCredentials | null>;
  admission?: MediatedCredentialAdmission;
  grantContext?: MediatedCredentialGrantContext;
}>): Promise<void> {
  if (savedSecretCredentialGrantRequirement(input.relationship === 'owner') === 'linked') return;
  const admission = input.admission;
  if (!admission?.realm) throw credentialApprovalRequired();
  const realm = admission.realm;
  const { signal } = admission;
  signal.throwIfAborted();
  const inspectAndAdmit = async (context: MediatedCredentialGrantContext) => {
    const inspector = createPluginRawCredentialAuthorizationInspector({
      binding: {
        manifest: { id: input.identity.contribution.pluginId,
          contributes: { voiceProviders: [admission.contribution] } },
        contribution: input.identity.contribution,
        realm,
        phase: admission.phase,
        machineId: input.machineId,
        isRuntimeAuthorityCurrent: () => !signal.aborted,
      },
      getAccountSettingsSnapshot: () => input.snapshot,
      currentInstallReviewPrincipal: createRegistryInstallReviewPrincipalReader(),
      readCurrentGrantAuthoritySource: context.readCurrentGrantAuthoritySource,
    });
    const [grant] = resolveVoiceCredentialMediatedGrantDeclarationsV1({
      pluginId: input.identity.contribution.pluginId, contribution: admission.contribution,
      realm, phase: admission.phase, operationId: admission.operation.id });
    if (!grant) throw credentialApprovalRequired();
    const inspection = await inspector.inspectAuthorization(grant.request, { signal });
    await admitPluginCredentialGrant({ inspection, caller: context.caller, grants: context.grants, signal });
  };
  if (input.grantContext) return await inspectAndAdmit(input.grantContext);
  const credentials = await input.readCredentials();
  signal.throwIfAborted();
  if (!credentials) throw credentialApprovalRequired();
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    const caller = lease.registry.resolveCurrentPluginMaterializationRef?.(input.identity.contribution.pluginId);
    if (!caller) throw credentialApprovalRequired();
    await inspectAndAdmit({ caller,
      grants: createAccountLifetimePluginPermissionGrantListReader({ credentials,
        getScopeKey: () => input.snapshot.scopeKey ?? null }),
      readCurrentGrantAuthoritySource: resolveCurrentPluginPermissionGrantAuthoritySource });
  } finally {
    await lease.release();
  }
}
