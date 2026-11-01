import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import { createConnectedAccountEstablishedRuntimeOwner, readQualifiedConnectedAccountCredentialMaterial as readCredentialMaterial, type QualifiedConnectedAccountEstablishedRuntimeOwner as PortableEstablishedRuntimeOwner, type QualifiedConnectedAccountScheduledReceipt as PortableScheduledReceipt, type QualifiedConnectedAccountMaterialSnapshot, type QualifiedConnectedAccountScheduledOperationOptions, type QualifiedConnectedAccountEstablishedInvocationBasis, type QualifiedConnectedAccountCredentialMutationPreparationInput, type QualifiedConnectedAccountCredentialReplacementPreparation } from '@happier-dev/cli-common/connectedAccounts';
import { readQualifiedConnectedAccountConfigurationV4, readQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { requireConnectedAccountCryptoMaterial as requireCryptoMaterial, resolveConnectedAccountCryptoMaterial as resolveCryptoMaterial } from './accountScopedCryptoMaterial';
import type { AccountEncryptionModeReadOptions, ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ConnectedAccountDaemonPersistence } from './ConnectedAccountDaemonRuntime';
import type { ConnectedAccountConfigurationOwner } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { QualifiedConnectedAccountRef, QualifiedConnectedAccountCredentialPayloadV1 } from '@happier-dev/protocol';
import type { QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountConfigurationSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountMaterialError } from './qualifiedConnectedAccountMaterialError';
import { createAccountSettingsConnectedAccountSecrets } from './qualifiedConnectedAccountDaemonPersistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createEstablishedAccountReadScope } from './establishedAccountRead';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from './materialize/materializationPhase';
type CredentialSnapshotReader = typeof readQualifiedConnectedAccountCredentialV4;
type ConfigurationSnapshotReader = typeof readQualifiedConnectedAccountConfigurationV4;
type CredentialMaterialSnapshotV4 = Extract<QualifiedConnectedAccountCredentialSnapshotV4, { revisionSemantics: 'revisioned' }> & Readonly<{ authenticationModeId: string }>;
type CredentialSecretReader = Pick<ConnectedAccountDaemonPersistence['configuration']['secrets'], 'admit' | 'read' | 'readMaterial'>;
type Quota = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;
export type QualifiedConnectedAccountEstablishedRuntimeOwner = PortableEstablishedRuntimeOwner<Quota>;
export type QualifiedConnectedAccountScheduledReceipt<K extends 'status' | 'quota'> = PortableScheduledReceipt<K, Quota>;
export type { QualifiedConnectedAccountMaterialSnapshot, QualifiedConnectedAccountScheduledOperationOptions, QualifiedConnectedAccountEstablishedInvocationBasis, QualifiedConnectedAccountCredentialMutationPreparationInput, QualifiedConnectedAccountCredentialReplacementPreparation };
function openEnvelope(input: Readonly<{
  kind: 'credential' | 'configuration';
  accountMode: Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'>;
  credentials: StoredCredentials;
  material: AccountScopedCryptoMaterial | null;
  envelope:
    | QualifiedConnectedAccountCredentialSnapshotV4['content']
    | QualifiedConnectedAccountConfigurationSnapshotV4['configurationContent'];
}>): unknown {
  const opened = input.accountMode === 'plain'
    ? openQualifiedConnectedAccountContentEnvelope({
        kind: input.kind,
        accountMode: 'plain',
        envelope: input.envelope,
      })
    : openQualifiedConnectedAccountContentEnvelope({
        kind: input.kind,
        accountMode: 'e2ee',
        material: requireCryptoMaterial(input.credentials, input.material),
        envelope: input.envelope,
      });
  if (opened === null) {
    throw new QualifiedConnectedAccountMaterialError(input.kind === 'credential' ? 'credential_content_unavailable' : 'configuration_content_unavailable',
      `Connected-account ${input.kind} content is unavailable for the current account mode`);
  }
  return opened;
}

/** Credential-only read for host consumers that do not need runtime configuration.
 * The qualified row, not a retained plaintext assertion, owns identity and mode. */
export async function readQualifiedConnectedAccountCredentialMaterial(input: Readonly<{
  credentials: StoredCredentials;
  account: QualifiedConnectedAccountRef;
  getAccountEncryptionMode(signal?: AbortSignal): Promise<ConnectedServiceAccountEncryptionMode>;
  readCredential?: CredentialSnapshotReader;
  /** The daemon's Saved Secret catalog for keys held by reference; defaults to the active Account's. */
  secrets?: CredentialSecretReader;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  snapshot: CredentialMaterialSnapshotV4;
  credential: QualifiedConnectedAccountCredentialPayloadV1;
  storageMode: 'plain' | 'e2ee';
}> | null> {
  return await readCredentialMaterial({
    account: input.account,
    getAccountEncryptionMode: input.getAccountEncryptionMode,
    readCredential: ({ ref, signal }) => (input.readCredential ?? readQualifiedConnectedAccountCredentialV4)({
      token: input.credentials.token,
      ref,
      signal,
    }),
    openCredentialContent: (accountMode, envelope) => openEnvelope({
      kind: 'credential', accountMode, credentials: input.credentials,
      material: resolveCryptoMaterial(input.credentials), envelope,
    }),
    secrets: input.secrets ?? createAccountSettingsConnectedAccountSecrets({
      expectedScopeKey: resolveAccountSettingsScopeKey(input.credentials),
    }),
    signal: input.signal,
  });
}

/** Reads identity from the same admitted credential snapshot; renewable tokens are not identity. */
export function readQualifiedConnectedAccountCredentialIdentity(
  material: NonNullable<Awaited<ReturnType<typeof readQualifiedConnectedAccountCredentialMaterial>>>,
): Readonly<{ providerAccountId: string | null; providerOrganizationId: string | null; credentialRevision: string }> {
  return {
    providerAccountId: material.snapshot.metadata.providerIdentity?.accountId?.trim() || null,
    providerOrganizationId: material.snapshot.metadata.providerIdentity?.organizationId?.trim() || null,
    credentialRevision: material.snapshot.credentialRevision,
  };
}

export function createQualifiedConnectedAccountEstablishedRuntimeOwner(
  params: Readonly<{
    reloadController: Pick<
      PluginReloadController,
      'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
    >;
    credentials: StoredCredentials;
    isAccountRuntimeCurrent?: (signal?: AbortSignal) => Promise<boolean>;
    runAccountOperation?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
    getAccountEncryptionMode(signal?: AbortSignal, options?: AccountEncryptionModeReadOptions): Promise<ConnectedServiceAccountEncryptionMode>;
    readCredential?: CredentialSnapshotReader;
    readConfiguration?: ConfigurationSnapshotReader;
    configuration: Pick<
      ConnectedAccountDaemonPersistence['configuration'],
      'read' | 'secrets'
    >;
    configurationOwner?: ConnectedAccountConfigurationOwner;
    randomBytes?: (length: number) => Uint8Array;
  }>,
): QualifiedConnectedAccountEstablishedRuntimeOwner {

  const material = resolveCryptoMaterial(params.credentials);
  const randomBytes = params.randomBytes ?? ((length: number) => new Uint8Array(nodeRandomBytes(length)));
  return createConnectedAccountEstablishedRuntimeOwner<Quota, Awaited<ReturnType<PluginReloadController['acquireRuntimeRegistry']>>['registry']>({
    ...params,
    readScope: createEstablishedAccountReadScope(params),
    readCredential: input => (params.readCredential ?? readQualifiedConnectedAccountCredentialV4)({ ...input, token: params.credentials.token }),
    readConfiguration: input => (params.readConfiguration ?? readQualifiedConnectedAccountConfigurationV4)({ ...input, token: params.credentials.token }),
    openContent: input => openEnvelope({ ...input, credentials: params.credentials, material }),
    sealCredentialContent: (accountMode, payload) => accountMode === 'plain'
      ? sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload, randomBytes })
      : sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material: requireCryptoMaterial(params.credentials, material), payload, randomBytes }),
    observePhase: observeMaterializationPhase,
  });
}
