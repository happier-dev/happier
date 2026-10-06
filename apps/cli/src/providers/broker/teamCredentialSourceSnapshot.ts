import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1, computeTeamCredentialConnectedAccountSourceVersionV1, computeTeamCredentialPoolMemberSourceVersionV1, computeTeamCredentialProviderCredentialSlotSourceVersionV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import type { TeamCredentialDirectMaterialPayloadV1, TeamCredentialSourceBindingV1, TeamCredentialSourceMemberV1 } from '@happier-dev/protocol/teams';

import type {
  QualifiedConnectedAccountMaterialSnapshot,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ProviderResolvedCredential } from '@/providers/spawn/credentials';
import type {
  ProviderConnectionBrokerSourceSnapshot,
} from './providerConnectionSource';

type ConnectedAccountSource = Extract<
  TeamCredentialSourceBindingV1,
  { kind: 'connected_account' }
>;
type ConnectedPoolSource = Extract<
  TeamCredentialSourceBindingV1,
  { kind: 'connected_pool' }
>;
type ProviderConnectionSource = Extract<
  TeamCredentialSourceBindingV1,
  { kind: 'provider_connection' }
>;
type DirectMaterial = TeamCredentialDirectMaterialPayloadV1['material'];

/**
 * Consumer-safe projection of one exact source snapshot. Mutable source facts
 * stay captured in the owner closure. Broker consumers receive only this
 * opaque member/version/currentness view; direct delivery receives material
 * separately through `TeamCredentialSourceSnapshot`.
 */
export type TeamCredentialSourceCurrentness = Readonly<{
  sourceMember: TeamCredentialSourceMemberV1;
  sourceVersion: string;
  isCurrent(): Promise<boolean>;
}>;

export type TeamCredentialSourceSnapshot<
  TMaterial extends DirectMaterial = DirectMaterial,
> = Readonly<{
  currentness: TeamCredentialSourceCurrentness;
  material: TMaterial;
}>;

type ConnectedAccountDirectMaterial = Extract<
  DirectMaterial,
  { kind: 'qualified_connected_account' }
>;
type ProviderDirectMaterial = Extract<
  DirectMaterial,
  { kind: 'provider_api_key' }
>;

function connectedAccountMember(
  account: QualifiedConnectedAccountRef,
): Extract<TeamCredentialSourceMemberV1, { kind: 'connected_account' }> {
  return Object.freeze({
    kind: 'connected_account',
    service: Object.freeze({ ...account.service }),
    connectedAccountId: account.accountId,
  });
}

function accountMaterial(
  snapshot: QualifiedConnectedAccountMaterialSnapshot,
): ConnectedAccountDirectMaterial {
  return Object.freeze({
    kind: 'qualified_connected_account',
    credential: snapshot.credential,
    configuration: snapshot.configuration,
    authenticationModeId: snapshot.authenticationModeId,
  });
}

function manualConnectedAccountVersion(input: Readonly<{
  account: QualifiedConnectedAccountRef;
  credentialIncarnation: string;
  member: Extract<TeamCredentialSourceMemberV1, { kind: 'connected_account' }>;
  material: QualifiedConnectedAccountMaterialSnapshot;
}>): string {
  const directContributionContract = computeCanonicalDomainSeparatedDigest(
    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
    [input.material.contributionContractVersion],
  );
  return computeTeamCredentialConnectedAccountSourceVersionV1({
    sourceAccountId: input.account.accountId,
    credentialIncarnation: input.credentialIncarnation,
    sourceMember: input.member,
    credentialRevision: input.material.credentialRevision,
    configurationRevision: input.material.configurationRevision,
    authenticationModeId: input.material.authenticationModeId,
    contributionContractVersion: directContributionContract,
    privateConfigurationFingerprint: input.material.serviceConfigurationFingerprint,
  });
}

function safeCurrent(check: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return Promise.resolve(check()).then(
      (current) => current === true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function createConnectedAccountTeamCredentialSourceSnapshot(input: Readonly<{
  source: ConnectedAccountSource;
  material: QualifiedConnectedAccountMaterialSnapshot;
  authenticationKind: 'manual' | 'oauth' | 'native';
  isPersistedSourceCurrent(source: ConnectedAccountSource): boolean | Promise<boolean>;
}>): TeamCredentialSourceSnapshot<ConnectedAccountDirectMaterial> | null {
  if (input.authenticationKind !== 'manual') return null;
  const account = input.source.target.account;
  const member = connectedAccountMember(account);
  const sourceVersion = manualConnectedAccountVersion({
    account,
    credentialIncarnation: input.source.credentialIncarnation,
    member,
    material: input.material,
  });
  const currentness = Object.freeze({
    sourceMember: member,
    sourceVersion,
    async isCurrent() {
      return await safeCurrent(async () => (
        await input.isPersistedSourceCurrent(input.source)
        && await input.material.isCurrent()
      ));
    },
  });
  return Object.freeze({
    currentness,
    material: accountMaterial(input.material),
  });
}

export function createConnectedPoolMemberTeamCredentialSourceSnapshot(input: Readonly<{
  source: ConnectedPoolSource;
  sourceAccount: QualifiedConnectedAccountRef;
  sourceCredentialIncarnation: string;
  memberEnabled: boolean;
  material: QualifiedConnectedAccountMaterialSnapshot;
  authenticationKind: 'manual' | 'oauth' | 'native';
  isPersistedSourceCurrent(source: ConnectedPoolSource): boolean | Promise<boolean>;
}>): TeamCredentialSourceSnapshot<ConnectedAccountDirectMaterial> | null {
  if (
    input.authenticationKind !== 'manual'
    || input.source.target.service.pluginId !== input.sourceAccount.service.pluginId
    || input.source.target.service.localId !== input.sourceAccount.service.localId
  ) {
    return null;
  }
  const member = connectedAccountMember(input.sourceAccount);
  const accountVersion = manualConnectedAccountVersion({
    account: input.sourceAccount,
    credentialIncarnation: input.sourceCredentialIncarnation,
    member,
    material: input.material,
  });
  const currentness = Object.freeze({
    sourceMember: member,
    sourceVersion: computeTeamCredentialPoolMemberSourceVersionV1({
      connectedAccountSourceVersion: accountVersion,
      poolIncarnation: input.source.poolIncarnation,
      memberEnabled: input.memberEnabled,
    }),
    async isCurrent() {
      if (!input.memberEnabled) return false;
      return await safeCurrent(async () => (
        await input.isPersistedSourceCurrent(input.source)
        && await input.material.isCurrent()
      ));
    },
  });
  return Object.freeze({
    currentness,
    material: accountMaterial(input.material),
  });
}

function stableHeaders(headers: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function createProviderConnectionTeamCredentialSourceSnapshot(input: Readonly<{
  sourceAccountId: string;
  expected: ProviderConnectionBrokerSourceSnapshot;
  resolvedCredential: ProviderResolvedCredential;
  isPersistedSourceCurrent(source: ProviderConnectionSource): boolean | Promise<boolean>;
  isProviderSourceCurrent(expected: ProviderConnectionBrokerSourceSnapshot): boolean | Promise<boolean>;
}>): TeamCredentialSourceSnapshot<ProviderDirectMaterial> | null {
  if (
    input.resolvedCredential.kind !== 'apiKey'
    || input.expected.credentialRef.reference.kind !== 'apiKey'
  ) {
    return null;
  }
  const source = input.expected.source;
  const member = Object.freeze({
    kind: 'provider_credential_slot' as const,
    connectionId: source.connectionId,
    credentialSlotId: source.credentialSlotId,
  });
  const providerConnectionRevision = computeCanonicalDomainSeparatedDigest(
    'happier.team-credential-provider-source-currentness.v1',
    [
      String(input.expected.connectionRevision),
      source.connectionSecurityFingerprint,
      input.expected.provider.identity.pluginId,
      input.expected.provider.identity.localId,
      String(input.expected.provider.definitionRevision),
      input.expected.endpointSetFingerprint,
      input.expected.grantFingerprint,
      input.expected.activationOccurrenceId ?? 'no-activation-occurrence',
      input.expected.endpoint.endpointTemplateId,
      input.expected.endpoint.normalizedUrl,
      input.expected.endpoint.protocol,
      stableHeaders(input.expected.endpoint.publicHeaders),
      input.expected.credentialRef.transport.id,
    ],
  );
  const currentness = Object.freeze({
    sourceMember: member,
    sourceVersion: computeTeamCredentialProviderCredentialSlotSourceVersionV1({
      sourceAccountId: input.sourceAccountId,
      sourceMember: member,
      providerConnectionRevision,
      machineBinding: input.expected.machineId,
      savedSecretFingerprint:
        input.expected.credentialRef.reference.secretRecordFingerprint,
      credentialTransport: 'api_key',
    }),
    async isCurrent() {
      return await safeCurrent(async () => (
        await input.isPersistedSourceCurrent(source)
        && await input.isProviderSourceCurrent(input.expected)
      ));
    },
  });
  return Object.freeze({
    currentness,
    material: Object.freeze({
      kind: 'provider_api_key',
      value: input.resolvedCredential.value,
      runtimeBinding: Object.freeze({
        provider: input.expected.provider,
        endpoint: Object.freeze({
          endpointTemplateId: input.expected.endpoint.endpointTemplateId,
          normalizedUrl: input.expected.endpoint.normalizedUrl,
          protocol: input.expected.endpoint.protocol,
          publicHeaders: input.expected.endpoint.publicHeaders,
        }),
        credentialTransport: input.expected.credentialRef.transport,
      }),
    }),
  });
}
