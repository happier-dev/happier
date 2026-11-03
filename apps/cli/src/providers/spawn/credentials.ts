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
  type SavedSecretMaterializerV1,
} from '@/settings/secrets/savedSecretCatalog';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { ProviderProbeAuthorizationRequest } from '../probe/authorization';

export type ProviderCredentialReference =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'apiKey';
      secretId: string;
      secretRecordFingerprint: string;
      additionalCredentials?: readonly Readonly<{ slotId: string; secretId: string; secretRecordFingerprint: string }>[];
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
  /** Host-only material captured at this operation's admission, never a wire value. */
  admittedSnapshot?: ActiveAccountSettingsSnapshot;
  admittedOperationContext?: SavedSecretOperationContextV1;
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
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  connectionId: ProviderConnectionId | string;
  machineId: string;
  credentialSlotId: string;
  required: boolean;
  additionalCredentials?: readonly Readonly<{ slotId: string }>[];
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
  const materializer = input.savedSecretMaterializer ?? createSavedSecretMaterializerV1({
    accountSettings: input.accountSettings,
    settingsSecretsReadKeys: [],
    resources: input.savedSecretResources,
  });
  const inspected = materializer.inspect(secretId);
  if (
    inspected.status !== 'ready'
    || (inspected.source === 'personal' && inspected.storage !== 'settings_encrypted')
  ) {
    return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
  }
  const additionalCredentials: Array<{ slotId: string; secretId: string; secretRecordFingerprint: string }> = [];
  for (const { slotId } of input.additionalCredentials ?? []) {
    const additionalId = resolveProviderSecretBindingIdV1(input.providerSettings, input.connectionId, input.machineId, slotId);
    const additional = additionalId === null ? null : materializer.inspect(additionalId);
    if (!additionalId || !additional || additional.status !== 'ready'
      || (additional.source === 'personal' && additional.storage !== 'settings_encrypted')) {
      return { ok: false, error: createProviderErrorV1('provider_secret_missing', context) };
    }
    additionalCredentials.push({ slotId, secretId: additionalId, secretRecordFingerprint: additional.fingerprint });
  }
  return {
    ok: true,
    reference: {
      kind: 'apiKey',
      secretId,
      secretRecordFingerprint: inspected.fingerprint,
      ...(additionalCredentials.length ? { additionalCredentials } : {}),
    },
  };
}

export type ProviderResolvedCredential =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'apiKey'; value: string; additionalCredentials?: readonly Readonly<{ slotId: string; value: string }>[] }>;

/** One authority witness includes every bound record without changing the ticket shape. */
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
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean;
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
  return resolveProviderCredentialPlaintext({ ...input, reference: input.reference });
}

export function resolveProviderCredentialPlaintext(input: Readonly<{
  reference: Exclude<ProviderCredentialReference, { kind: 'team_direct' }>;
  accountSettings: unknown;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean;
  connectionId: ProviderConnectionId | string;
  machineId: string;
}>): ProviderCredentialPlaintextResultForSpawn {
  if (input.reference.kind === 'none') return { ok: true, credential: { kind: 'none' } };
  const context = { connectionId: input.connectionId, machineId: input.machineId };
  const materializer = input.savedSecretMaterializer ?? createSavedSecretMaterializerV1({
    accountSettings: input.accountSettings,
    settingsSecretsReadKeys: input.settingsSecretsReadKeys.filter((key): key is Uint8Array => key instanceof Uint8Array),
    resources: input.savedSecretResources,
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
  });
  const read = (reference: Readonly<{ secretId: string; secretRecordFingerprint: string }>) => {
    const current = materializer.inspect(reference.secretId);
    if (current.status !== 'ready' || current.fingerprint !== reference.secretRecordFingerprint) {
      return { ok: false as const, error: createProviderErrorV1('provider_authorization_changed', context) };
    }
    const resolved = materializer.resolve(reference.secretId);
    return resolved.status !== 'ready' || !resolved.value
      ? { ok: false as const, error: createProviderErrorV1('provider_secret_missing', context) }
      : { ok: true as const, value: resolved.value };
  };
  const primary = read(input.reference);
  if (!primary.ok) return primary;
  const additionalCredentials: Array<{ slotId: string; value: string }> = [];
  for (const additional of input.reference.additionalCredentials ?? []) {
    const material = read(additional);
    if (!material.ok) return material;
    additionalCredentials.push({ slotId: additional.slotId, value: material.value });
  }
  return { ok: true, credential: { kind: 'apiKey', value: primary.value,
    ...(additionalCredentials.length ? { additionalCredentials } : {}) } };
}
