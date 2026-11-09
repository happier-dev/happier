import { PluginError } from '@happier-dev/plugin-sdk';
import { PluginPermissionGrantListActionInputV1Schema, PluginPermissionGrantListActionOutputV1Schema } from '@happier-dev/protocol/plugins/permissions/grants';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';

import { evaluatePluginPermissionGrant } from '@/plugins/runtime/lifecycle/permissions/evaluatePluginPermissionGrant';
import type { PluginPermissionGrantListReader } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantListReader';
import type { PluginRawCredentialAuthorizationInspection } from './rawCredentialMaterializer';

export function savedSecretCredentialGrantRequirement(ownedByRequester: boolean): 'linked' | 'approval_required' {
  return ownedByRequester ? 'linked' : 'approval_required';
}

export function credentialApprovalRequired(): PluginError {
  return new PluginError({
    code: 'plugin_voice_credential_access_unavailable',
    message: 'Credential custodian approval is required',
    details: { grantRequirement: 'approval_required' },
  });
}

/** Both raw disclosure and mediated use consume the same persisted approval. */
export async function admitPluginCredentialGrant(input: Readonly<{
  inspection: PluginRawCredentialAuthorizationInspection;
  caller: PluginMachineMaterializationRefV1;
  grants: PluginPermissionGrantListReader;
  signal: AbortSignal;
}>): Promise<void> {
  const { inspection, signal } = input;
  if (inspection.grantRequirement === 'linked') return;
  const listInput = PluginPermissionGrantListActionInputV1Schema.parse({
    pluginId: inspection.pluginId,
    capability: inspection.capability,
    targetScope: inspection.targetScope,
    subject: inspection.subject,
    caller: input.caller,
    includeRevoked: false,
    includeResolvedRequests: false,
    limit: 200,
  });
  const listed = PluginPermissionGrantListActionOutputV1Schema.parse(
    await input.grants.list(listInput, { signal }),
  );
  signal.throwIfAborted();
  if (!listed.grants.some(grant => evaluatePluginPermissionGrant({
    grant,
    pluginId: inspection.pluginId,
    capability: inspection.capability,
    targetScope: inspection.targetScope,
    subject: inspection.subject,
    currentAuthoritySource: inspection.authoritySource,
  }))) throw credentialApprovalRequired();
}
