import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { resolveProviderSecretBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import type { ProviderConnectionId, ProviderCredentialTransportV1, ProviderErrorV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { TeamCredentialDirectMaterialPayloadV1 } from '@happier-dev/protocol/teams';

import {
  TeamCredentialDirectMaterialOperationError,
  type TeamCredentialDirectMaterialOperationFailure,
  type TeamCredentialDirectMaterialUnavailableReason,
} from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';
import type { ProviderProbeAuthorizationRequest } from '../probe/authorization';

export type ProviderCredentialReference =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'apiKey';
      secretId: string;
      secretRecordFingerprint: string;
    }>
  | Readonly<{
      kind: 'team_direct';
      teamId: string;
      resourceId: string;
      expectedResourceRevision: number;
      sourceMemberKey: string;
      sourceVersion: string;
    }>;

export type ProviderProbeHostCredentialReference = Readonly<{
  connectionId: ProviderConnectionId;
  machineId: string;
  reference: ProviderCredentialReference;
  transport: ProviderCredentialTransportV1;
  protocol: ProviderProbeAuthorizationRequest['protocol'];
}>;

type ProviderCredentialReferenceResult =
  // Saved Secret bindings are the only source this resolver reads, so it can
  // never produce a Team direct-delivery reference; that shape is produced by
  // the Team credential session binding owner.
  | Readonly<{ ok: true; reference: Exclude<ProviderCredentialReference, { kind: 'team_direct' }> }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export function resolveProviderCredentialReference(input: Readonly<{
  providerSettings: ProviderSettingsV1;
  accountSettings: unknown;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  connectionId: ProviderConnectionId | string;
  machineId: string;
  credentialSlotId: string;
  required: boolean;
}>): ProviderCredentialReferenceResult {
  const context = { connectionId: input.connectionId, machineId: input.machineId };
  const secretId = resolveProviderSecretBindingIdV1(
    input.providerSettings,
    input.connectionId,
    input.machineId,
    input.credentialSlotId,
  );
  if (secretId === null) {
    return input.required
      ? { ok: false, error: createProviderErrorV1('provider_secret_missing', context) }
      : { ok: true, reference: { kind: 'none' } };
  }
  const inspected = createSavedSecretMaterializerV1({
    accountSettings: input.accountSettings,
    settingsSecretsReadKeys: [],
    resources: input.savedSecretResources,
  }).inspect(secretId);
  if (
    inspected.status !== 'ready'
    || (inspected.source === 'personal' && inspected.storage !== 'settings_encrypted')
  ) {
    return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  }
  return {
    ok: true,
    reference: {
      kind: 'apiKey',
      secretId,
      secretRecordFingerprint: inspected.fingerprint,
    },
  };
}

export type ProviderResolvedCredential =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'apiKey'; value: string }>;

export type ProviderCredentialPlaintextResultForSpawn =
  | Readonly<{ ok: true; credential: ProviderResolvedCredential }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

function providerErrorForTeamDirectMaterialFailure(
  reason: TeamCredentialDirectMaterialUnavailableReason,
  context: Readonly<{ connectionId: string; machineId: string }>,
): ProviderErrorV1 {
  switch (reason) {
    case 'preparing':
    case 'temporarily_unavailable':
      return createProviderErrorV1('provider_endpoint_unavailable', context);
    case 'source_changed':
    case 'recipient_binding_changed':
      return createProviderErrorV1('provider_authorization_changed', context);
    case 'access_removed':
      return createProviderErrorV1('provider_account_grant_stale', context);
    case 'disabled':
      return createProviderErrorV1('provider_connection_disabled', context);
    case 'unsupported_direct_source':
      return createProviderErrorV1('provider_credential_transport_unavailable', context);
    case 'invalid_material':
    case 'resource_corrupt':
      return createProviderErrorV1('provider_materialization_failed', context);
  }
}

export async function resolveProviderCredentialPlaintextAsync(input: Readonly<{
  reference: ProviderCredentialReference;
  accountSettings: unknown;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>;
  connectionId: ProviderConnectionId | string;
  machineId: string;
  openTeamDirect?: (input: Readonly<{
    teamId: string;
    resourceId: string;
    expectedResourceRevision: number;
    sourceMemberKey: string;
    expectedSourceVersion: string;
  }>) => Promise<
    | Readonly<{ ok: true; payload: TeamCredentialDirectMaterialPayloadV1 }>
    | Readonly<{ ok: false; reason: TeamCredentialDirectMaterialUnavailableReason }>
    | Readonly<{ ok: false; operationError: TeamCredentialDirectMaterialOperationFailure }>
  >;
}>): Promise<ProviderCredentialPlaintextResultForSpawn> {
  if (input.reference.kind === 'none') return { ok: true, credential: { kind: 'none' } };
  const context = { connectionId: input.connectionId, machineId: input.machineId };
  if (input.reference.kind === 'team_direct') {
    if (!input.openTeamDirect) {
      return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
    }
    const opened = await input.openTeamDirect({
      teamId: input.reference.teamId,
      resourceId: input.reference.resourceId,
      expectedResourceRevision: input.reference.expectedResourceRevision,
      sourceMemberKey: input.reference.sourceMemberKey,
      expectedSourceVersion: input.reference.sourceVersion,
    });
    if (!opened.ok) {
      if ('operationError' in opened) {
        throw new TeamCredentialDirectMaterialOperationError(opened.operationError);
      }
      return { ok: false, error: providerErrorForTeamDirectMaterialFailure(opened.reason, context) };
    }
    if (opened.payload.material.kind !== 'provider_api_key') {
      return { ok: false, error: createProviderErrorV1('provider_materialization_failed', context) };
    }
    return { ok: true, credential: { kind: 'apiKey', value: opened.payload.material.value } };
  }
  const materializer = createSavedSecretMaterializerV1({
    accountSettings: input.accountSettings,
    settingsSecretsReadKeys: input.settingsSecretsReadKeys.filter((key): key is Uint8Array => key instanceof Uint8Array),
    resources: input.savedSecretResources,
  });
  const current = materializer.inspect(input.reference.secretId);
  if (current.status !== 'ready') {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  if (current.fingerprint !== input.reference.secretRecordFingerprint) {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  const resolved = materializer.resolve(input.reference.secretId);
  if (resolved.status !== 'ready' || !resolved.value) {
    return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  }
  return { ok: true, credential: { kind: 'apiKey', value: resolved.value } };
}

export function resolveProviderCredentialPlaintext(input: Readonly<{
  reference: Exclude<ProviderCredentialReference, { kind: 'team_direct' }>;
  accountSettings: unknown;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>;
  connectionId: ProviderConnectionId | string;
  machineId: string;
}>): ProviderCredentialPlaintextResultForSpawn {
  if (input.reference.kind === 'none') return { ok: true, credential: { kind: 'none' } };
  const context = { connectionId: input.connectionId, machineId: input.machineId };
  const materializer = createSavedSecretMaterializerV1({
    accountSettings: input.accountSettings,
    settingsSecretsReadKeys: input.settingsSecretsReadKeys.filter((key): key is Uint8Array => key instanceof Uint8Array),
    resources: input.savedSecretResources,
  });
  const current = materializer.inspect(input.reference.secretId);
  if (current.status !== 'ready' || current.fingerprint !== input.reference.secretRecordFingerprint) {
    return { ok: false, error: createProviderErrorV1('provider_authorization_changed', context) };
  }
  const resolved = materializer.resolve(input.reference.secretId);
  if (resolved.status !== 'ready' || !resolved.value) {
    return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  }
  return { ok: true, credential: { kind: 'apiKey', value: resolved.value } };
}
