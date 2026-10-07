import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { QualifiedConnectedAccountCredentialMetadataV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';

import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { QualifiedConnectedAccountCredentialPayloadV1Schema, openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedAccountCredentialPlaintextV1, projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { AccountScopedCryptoMaterial, ConnectedServiceCredentialRevisionV1, JsonValue, PluginConnectedAccountAuthenticationModeV2, QualifiedConnectedAccountCredentialPayloadV1, QualifiedConnectedAccountConfigurationSnapshotV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type {
  ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
  readQualifiedConnectedAccountConfigurationV4,
  readQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import {
  requireConnectedAccountCryptoMaterial as requireCryptoMaterial,
  resolveConnectedAccountCryptoMaterial as resolveCryptoMaterial,
} from './accountScopedCryptoMaterial';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import {
  createConnectedAccountConfigurationOwner,
  parseConnectedAccountConfigurationRecordContent,
  type ConnectedAccountConfigurationOwner,
  type ConnectedAccountConfigurationRecord,
  type ConnectedAccountConfigurationTarget,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import {
  projectConnectedAccountConfiguredEndpoints,
} from '@/plugins/runtime/connectedAccounts/configuredOrigins';
import type {
  ConnectedAccountConfiguredEndpoint,
} from '@/plugins/runtime/connectedAccounts/configuredOrigins';
import type {
  ConnectedAccountRuntimeEstablishedInvocation,
  ConnectedAccountRuntimeEstablishedOperation,
  ConnectedAccountRuntimeEstablishedResult,
} from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import type { TeamCredentialDirectMaterialPayloadV1 } from '@happier-dev/protocol/teams';

import type { ConnectedAccountDaemonPersistence } from './ConnectedAccountDaemonRuntime';

type MaybePromise<T> = T | Promise<T>;
type ConnectedAccountCredentialReader =
  ConnectedAccountRuntimeEstablishedInvocation['context']['credentials'];

type CredentialSnapshotReader = typeof readQualifiedConnectedAccountCredentialV4;
type ConfigurationSnapshotReader = typeof readQualifiedConnectedAccountConfigurationV4;
type QualifiedConnectedAccountCredentialSnapshotV4 = ReturnType<
  typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse
>;
type RevisionedQualifiedConnectedAccountCredentialSnapshotV4 = Extract<
  QualifiedConnectedAccountCredentialSnapshotV4,
  { revisionSemantics: 'revisioned' }
>;
type CredentialMaterialSnapshotV4 = RevisionedQualifiedConnectedAccountCredentialSnapshotV4
  & Readonly<{ authenticationModeId: string }>;
type RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 = Extract<
  QualifiedConnectedAccountConfigurationSnapshotV4,
  { revisionSemantics: 'revisioned' }
>;

export type QualifiedConnectedAccountMaterialSnapshot = Readonly<{
  credential: QualifiedConnectedAccountCredentialPayloadV1;
  configuration: Readonly<{
    values: Readonly<Record<string, JsonValue>>;
    secretValues: Readonly<Record<string, string>>;
  }> | null;
  authenticationModeId: string;
  credentialRevision: ConnectedServiceCredentialRevisionV1;
  configurationRevision: string | null;
  serviceConfigurationFingerprint?: string;
  contributionContractVersion: string;
  isCurrent(): Promise<boolean>;
}>;

export type QualifiedConnectedAccountEstablishedRuntimeOwner = Readonly<{
  /**
   * Host-private currentness read for the request-auth broker. It exposes no credential content
   * and does not invoke a plugin runtime.
   */
  readCredentialRevision(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceCredentialRevisionV1>;
  /**
   * Host-private projection of the incumbent configured-origin owner for one
   * exact account. It returns bounded, unique, host-normalized, credential-free
   * origins, exposes no credential or configuration content, selects no
   * preferred origin, and does not invoke a plugin runtime.
   */
  readConfiguredEndpoints(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<readonly ConnectedAccountConfiguredEndpoint[]>;
  /** Reads one exact source-owned credential/configuration snapshot for direct delivery. */
  readMaterialSnapshot(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<QualifiedConnectedAccountMaterialSnapshot>;
  /** Invokes the existing trusted contribution materializer over one opened,
   * recipient-scoped Team snapshot without creating a recipient source row. */
  invokeDirectMaterial<TOperation extends Extract<
    ConnectedAccountRuntimeEstablishedOperation,
    { kind: 'materialize' }
  >>(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    sourceVersion: string;
    material: Extract<TeamCredentialDirectMaterialPayloadV1['material'], { kind: 'qualified_connected_account' }>;
    operation: TOperation;
    isCurrent(): boolean | Promise<boolean>;
    signal?: AbortSignal;
  }>): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>>;
  invokeWithReceipt<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
      /** Host-private callback fence; never a public plugin capability field. */
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{
    result: ConnectedAccountRuntimeEstablishedResult<TOperation>;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>>;
  invoke<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
      /** Host-private callback fence; never a public plugin capability field. */
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>,
  ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>>;
}>;

export type QualifiedConnectedAccountEstablishedInvocationBasis = Readonly<{
  credentialRevision: string;
  credentialConfigurationRevision: string | null;
  runtimeConfigurationRevision: string;
  occurrenceId: string;
  sourceCustody: PluginSourceCustody;
  isCurrent(): boolean;
  prepareCredentialReplacement(
    mutation: QualifiedConnectedAccountCredentialMutationPreparationInput,
  ): QualifiedConnectedAccountCredentialReplacementPreparation;
}>;

export type QualifiedConnectedAccountCredentialMutationPreparationInput =
  Readonly<{
    set: Readonly<Record<string, string>>;
    delete: readonly string[];
    metadata?: Readonly<{
      displayName?: string;
      scopes?: readonly string[];
    }>;
  }>;

export type QualifiedConnectedAccountCredentialReplacementPreparation =
  Readonly<{
    authenticationModeId: string;
    content: QualifiedConnectedAccountCredentialSnapshotV4['content'];
    metadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'];
  }>;

function sameService(
  left: QualifiedConnectedAccountRef['service'],
  right: QualifiedConnectedAccountRef['service'],
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function accountTarget(account: QualifiedConnectedAccountRef) {
  return Object.freeze({
    kind: 'account' as const,
    ref: Object.freeze({
      service: Object.freeze({ ...account.service }),
      accountId: account.accountId,
    }),
  });
}

function configurationTarget(
  account: QualifiedConnectedAccountRef,
  mode: PluginConnectedAccountAuthenticationModeV2,
): Exclude<ConnectedAccountConfigurationTarget, { kind: 'attempt' }> {
  const descriptorConfiguration =
    'configuration' in mode ? mode.configuration : undefined;
  if (!descriptorConfiguration || descriptorConfiguration.scope === 'service') {
    return Object.freeze({
      kind: 'service',
      service: Object.freeze({ ...account.service }),
      modeId: mode.id,
    });
  }
  return Object.freeze({
    kind: 'account',
    account: Object.freeze({
      service: Object.freeze({ ...account.service }),
      accountId: account.accountId,
    }),
    modeId: mode.id,
  });
}


function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Connected-account established operation was aborted');
}

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
    throw new Error(`Connected-account ${input.kind} content is unavailable for the current account mode`);
  }
  return opened;
}

function assertCredentialSnapshotIdentity(
  snapshot: QualifiedConnectedAccountCredentialSnapshotV4,
  account: QualifiedConnectedAccountRef,
): void {
  if (!sameQualifiedConnectedAccountRef(snapshot.ref, account)) {
    throw new Error('Connected-account credential snapshot does not match the exact qualified account');
  }
}

function assertConfigurationSnapshotIdentity(
  snapshot: QualifiedConnectedAccountConfigurationSnapshotV4,
  account: QualifiedConnectedAccountRef,
): void {
  if (
    snapshot.target.kind !== 'account'
    || !sameQualifiedConnectedAccountRef(snapshot.target.ref, account)
  ) {
    throw new Error('Connected-account configuration snapshot does not match the exact qualified account');
  }
}

function requireRevisionedCredentialSnapshot(
  snapshot: QualifiedConnectedAccountCredentialSnapshotV4,
): asserts snapshot is RevisionedQualifiedConnectedAccountCredentialSnapshotV4 {
  if (snapshot.revisionSemantics !== 'revisioned') {
    throw new Error('Connected-account credential snapshot is unfenced');
  }
}

function requireCredentialAuthenticationMode(
  snapshot: RevisionedQualifiedConnectedAccountCredentialSnapshotV4,
): asserts snapshot is CredentialMaterialSnapshotV4 {
  if (!snapshot.authenticationModeId) {
    throw new Error('Connected-account authentication mode is unavailable in the current descriptor');
  }
}

/** Credential-only read for host consumers that do not need runtime configuration.
 * The qualified row, not a retained plaintext assertion, owns identity and mode. */
export async function readQualifiedConnectedAccountCredentialMaterial(input: Readonly<{
  credentials: StoredCredentials;
  account: QualifiedConnectedAccountRef;
  getAccountEncryptionMode(signal?: AbortSignal): Promise<ConnectedServiceAccountEncryptionMode>;
  readCredential?: CredentialSnapshotReader;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  snapshot: CredentialMaterialSnapshotV4;
  credential: QualifiedConnectedAccountCredentialPayloadV1;
  storageMode: 'plain' | 'e2ee';
}> | null> {
  assertNotAborted(input.signal);
  const accountMode = await input.getAccountEncryptionMode(input.signal);
  if (accountMode === 'unknown') {
    throw new Error('Connected-account account mode is unavailable');
  }
  const snapshot = await (input.readCredential ?? readQualifiedConnectedAccountCredentialV4)({
    token: input.credentials.token,
    ref: input.account,
    signal: input.signal,
  });
  assertNotAborted(input.signal);
  if (!snapshot) return null;
  assertCredentialSnapshotIdentity(snapshot, input.account);
  requireRevisionedCredentialSnapshot(snapshot);
  requireCredentialAuthenticationMode(snapshot);
  const credential = parseQualifiedConnectedAccountCredentialPlaintextV1({
    ref: input.account,
    authenticationModeId: snapshot.authenticationModeId,
    metadata: snapshot.metadata,
    plaintext: openEnvelope({
      kind: 'credential',
      accountMode,
      credentials: input.credentials,
      material: resolveCryptoMaterial(input.credentials),
      envelope: snapshot.content,
    }),
  });
  return Object.freeze({ snapshot, credential, storageMode: accountMode });
}

function requireRevisionedConfigurationSnapshot(
  snapshot: QualifiedConnectedAccountConfigurationSnapshotV4,
): asserts snapshot is RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 {
  if (snapshot.revisionSemantics !== 'revisioned') {
    throw new Error('Connected-account configuration snapshot is unfenced');
  }
}

function assertSnapshotPair(input: Readonly<{
  credential: RevisionedQualifiedConnectedAccountCredentialSnapshotV4;
  configuration: RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 | null;
}>): void {
  const { credential, configuration } = input;
  if (credential.configurationRevision === null) {
    if (configuration !== null) {
      throw new Error('Connected-account snapshot revisions do not describe one exact account state');
    }
    return;
  }
  if (
    configuration === null
    || configuration.credentialRevision !== credential.credentialRevision
    || configuration.configurationRevision !== credential.configurationRevision
    || configuration.authenticationModeId !== credential.authenticationModeId
  ) {
    throw new Error('Connected-account snapshot revisions do not describe one exact account state');
  }
}

async function resolveDirectMaterialConfiguration(
  record: ConnectedAccountConfigurationRecord | null,
  secrets: ConnectedAccountDaemonPersistence['configuration']['secrets'],
  signal?: AbortSignal,
): Promise<Readonly<{
  configuration: QualifiedConnectedAccountMaterialSnapshot['configuration'];
  fingerprints: readonly string[];
}>> {
  if (record === null) return { configuration: null, fingerprints: [] };
  const secretValues: Record<string, string> = { ...(record.secretValues ?? {}) };
  const fingerprints: string[] = [];
  for (const [fieldId, secretId] of Object.entries(record.secretRefs).sort(([left], [right]) => left.localeCompare(right))) {
    assertNotAborted(signal);
    const resolved = await secrets.readMaterial?.(secretId, signal ? { signal } : undefined);
    if (!resolved) {
      throw new Error('Connected-account configuration secret is unavailable');
    }
    secretValues[fieldId] = resolved.value;
    fingerprints.push(fieldId, resolved.fingerprint);
  }
  assertNotAborted(signal);
  return Object.freeze({
    configuration: Object.freeze({
      values: Object.freeze({ ...record.values }),
      secretValues: Object.freeze(secretValues),
    }),
    fingerprints: Object.freeze(fingerprints),
  });
}

export function createQualifiedConnectedAccountEstablishedRuntimeOwner(
  params: Readonly<{
    reloadController: Pick<
      PluginReloadController,
      'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
    >;
    credentials: StoredCredentials;
    getAccountEncryptionMode(signal?: AbortSignal): Promise<ConnectedServiceAccountEncryptionMode>;
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
  const readCredential =
    params.readCredential ?? readQualifiedConnectedAccountCredentialV4;
  const readConfiguration =
    params.readConfiguration ?? readQualifiedConnectedAccountConfigurationV4;
  const material = resolveCryptoMaterial(params.credentials);
  const randomBytes =
    params.randomBytes
    ?? ((length: number) => new Uint8Array(nodeRandomBytes(length)));

  async function readExactSnapshots(
    account: QualifiedConnectedAccountRef,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    credential: RevisionedQualifiedConnectedAccountCredentialSnapshotV4;
    configuration: RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 | null;
  }>> {
    assertNotAborted(signal);
    const credential = await readCredential({
      token: params.credentials.token,
      ref: account,
      signal,
    });
    assertNotAborted(signal);
    if (!credential) {
      throw new Error('Connected-account credential snapshot is unavailable');
    }
    assertCredentialSnapshotIdentity(credential, account);
    requireRevisionedCredentialSnapshot(credential);
    const configuration = credential.configurationRevision === null
      ? null
      : await readConfiguration({
          token: params.credentials.token,
          target: accountTarget(account),
          signal,
        });
    assertNotAborted(signal);
    if (configuration) {
      assertConfigurationSnapshotIdentity(configuration, account);
      requireRevisionedConfigurationSnapshot(configuration);
    }
    assertSnapshotPair({ credential, configuration });
    return Object.freeze({ credential, configuration });
  }

  async function readCredentialRevision(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceCredentialRevisionV1> {
    assertNotAborted(input.signal);
    const credential = await readCredential({
      token: params.credentials.token,
      ref: input.account,
      signal: input.signal,
    });
    assertNotAborted(input.signal);
    if (!credential) {
      throw new Error('Connected-account credential snapshot is unavailable');
    }
    assertCredentialSnapshotIdentity(credential, input.account);
    requireRevisionedCredentialSnapshot(credential);
    return credential.credentialRevision;
  }

  async function readMaterialSnapshot(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<QualifiedConnectedAccountMaterialSnapshot> {
    assertNotAborted(input.signal);
    const accountMode = await params.getAccountEncryptionMode(input.signal);
    if (accountMode === 'unknown') {
      throw new Error('Connected-account account encryption mode is unavailable');
    }
    const resolvedAccountMode: Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'> = accountMode;
    const snapshots = await readExactSnapshots(input.account, input.signal);
    requireCredentialAuthenticationMode(snapshots.credential);
    const authenticationModeId = snapshots.credential.authenticationModeId;
    const credential = parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: input.account,
      authenticationModeId,
      metadata: snapshots.credential.metadata,
      plaintext: openEnvelope({
        kind: 'credential',
        accountMode,
        credentials: params.credentials,
        material,
        envelope: snapshots.credential.content,
      }),
    });
    const registryLease = await params.reloadController.acquireRuntimeRegistry();
    let contributionContractVersion: string;
    let mode: PluginConnectedAccountAuthenticationModeV2;
    let sourceCustody: PluginSourceCustody;
    let isContributionCurrent: () => boolean;
    try {
      const contribution = registryLease.registry.connectedAccountContributions?.describe(input.account.service);
      const selectedMode = contribution?.descriptor.authentication.modes.find((candidate) => candidate.id === authenticationModeId);
      if (!contribution || !selectedMode || !contribution.isCurrent()
        || !params.reloadController.isRuntimeRegistryCurrent(registryLease.registry)) {
        throw new Error('Connected-account contribution contract is unavailable');
      }
      contributionContractVersion = contribution.occurrenceId;
      mode = selectedMode;
      sourceCustody = contribution.sourceCustody;
      isContributionCurrent = () => contribution.isCurrent()
        && params.reloadController.isRuntimeRegistryCurrent(registryLease.registry);
    } finally {
      await registryLease.release();
    }
    const target = configurationTarget(input.account, mode);
    const descriptorConfiguration = 'configuration' in mode ? mode.configuration : undefined;
    async function readConfigurationRecord(current: Awaited<ReturnType<typeof readExactSnapshots>>) {
      if (target.kind !== 'account' && current.configuration !== null) {
        throw new Error('Connected-account configuration sidecar does not match its descriptor scope');
      }
      return target.kind === 'service'
        ? descriptorConfiguration ? await params.configuration.read(target) : null
        : current.configuration === null ? null
          : parseConnectedAccountConfigurationRecordContent(openEnvelope({
              kind: 'configuration', accountMode: resolvedAccountMode, credentials: params.credentials, material,
              envelope: current.configuration.configurationContent,
            }), current.configuration.configurationRevision);
    }
    const configurationOwner = params.configurationOwner ?? createConnectedAccountConfigurationOwner({
      read: async () => readConfigurationRecord(await readExactSnapshots(input.account, input.signal)),
      replace: async () => ({ status: 'unavailable', code: 'connected_account_configuration_read_only' }),
      destroyAttempt: async () => {},
      secrets: params.configuration.secrets,
      isRuntimeCurrent: () => isContributionCurrent(),
    });
    async function resolveConfiguration(current: Awaited<ReturnType<typeof readExactSnapshots>>) {
      const record = await readConfigurationRecord(current);
      if (!descriptorConfiguration) return { configuration: null, serviceConfigurationFingerprint: undefined };
      // Use the ordinary configuration owner for required fields, defaults and
      // reference admission before creating the read-only direct projection.
      const admitted = await configurationOwner.admit({
        intent: 'reconnect', service: input.account.service, account: input.account,
        mode, occurrenceId: contributionContractVersion, sourceCustody,
        ...(record ? { expectedConfigurationRevision: record.revision } : {}),
      });
      if (admitted.status !== 'ready' || !record
        || admitted.snapshot.revision !== record.revision) {
        throw new Error('Connected-account established configuration is unavailable');
      }
      const resolved = await resolveDirectMaterialConfiguration(
        { ...record, values: admitted.snapshot.values }, params.configuration.secrets, input.signal,
      );
      return {
        configuration: resolved.configuration,
        ...(target.kind === 'service' && descriptorConfiguration ? {
          serviceConfigurationFingerprint: computeCanonicalDomainSeparatedDigest(
            'happier.team-credential-service-configuration.v1',
            [record?.revision ?? 'unconfigured', ...resolved.fingerprints],
          ),
        } : {}),
      };
    }
    const resolvedConfiguration = await resolveConfiguration(snapshots);
    const { configuration } = resolvedConfiguration;
    const current = await readExactSnapshots(input.account, input.signal);
    if (
      current.credential.credentialRevision
        !== snapshots.credential.credentialRevision
      || current.credential.configurationRevision
        !== snapshots.credential.configurationRevision
      || current.credential.authenticationModeId
        !== snapshots.credential.authenticationModeId
    ) {
      throw new Error('Connected-account material source changed during snapshot resolution');
    }
    assertNotAborted(input.signal);
    return Object.freeze({
      credential,
      configuration,
      authenticationModeId,
      credentialRevision: snapshots.credential.credentialRevision,
      configurationRevision: snapshots.credential.configurationRevision,
      ...(resolvedConfiguration.serviceConfigurationFingerprint ? {
        serviceConfigurationFingerprint: resolvedConfiguration.serviceConfigurationFingerprint,
      } : {}),
      contributionContractVersion,
      async isCurrent(): Promise<boolean> {
        if (input.signal?.aborted) return false;
        try {
          const latest = await readExactSnapshots(input.account, input.signal);
          if (
            latest.credential.credentialRevision
              !== snapshots.credential.credentialRevision
            || latest.credential.configurationRevision
              !== snapshots.credential.configurationRevision
            || latest.credential.authenticationModeId !== authenticationModeId
          ) {
            return false;
          }
          const latestConfiguration = await resolveConfiguration(latest);
          if (JSON.stringify(latestConfiguration) !== JSON.stringify(resolvedConfiguration)) {
            return false;
          }
          const latestRegistryLease = await params.reloadController.acquireRuntimeRegistry();
          try {
            const latestContribution = latestRegistryLease.registry.connectedAccountContributions?.describe(
              input.account.service,
            );
            return Boolean(
              latestContribution
              && latestContribution.occurrenceId === contributionContractVersion
              && latestContribution.isCurrent()
              && params.reloadController.isRuntimeRegistryCurrent(latestRegistryLease.registry),
            );
          } finally {
            await latestRegistryLease.release();
          }
        } catch {
          return false;
        }
      },
    });
  }

  async function invokeWithReceipt<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation,
  >(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
      /** Host-private callback fence; never a public plugin capability field. */
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{
    result: ConnectedAccountRuntimeEstablishedResult<TOperation>;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>> {
      assertNotAborted(input.signal);
      const accountMode = await params.getAccountEncryptionMode(input.signal);
      if (accountMode === 'unknown') {
        throw new Error('Connected-account account encryption mode is unavailable');
      }
      const initial = await readExactSnapshots(input.account, input.signal);
      const expectedCredentialRevision =
        input.expectedCredentialRevision ?? initial.credential.credentialRevision;
      if (
        input.expectedCredentialRevision !== undefined
        && initial.credential.credentialRevision !== input.expectedCredentialRevision
      ) {
        throw new Error('Connected-account credential revision is no longer current');
      }
      const authenticationModeId =
        initial.credential.authenticationModeId;
      if (!authenticationModeId) {
        throw new Error(
          'Connected-account authentication mode is unavailable in the current descriptor',
        );
      }
      const credentialPayload =
        parseQualifiedConnectedAccountCredentialPlaintextV1({
        ref: input.account,
        authenticationModeId,
        metadata: initial.credential.metadata,
        plaintext: openEnvelope({
          kind: 'credential',
          accountMode,
          credentials: params.credentials,
          material,
          envelope: initial.credential.content,
        }),
      });
      const lease = await params.reloadController.acquireRuntimeRegistry();
      try {
        if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
          throw new Error('Connected-account runtime registry is no longer current');
        }
        const runtimeLease = await lease.registry.resolveConnectedAccountRuntime?.(
          input.account.service,
        );
        const invoker = lease.registry.connectedAccountRuntimeInvoker;
        if (
          !runtimeLease
          || !invoker
          || !runtimeLease.isCurrent()
          || !sameService(runtimeLease.ref, input.account.service)
        ) {
          throw new Error('Connected-account established runtime is unavailable');
        }
        const mode = runtimeLease.descriptor.authentication.modes.find(
          (candidate) => candidate.id === authenticationModeId,
        );
        if (!mode) {
          throw new Error('Connected-account authentication mode is unavailable in the current descriptor');
        }
        const descriptorConfiguration =
          'configuration' in mode ? mode.configuration : undefined;
        if (
          initial.configuration
          && initial.configuration.authenticationModeId !== mode.id
        ) {
          throw new Error('Connected-account configuration authentication mode is stale');
        }
        if (
          (
            descriptorConfiguration?.scope === 'account'
            && initial.configuration === null
          )
          || (
            descriptorConfiguration?.scope !== 'account'
            && initial.configuration !== null
          )
        ) {
          throw new Error(
            'Connected-account configuration sidecar does not match its descriptor scope',
          );
        }

        const exactConfigurationTarget = configurationTarget(
          input.account,
          mode,
        );
        const initialConfigurationRecord: ConnectedAccountConfigurationRecord | null =
          exactConfigurationTarget.kind === 'account'
            ? initial.configuration
            ? parseConnectedAccountConfigurationRecordContent(
                openEnvelope({
                  kind: 'configuration',
                  accountMode,
                  credentials: params.credentials,
                  material,
                  envelope: initial.configuration.configurationContent,
                }),
                initial.configuration.configurationRevision,
              )
              : null
            : descriptorConfiguration
              ? await params.configuration.read(exactConfigurationTarget)
              : null;
        const configurationOwner: ConnectedAccountConfigurationOwner =
          params.configurationOwner ?? createConnectedAccountConfigurationOwner({
            async read(target) {
              if (target.modeId !== mode.id) return null;
              if (exactConfigurationTarget.kind === 'service') {
                if (
                  target.kind !== 'service'
                  || !sameService(target.service, exactConfigurationTarget.service)
                ) {
                  return null;
                }
                return descriptorConfiguration
                  ? await params.configuration.read(target)
                  : null;
              }
              if (
                target.kind !== 'account'
                || !sameQualifiedConnectedAccountRef(target.account, exactConfigurationTarget.account)
              ) {
                return null;
              }
              const latest = await readExactSnapshots(
                input.account,
                input.signal,
              );
              if (!latest.configuration) return null;
              return parseConnectedAccountConfigurationRecordContent(
                openEnvelope({
                  kind: 'configuration',
                  accountMode,
                  credentials: params.credentials,
                  material,
                  envelope: latest.configuration.configurationContent,
                }),
                latest.configuration.configurationRevision,
              );
            },
            async replace() {
              return Object.freeze({
                status: 'unavailable' as const,
                code: 'connected_account_configuration_read_only',
              });
            },
            async destroyAttempt() {},
            secrets: params.configuration.secrets,
            isRuntimeCurrent: () => (
              params.reloadController.isRuntimeRegistryCurrent(lease.registry)
              && runtimeLease.isCurrent()
            ),
          });
        const admittedConfiguration = await configurationOwner.admit({
          intent: 'reconnect',
          service: input.account.service,
          account: input.account,
          mode,
          occurrenceId: runtimeLease.occurrenceId,
          sourceCustody: runtimeLease.sourceCustody,
          ...(initialConfigurationRecord === null
            ? {}
            : {
                expectedConfigurationRevision:
                  initialConfigurationRecord.revision,
              }),
        });
        if (admittedConfiguration.status !== 'ready') {
          throw new Error('Connected-account established configuration is unavailable');
        }
        const baseConfiguration = admittedConfiguration.snapshot;
        const exactConfiguration: PluginConnectedAccountRuntimeConfiguration =
          baseConfiguration;
        const credentialReader: ConnectedAccountCredentialReader =
          Object.freeze({
            async get(key, options) {
              assertNotAborted(options?.signal ?? input.signal);
              return credentialPayload.values[key] ?? null;
            },
          });
        const runtimeConfigurationRevision =
          exactConfiguration.revision;

        input.assertEffectfulOperationAllowed?.();
        const result = await invoker.invokeEstablished({
          target: Object.freeze({
            account: input.account,
            expectedCredentialRevision,
            expectedRuntimeConfigurationRevision:
              runtimeConfigurationRevision,
          }),
          operation: input.operation,
          context: Object.freeze({
            account: input.account,
            configuration: exactConfiguration,
            credentials: credentialReader,
          }),
          async isConfigurationCurrent(configuration) {
            if (configuration !== exactConfiguration) return false;
            if (!await configurationOwner.isCurrent(baseConfiguration)) return false;
            const latest = await readExactSnapshots(input.account, input.signal);
            return latest.credential.configurationRevision
              === initial.credential.configurationRevision;
          },
          configurationRevocationSignal(configuration) {
            return configuration === exactConfiguration
              ? configurationOwner.currentnessSignal(baseConfiguration)
              : AbortSignal.abort(
                  Object.freeze({ kind: 'configurationUnknown' as const }),
                );
          },
          async isCredentialRevisionCurrent() {
            const latest = await readCredential({
              token: params.credentials.token,
              ref: input.account,
              signal: input.signal,
            });
            return Boolean(
              latest
              && sameQualifiedConnectedAccountRef(latest.ref, input.account)
              && latest.revisionSemantics === 'revisioned'
              && latest.credentialRevision === expectedCredentialRevision,
            );
          },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const isCurrent = () => (
          params.reloadController.isRuntimeRegistryCurrent(lease.registry)
          && runtimeLease.isCurrent()
        );
        return Object.freeze({
          result,
          basis: Object.freeze({
            credentialRevision: initial.credential.credentialRevision,
            credentialConfigurationRevision:
              initial.credential.configurationRevision,
            runtimeConfigurationRevision,
            occurrenceId: runtimeLease.occurrenceId,
            sourceCustody: runtimeLease.sourceCustody,
            isCurrent,
            prepareCredentialReplacement(
              mutation: QualifiedConnectedAccountCredentialMutationPreparationInput,
            ) {
              if (!isCurrent()) {
                throw new Error(
                  'Connected-account runtime generation is no longer current',
                );
              }
              const stagedPayload =
                QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
                  v: 1,
                  values: mutation.set,
                });
              if (mutation.delete.length > 64) {
                throw new Error(
                  'Connected-account credential mutation exceeds the 64-field deletion limit',
                );
              }
              const deletedKeys = new Set<string>();
              const forbiddenKeys = new Set([
                '__proto__',
                'constructor',
                'prototype',
              ]);
              for (const key of mutation.delete) {
                if (
                  typeof key !== 'string'
                  || key.length < 1
                  || key.length > 128
                  || forbiddenKeys.has(key)
                ) {
                  throw new Error(
                    'Connected-account credential mutation contains an invalid deletion key',
                  );
                }
                if (deletedKeys.has(key)) {
                  throw new Error(
                    'Connected-account credential mutation contains a duplicate deletion key',
                  );
                }
                if (Object.hasOwn(stagedPayload.values, key)) {
                  throw new Error(
                    'Connected-account credential mutation cannot set and delete the same key',
                  );
                }
                deletedKeys.add(key);
              }
              const replacementValues = {
                ...credentialPayload.values,
              };
              for (const key of deletedKeys) {
                delete replacementValues[key];
              }
              const payload =
                QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
                  v: 1,
                  values: {
                    ...replacementValues,
                    ...stagedPayload.values,
                  },
                });
              const metadata =
                QualifiedConnectedAccountCredentialMetadataV4Schema.parse({
                  ...initial.credential.metadata,
                  ...mutation.metadata,
                });
              const plaintext =
                projectQualifiedConnectedAccountCredentialPlaintextV1({
                  ref: input.account,
                  authenticationModeId,
                  payload,
                  metadata,
                  now: Date.now(),
                });
              const content = accountMode === 'plain'
                ? sealQualifiedConnectedAccountContentEnvelope({
                    kind: 'credential',
                    accountMode: 'plain',
                    payload: plaintext,
                    randomBytes,
                  })
                : sealQualifiedConnectedAccountContentEnvelope({
                    kind: 'credential',
                    accountMode: 'e2ee',
                    material: requireCryptoMaterial(
                      params.credentials,
                      material,
                    ),
                    payload: plaintext,
                    randomBytes,
                  });
              return Object.freeze({
                authenticationModeId,
                content,
                metadata,
              });
            },
          }),
        });
      } finally {
        await lease.release();
      }
  }

  async function invokeDirectMaterial<
    TOperation extends Extract<ConnectedAccountRuntimeEstablishedOperation, { kind: 'materialize' }>,
  >(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    sourceVersion: string;
    material: Extract<TeamCredentialDirectMaterialPayloadV1['material'], { kind: 'qualified_connected_account' }>;
    operation: TOperation;
    isCurrent(): boolean | Promise<boolean>;
    signal?: AbortSignal;
  }>): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>> {
    assertNotAborted(input.signal);
    const lease = await params.reloadController.acquireRuntimeRegistry();
    try {
      if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
        throw new Error('Connected-account runtime registry is no longer current');
      }
      const runtimeLease = await lease.registry.resolveConnectedAccountRuntime?.(input.account.service);
      const invoker = lease.registry.connectedAccountRuntimeInvoker;
      if (
        !runtimeLease
        || !invoker
        || !runtimeLease.isCurrent()
        || !sameService(runtimeLease.ref, input.account.service)
        || !runtimeLease.descriptor.authentication.modes.some(
          (mode) => mode.id === input.material.authenticationModeId,
        )
      ) {
        throw new Error('Connected-account direct material consumer is unavailable');
      }
      const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
        target: Object.freeze({
          kind: 'account' as const,
          account: input.account,
          modeId: input.material.authenticationModeId,
        }),
        revision: input.sourceVersion,
        values: Object.freeze({ ...(input.material.configuration?.values ?? {}) }),
        async getSecret(fieldId) {
          return input.material.configuration?.secretValues[fieldId] ?? null;
        },
      });
      const credentials: ConnectedAccountCredentialReader = Object.freeze({
        async get(key) {
          return input.material.credential.values[key] ?? null;
        },
      });
      return await invoker.invokeEstablished({
        target: Object.freeze({
          account: input.account,
          expectedCredentialRevision: input.sourceVersion,
          expectedRuntimeConfigurationRevision: input.sourceVersion,
        }),
        operation: input.operation,
        context: Object.freeze({ account: input.account, configuration, credentials }),
        isConfigurationCurrent: (candidate) => candidate === configuration && input.isCurrent(),
        isCredentialRevisionCurrent: input.isCurrent,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } finally {
      await lease.release();
    }
  }

  async function readConfiguredEndpoints(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<readonly ConnectedAccountConfiguredEndpoint[]> {
    assertNotAborted(input.signal);
    const accountMode = await params.getAccountEncryptionMode(input.signal);
    if (accountMode === 'unknown') {
      throw new Error('Connected-account account encryption mode is unavailable');
    }
    const initial = await readExactSnapshots(input.account, input.signal);
    const authenticationModeId = initial.credential.authenticationModeId;
    if (!authenticationModeId) {
      throw new Error(
        'Connected-account authentication mode is unavailable in the current descriptor',
      );
    }
    const lease = await params.reloadController.acquireRuntimeRegistry();
    try {
      if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
        throw new Error('Connected-account runtime registry is no longer current');
      }
      const runtimeLease = await lease.registry.resolveConnectedAccountRuntime?.(
        input.account.service,
      );
      if (
        !runtimeLease
        || !runtimeLease.isCurrent()
        || !sameService(runtimeLease.ref, input.account.service)
      ) {
        throw new Error('Connected-account established runtime is unavailable');
      }
      const mode = runtimeLease.descriptor.authentication.modes.find(
        (candidate) => candidate.id === authenticationModeId,
      );
      if (!mode) {
        throw new Error(
          'Connected-account authentication mode is unavailable in the current descriptor',
        );
      }
      const descriptorConfiguration =
        'configuration' in mode ? mode.configuration : undefined;
      if (!descriptorConfiguration) return Object.freeze([]);
      const exactConfigurationTarget = configurationTarget(input.account, mode);
      const record: ConnectedAccountConfigurationRecord | null =
        exactConfigurationTarget.kind === 'account'
          ? initial.configuration
            ? parseConnectedAccountConfigurationRecordContent(
                openEnvelope({
                  kind: 'configuration',
                  accountMode,
                  credentials: params.credentials,
                  material,
                  envelope: initial.configuration.configurationContent,
                }),
                initial.configuration.configurationRevision,
              )
            : null
          : await params.configuration.read(exactConfigurationTarget);
      assertNotAborted(input.signal);
      // An account that has never been configured owns no configured origin.
      // That is a truthful empty projection, not an elided one.
      if (!record) return Object.freeze([]);
      const endpoints = projectConnectedAccountConfiguredEndpoints({
        configuration: descriptorConfiguration,
        values: record.values,
      });
      if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
        throw new Error('Connected-account runtime registry is no longer current');
      }
      // One configured endpoint is one fact pair; deduping by base keeps two
      // deployments beneath one origin distinct.
      const byBase = new Map(endpoints.map((endpoint) => [endpoint.base, endpoint]));
      return Object.freeze(
        [...byBase.values()].sort((left, right) => (left.base < right.base ? -1 : 1)),
      );
    } finally {
      await lease.release();
    }
  }

  return Object.freeze({
    readCredentialRevision,
    readMaterialSnapshot,
    invokeDirectMaterial,
    readConfiguredEndpoints,
    invokeWithReceipt,
    async invoke<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
      input: Readonly<{
        account: QualifiedConnectedAccountRef;
        operation: TOperation;
        expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
        assertEffectfulOperationAllowed?: () => void;
        signal?: AbortSignal;
      }>,
    ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>> {
      return (await invokeWithReceipt(input)).result;
    },
  });
}
