import { QualifiedConnectedAccountCredentialMetadataV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { QualifiedConnectedAccountCredentialPayloadV1Schema, QualifiedConnectedAccountCredentialSecretUnavailableError } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { parseQualifiedConnectedAccountCredentialPlaintextV1, projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ConnectedAccountSourceCustodyV1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { RequestAuthFailureOutcomeV1 } from '@happier-dev/protocol/connect/connected-account-request-auth';
import type { ConnectedServiceCredentialRevisionV1, JsonValue, PluginConnectedAccountAuthenticationModeV2, QualifiedConnectedAccountCredentialPayloadV1, QualifiedConnectedAccountConfigurationSnapshotV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { TeamCredentialDirectMaterialPayloadV1 } from '@happier-dev/protocol/teams';
import type { ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration } from './authenticationTypes.js';
import { createConnectedAccountConfigurationOwner, parseConnectedAccountConfigurationRecordContent, type ConnectedAccountConfigurationOwner, type ConnectedAccountConfigurationRecord, type ConnectedAccountConfigurationTarget } from './configurationOwner.js';
import { resolveQualifiedConnectedAccountCredentialSecrets as resolveCredentialSecrets } from './credentialMaterial.js';
import { projectConnectedAccountConfiguredEndpoints, type ConnectedAccountConfiguredEndpoint } from './configuredOrigins.js';
import type { ConnectedAccountRuntimeEstablishedInvocation, ConnectedAccountRuntimeEstablishedOperation, ConnectedAccountRuntimeEstablishedResult, ConnectedAccountRuntimeQuotaBase, ConnectedAccountEstablishedRuntimeInvoker } from './establishedRuntimeTypes.js';
import { QualifiedConnectedAccountMaterialError } from './materialError.js';
import { assertNotAborted, type ConnectedAccountEstablishedReadScope, type ConnectedAccountEstablishedPhaseObserver } from './establishedReadScope.js';
import { readCredentialRedactionValues } from '../plugins/http/credentialRedactionValues.js';

type ConnectedServiceAccountEncryptionMode = 'plain' | 'e2ee' | 'unknown';
type ConnectedAccountConfigurationSecrets = Parameters<typeof createConnectedAccountConfigurationOwner>[0]['secrets'];
export type ConnectedAccountEstablishedRuntimeRegistry<TQuota extends ConnectedAccountRuntimeQuotaBase = ConnectedAccountRuntimeQuotaBase> = Readonly<{
  connectedAccountContributions?: Readonly<{ describe(ref: QualifiedConnectedAccountRef['service']): ConnectedAccountEstablishedContribution | null }>;
  resolveConnectedAccountRuntime?(ref: QualifiedConnectedAccountRef['service']): Promise<(ConnectedAccountEstablishedContribution & Readonly<{ runtime: object }>) | null>;
  connectedAccountRuntimeInvoker?: ConnectedAccountEstablishedRuntimeInvoker<TQuota>;
}>;
type ConnectedAccountEstablishedContribution = Readonly<{
  ref: QualifiedConnectedAccountRef['service']; descriptor: import('@happier-dev/protocol').PluginConnectedAccountDescriptorContributionV2;
  occurrenceId: string; sourceCustody: ConnectedAccountSourceCustodyV1; isCurrent(): boolean;
}>;
type MaybePromise<T> = T | Promise<T>;
type ConnectedAccountCredentialReader =
  ConnectedAccountRuntimeEstablishedInvocation['context']['credentials'];

export type ConnectedAccountCredentialSnapshotReader = (input: Readonly<{ ref: QualifiedConnectedAccountRef; requestPurpose?: 'connected-accounts:qualification' | 'connected-accounts:purpose-binding'; signal?: AbortSignal }>) => Promise<QualifiedConnectedAccountCredentialSnapshotV4 | null>;
type CredentialSnapshotReader = ConnectedAccountCredentialSnapshotReader;
export type ConnectedAccountConfigurationSnapshotReader = (input: Readonly<{ target: Readonly<{ kind: 'account'; ref: QualifiedConnectedAccountRef }>; requestPurpose?: 'connected-accounts:qualification' | 'connected-accounts:purpose-binding'; signal?: AbortSignal }>) => Promise<QualifiedConnectedAccountConfigurationSnapshotV4 | null>;
type ConfigurationSnapshotReader = ConnectedAccountConfigurationSnapshotReader;
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
  /** Present when credential keys are Saved Secret held; changes when one of those records rotates. */
  credentialSecretFingerprint?: string;
  contributionContractVersion: string;
  isCurrent(): Promise<boolean>;
}>;

export type QualifiedConnectedAccountScheduledOperationOptions = Readonly<{
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
  expectedConfigurationRevision?: string | null;
  beforeInvoke?: (basis: Pick<QualifiedConnectedAccountEstablishedInvocationBasis,
    'credentialRevision' | 'credentialConfigurationRevision' | 'isCurrent'>) => MaybePromise<void>;
  signal?: AbortSignal;
}>;
export type QualifiedConnectedAccountScheduledReceipt<K extends 'status' | 'quota', TQuota extends ConnectedAccountRuntimeQuotaBase = ConnectedAccountRuntimeQuotaBase> = Readonly<{
  result: ConnectedAccountRuntimeEstablishedResult<Extract<ConnectedAccountRuntimeEstablishedOperation, { kind: K }>, TQuota>;
  basis: QualifiedConnectedAccountEstablishedInvocationBasis;
}>;

export type QualifiedConnectedAccountEstablishedRuntimeOwner<TQuota extends ConnectedAccountRuntimeQuotaBase = ConnectedAccountRuntimeQuotaBase> = Readonly<{
  /** One due-account preparation; each operation retains its independent effect guards. */
  invokeScheduledWithReceipts(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
    status?: QualifiedConnectedAccountScheduledOperationOptions;
    quota?: QualifiedConnectedAccountScheduledOperationOptions & Readonly<{
      assertProviderCallAllowed?: () => void;
    }>;
  }>): Promise<Readonly<{
    status?: PromiseSettledResult<QualifiedConnectedAccountScheduledReceipt<'status', TQuota>>;
    quota?: PromiseSettledResult<QualifiedConnectedAccountScheduledReceipt<'quota', TQuota>>;
  }>>;
  /** MCP challenges update the grant's configuration through its incumbent CAS owner, never its tokens. */
  recordScopeChallenge(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    requiredScopes: readonly string[];
    signal?: AbortSignal;
  }>): Promise<RequestAuthFailureOutcomeV1>;
  /** Account-scoped connection identity, independent of renewable bearer material. */
  readCredentialConfigurationRevision(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<string | null>;
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
  /** Provider-free quota capability and admitted source basis for host usage initialization. */
  readQuotaSourceSnapshot(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: string;
    configurationRevision: string | null;
    accountMode: 'plain' | 'e2ee';
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    credentialRevision: string;
    credentialConfigurationRevision: string | null;
    isCurrent(): Promise<boolean>;
  }> | null>;
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
  }>): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>>;
  invokeWithReceipt<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
      /** Host-private callback fence; never a public plugin capability field. */
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      expectedConfigurationRevision?: string | null;
      assertEffectfulOperationAllowed?: () => void;
      /** Synchronous quota admission at the provider leaf, after all preparation awaits. */
      assertProviderCallAllowed?: () => void;
      /** Lets the host establish usage before provider work under the admitted source basis. */
      beforeInvoke?: (basis: Pick<QualifiedConnectedAccountEstablishedInvocationBasis,
        'credentialRevision' | 'credentialConfigurationRevision' | 'isCurrent'>) => MaybePromise<void>;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{
    result: ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>>;
  invoke<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
      /** Host-private callback fence; never a public plugin capability field. */
      expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      expectedConfigurationRevision?: string | null;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>,
  ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>>;
}>;

export type QualifiedConnectedAccountEstablishedInvocationBasis = Readonly<{
  credentialRevision: string;
  /** Host-private public configuration strings, excluding actual secret collisions. */
  materializationPublicValues?: readonly string[];
  credentialHealth?: QualifiedConnectedAccountCredentialSnapshotV4['health'] | null;
  credentialConfigurationRevision: string | null;
  runtimeConfigurationRevision: string;
  occurrenceId: string;
  sourceCustody: ConnectedAccountSourceCustodyV1;
  isCurrent(): boolean;
  /** Freshly admits the captured Account mode before sealing a staged replacement. */
  prepareCredentialReplacement(
    mutation: QualifiedConnectedAccountCredentialMutationPreparationInput,
  ): MaybePromise<QualifiedConnectedAccountCredentialReplacementPreparation>;
}>;

export type QualifiedConnectedAccountCredentialMutationPreparationInput =
  Readonly<{
    set: Readonly<Record<string, string>>;
    delete: readonly string[];
    metadata?: Readonly<{
      providerIdentity?: QualifiedConnectedAccountCredentialSnapshotV4['metadata']['providerIdentity'];
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




function assertCredentialSnapshotIdentity(
  snapshot: QualifiedConnectedAccountCredentialSnapshotV4,
  account: QualifiedConnectedAccountRef,
): void {
  if (!sameQualifiedConnectedAccountRef(snapshot.ref, account)) {
    throw new QualifiedConnectedAccountMaterialError('credential_snapshot_identity_mismatch', 'Connected-account credential snapshot does not match the exact qualified account');
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
    throw new QualifiedConnectedAccountMaterialError('configuration_snapshot_identity_mismatch', 'Connected-account configuration snapshot does not match the exact qualified account');
  }
}

function requireRevisionedCredentialSnapshot(
  snapshot: QualifiedConnectedAccountCredentialSnapshotV4,
): asserts snapshot is RevisionedQualifiedConnectedAccountCredentialSnapshotV4 {
  if (snapshot.revisionSemantics !== 'revisioned') {
    throw new QualifiedConnectedAccountMaterialError('credential_snapshot_unfenced', 'Connected-account credential snapshot is unfenced');
  }
}

function requireCredentialAuthenticationMode(
  snapshot: RevisionedQualifiedConnectedAccountCredentialSnapshotV4,
): asserts snapshot is CredentialMaterialSnapshotV4 {
  if (!snapshot.authenticationModeId) {
    throw new QualifiedConnectedAccountMaterialError('credential_authentication_mode_unavailable', 'Connected-account authentication mode is unavailable in the current descriptor');
  }
}

function requireRevisionedConfigurationSnapshot(
  snapshot: QualifiedConnectedAccountConfigurationSnapshotV4,
): asserts snapshot is RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 {
  if (snapshot.revisionSemantics !== 'revisioned') {
    throw new QualifiedConnectedAccountMaterialError('configuration_snapshot_unfenced', 'Connected-account configuration snapshot is unfenced');
  }
}

function assertSnapshotPair(input: Readonly<{
  credential: RevisionedQualifiedConnectedAccountCredentialSnapshotV4;
  configuration: RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 | null;
}>): void {
  const { credential, configuration } = input;
  if (credential.configurationRevision === null) {
    if (configuration !== null) {
      throw new QualifiedConnectedAccountMaterialError('credential_snapshot_revision_mismatch', 'Connected-account snapshot revisions do not describe one exact account state');
    }
    return;
  }
  if (
    configuration === null
    || configuration.credentialRevision !== credential.credentialRevision
    || configuration.configurationRevision !== credential.configurationRevision
    || configuration.authenticationModeId !== credential.authenticationModeId
  ) {
    throw new QualifiedConnectedAccountMaterialError('credential_snapshot_revision_mismatch', 'Connected-account snapshot revisions do not describe one exact account state');
  }
}

async function resolveDirectMaterialConfiguration(
  record: ConnectedAccountConfigurationRecord | null,
  secrets: Pick<ConnectedAccountConfigurationSecrets, 'read' | 'readMaterial'>,
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
      throw new QualifiedConnectedAccountMaterialError('configuration_secret_unavailable', 'Connected-account configuration secret is unavailable');
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

type CredentialSecretReader = Pick<ConnectedAccountConfigurationSecrets, 'admit' | 'read' | 'readMaterial'>;

/** One Saved Secret held key, read when a consumer asks for it. */
async function readCredentialSecret(reference: string, secrets: CredentialSecretReader, signal?: AbortSignal): Promise<string> {
  const options = signal ? { signal } : undefined;
  const admitted = await secrets.admit([reference], options) ?? secrets;
  const value = await admitted.read(reference, options);
  if (typeof value !== 'string') throw new QualifiedConnectedAccountCredentialSecretUnavailableError();
  return value;
}

export function createConnectedAccountEstablishedRuntimeOwner<
  TQuota extends ConnectedAccountRuntimeQuotaBase,
  TRegistry extends ConnectedAccountEstablishedRuntimeRegistry<TQuota>,
>(params: Readonly<{
  reloadController: Readonly<{
    acquireRuntimeRegistry(): Promise<Readonly<{ registry: TRegistry; release(): Promise<void> }>>;
    isRuntimeRegistryCurrent(registry: TRegistry): boolean;
  }>;
  readScope: ConnectedAccountEstablishedReadScope;
  isAccountRuntimeCurrent?: (signal?: AbortSignal) => Promise<boolean>;
  runAccountOperation?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  getAccountEncryptionMode(signal?: AbortSignal, options?: Readonly<{ usage?: 'fresh-authority' }>): Promise<ConnectedServiceAccountEncryptionMode>;
  readCredential: CredentialSnapshotReader;
  readConfiguration: ConfigurationSnapshotReader;
  configuration: Readonly<{ read(target: ConnectedAccountConfigurationTarget): Promise<ConnectedAccountConfigurationRecord | null>; secrets: ConnectedAccountConfigurationSecrets }>;
  configurationOwner?: ConnectedAccountConfigurationOwner;
  openContent(input: Readonly<{ kind: 'credential' | 'configuration'; accountMode: 'plain' | 'e2ee'; envelope: QualifiedConnectedAccountCredentialSnapshotV4['content'] }>): unknown;
  sealCredentialContent(accountMode: 'plain' | 'e2ee', plaintext: unknown): QualifiedConnectedAccountCredentialSnapshotV4['content'];
  observePhase?: ConnectedAccountEstablishedPhaseObserver;
}>): QualifiedConnectedAccountEstablishedRuntimeOwner<TQuota> {
  const observeMaterializationPhase: ConnectedAccountEstablishedPhaseObserver = params.observePhase ?? (async (_phase, work) => work());
  const { isAccountRuntimeCurrent, assertAccountRuntimeCurrent, runMaterialization, runCurrentAccountRead, runIndependentAccountRead } = params.readScope;
  const credentialSnapshotReader =
    params.readCredential;
  const readCredential: CredentialSnapshotReader = (input) => observeMaterializationPhase(
    'established_credential_read', () => runCurrentAccountRead(() => credentialSnapshotReader(input), input.signal),
  );
  const configurationSnapshotReader =
    params.readConfiguration;
  const readConfiguration: ConfigurationSnapshotReader = (input) => observeMaterializationPhase(
    'established_configuration_read', () => runCurrentAccountRead(() => configurationSnapshotReader(input), input.signal),
  );
  async function readExactSnapshots(
    account: QualifiedConnectedAccountRef,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    credential: RevisionedQualifiedConnectedAccountCredentialSnapshotV4;
    configuration: RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 | null;
  }>> {
    assertNotAborted(signal);
    const credential = await readCredential({
      ref: account,
      requestPurpose: 'connected-accounts:purpose-binding',
      signal,
    });
    assertNotAborted(signal);
    if (!credential) {
      throw new QualifiedConnectedAccountMaterialError('credential_snapshot_unavailable', 'Connected-account credential snapshot is unavailable');
    }
    assertCredentialSnapshotIdentity(credential, account);
    requireRevisionedCredentialSnapshot(credential);
    const configuration = credential.configurationRevision === null
      ? null
      : await readConfiguration({
          target: accountTarget(account),
          requestPurpose: 'connected-accounts:purpose-binding',
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
      ref: input.account,
      requestPurpose: 'connected-accounts:qualification',
      signal: input.signal,
    });
    assertNotAborted(input.signal);
    if (!credential) {
      throw new QualifiedConnectedAccountMaterialError('credential_snapshot_unavailable', 'Connected-account credential snapshot is unavailable');
    }
    assertCredentialSnapshotIdentity(credential, input.account);
    requireRevisionedCredentialSnapshot(credential);
    return credential.credentialRevision;
  }

  async function readCredentialConfigurationRevision(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<string | null> {
    const snapshots = await readExactSnapshots(input.account, input.signal);
    return snapshots.credential.configurationRevision;
  }

  async function readMaterialSnapshot(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<QualifiedConnectedAccountMaterialSnapshot> {
    assertNotAborted(input.signal);
    const accountMode = await runCurrentAccountRead(() => params.getAccountEncryptionMode(input.signal), input.signal);
    if (accountMode === 'unknown') {
      throw new QualifiedConnectedAccountMaterialError('account_encryption_mode_unavailable', 'Connected-account account encryption mode is unavailable');
    }
    const resolvedAccountMode: Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'> = accountMode;
    const snapshots = await readExactSnapshots(input.account, input.signal);
    requireCredentialAuthenticationMode(snapshots.credential);
    const authenticationModeId = snapshots.credential.authenticationModeId;
    const storedCredential = parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: input.account,
      authenticationModeId,
      metadata: snapshots.credential.metadata,
      plaintext: params.openContent({
        kind: 'credential',
        accountMode,
        envelope: snapshots.credential.content,
      }),
    });
    const resolvedCredential = await resolveCredentialSecrets(storedCredential, params.configuration.secrets, input.signal);
    const credential = resolvedCredential.credential;
    const registryLease = await params.reloadController.acquireRuntimeRegistry();
    let contributionContractVersion: string;
    let mode: PluginConnectedAccountAuthenticationModeV2;
    let sourceCustody: ConnectedAccountSourceCustodyV1;
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
          : parseConnectedAccountConfigurationRecordContent(params.openContent({
              kind: 'configuration', accountMode: resolvedAccountMode,
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
        { ...record, values: admitted.snapshot.values }, admitted.secretReader ?? params.configuration.secrets, input.signal,
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
      ...(resolvedCredential.fingerprints.length ? {
        credentialSecretFingerprint: computeCanonicalDomainSeparatedDigest(
          'happier.connected-account-credential-secret-records.v1', [...resolvedCredential.fingerprints]),
      } : {}),
      contributionContractVersion,
      async isCurrent(): Promise<boolean> {
        if (input.signal?.aborted) return false;
        try {
          return await runMaterialization(async () => {
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
            if (resolvedCredential.fingerprints.length > 0) {
              const latestCredential = await resolveCredentialSecrets(storedCredential, params.configuration.secrets, input.signal);
              if (JSON.stringify(latestCredential.fingerprints) !== JSON.stringify(resolvedCredential.fingerprints)) return false;
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
          }, input.signal);
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
      expectedConfigurationRevision?: string | null;
      assertEffectfulOperationAllowed?: () => void;
      assertProviderCallAllowed?: () => void;
      beforeInvoke?: (basis: Pick<QualifiedConnectedAccountEstablishedInvocationBasis,
        'credentialRevision' | 'credentialConfigurationRevision' | 'isCurrent'>) => MaybePromise<void>;
      signal?: AbortSignal;
    }>,
    scheduledInitial?: ReturnType<typeof readExactSnapshots>,
  ): Promise<Readonly<{
    result: ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>> {
      assertNotAborted(input.signal);
      const accountMode = await observeMaterializationPhase('established_account_mode',
        () => runCurrentAccountRead(() => params.getAccountEncryptionMode(input.signal), input.signal));
      if (accountMode === 'unknown') {
        throw new QualifiedConnectedAccountMaterialError('account_encryption_mode_unavailable', 'Connected-account account encryption mode is unavailable');
      }
      const initial = await (scheduledInitial
        ?? observeMaterializationPhase('established_snapshots', () => readExactSnapshots(input.account, input.signal)));
      if (input.expectedConfigurationRevision !== undefined
        && initial.credential.configurationRevision !== input.expectedConfigurationRevision) {
        throw new Error('Connected-account configuration revision is no longer current');
      }
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
      let observedCredentialHealth = initial.credential.health ?? null;
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
        plaintext: params.openContent({
          kind: 'credential',
          accountMode,
          envelope: initial.credential.content,
        }),
      });
      const lease = await observeMaterializationPhase('established_registry', () => params.reloadController.acquireRuntimeRegistry());
      try {
        if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
          throw new Error('Connected-account runtime registry is no longer current');
        }
        const runtimeLease = await observeMaterializationPhase('established_runtime_resolution', () =>
          lease.registry.resolveConnectedAccountRuntime?.(input.account.service));
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
        const initialConfigurationRecord: ConnectedAccountConfigurationRecord | null = await observeMaterializationPhase(
          'established_configuration_record', async () =>
          exactConfigurationTarget.kind === 'account'
            ? initial.configuration
            ? parseConnectedAccountConfigurationRecordContent(
                params.openContent({
                  kind: 'configuration',
                  accountMode,
                  envelope: initial.configuration.configurationContent,
                }),
                initial.configuration.configurationRevision,
              )
              : null
            : descriptorConfiguration
              ? await params.configuration.read(exactConfigurationTarget)
              : null);
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
              const configuration = await readConfiguration({
                target: accountTarget(input.account),
                requestPurpose: 'connected-accounts:purpose-binding',
                signal: input.signal,
              });
              if (!configuration) return null;
              assertConfigurationSnapshotIdentity(configuration, input.account);
              requireRevisionedConfigurationSnapshot(configuration);
              // The parallel credential guard verifies that this admitted pair's
              // credential and configuration revisions still address the current row.
              assertSnapshotPair({ credential: initial.credential, configuration });
              return parseConnectedAccountConfigurationRecordContent(
                params.openContent({
                  kind: 'configuration',
                  accountMode,
                  envelope: configuration.configurationContent,
                }),
                configuration.configurationRevision,
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
        const admittedConfiguration = await observeMaterializationPhase('established_configuration', () => configurationOwner.admit({
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
        }));
        if (admittedConfiguration.status !== 'ready') {
          throw new Error('Connected-account established configuration is unavailable');
        }
        const baseConfiguration = admittedConfiguration.snapshot;
        const materializationSecrets = new Set<string>();
        const observeSecret = (value: string | null): string | null => {
          if (input.operation.kind === 'materialize' && value !== null) {
            for (const variant of readCredentialRedactionValues({ rawCredential: value, authorizationValue: value })) {
              materializationSecrets.add(variant);
            }
          }
          return value;
        };
        for (const value of Object.values(credentialPayload.values)) observeSecret(value);
        for (const value of Object.values(initialConfigurationRecord?.secretValues ?? {})) observeSecret(value);
        const exactConfiguration: PluginConnectedAccountRuntimeConfiguration =
          params.isAccountRuntimeCurrent || params.runAccountOperation || input.signal || input.operation.kind === 'materialize'
            ? Object.freeze<PluginConnectedAccountRuntimeConfiguration>({
                ...baseConfiguration,
                getSecret: async (fieldId, options) => observeSecret(await runCurrentAccountRead(() => baseConfiguration.getSecret(fieldId, {
                  ...options,
                  signal: options?.signal ?? input.signal,
                }), input.signal)),
              })
            : baseConfiguration;
        const credentialReader: ConnectedAccountCredentialReader =
          Object.freeze({
            async get(key, options) {
              assertNotAborted(options?.signal ?? input.signal);
              await assertAccountRuntimeCurrent(input.signal);
              const reference = credentialPayload.secretRefs?.[key];
              if (reference) {
                return observeSecret(await runCurrentAccountRead(() => readCredentialSecret(reference, params.configuration.secrets,
                  options?.signal ?? input.signal), input.signal));
              }
              return credentialPayload.values[key] ?? null;
            },
          });
        const runtimeConfigurationRevision =
          exactConfiguration.revision;
        const isCurrent = () => (
          params.reloadController.isRuntimeRegistryCurrent(lease.registry)
          && runtimeLease.isCurrent()
        );

        input.assertEffectfulOperationAllowed?.();
        if (input.beforeInvoke) {
          assertNotAborted(input.signal);
          await assertAccountRuntimeCurrent(input.signal);
          if (!isCurrent()) {
            throw new Error('Connected-account runtime generation is no longer current');
          }
          await input.beforeInvoke(Object.freeze({
            credentialRevision: initial.credential.credentialRevision,
            credentialConfigurationRevision: initial.credential.configurationRevision,
            isCurrent,
          }));
          assertNotAborted(input.signal);
        }
        const result = await observeMaterializationPhase('established_runtime', () => runCurrentAccountRead(() => invoker.invokeEstablished({
          target: Object.freeze({
            account: input.account,
            expectedCredentialRevision,
            expectedRuntimeConfigurationRevision:
              runtimeConfigurationRevision,
          }),
          operation: input.operation,
          assertProviderCallAllowed: input.assertProviderCallAllowed,
          context: Object.freeze({
            account: input.account,
            configuration: exactConfiguration,
            credentials: credentialReader,
          }),
          async isConfigurationCurrent(configuration) {
            if (configuration !== exactConfiguration) return false;
            if (!await isAccountRuntimeCurrent(input.signal)) return false;
            return configurationOwner.isCurrent(baseConfiguration);
          },
          configurationRevocationSignal(configuration) {
            return configuration === exactConfiguration
              ? configurationOwner.currentnessSignal(baseConfiguration)
              : AbortSignal.abort(
                  Object.freeze({ kind: 'configurationUnknown' as const }),
                );
          },
          async isCredentialRevisionCurrent() {
            // readCredential fences requester authority before and after transport.
            const latest = await readCredential({
              ref: input.account,
              requestPurpose: 'connected-accounts:purpose-binding',
              signal: input.signal,
            });
            if (
              !latest
              || !sameQualifiedConnectedAccountRef(latest.ref, input.account)
              || latest.revisionSemantics !== 'revisioned'
              || latest.credentialRevision !== expectedCredentialRevision
              // The credential row owns both revisions. Check their linkage in
              // this read rather than reopening it in the parallel configuration guard.
              || latest.configurationRevision !== initial.credential.configurationRevision
            ) return false;
            // Health can change without replacing either revision. Carry the
            // already-required final read into status settlement as well.
            observedCredentialHealth = latest.health ?? null;
            return true;
          },
          ...(input.signal ? { signal: input.signal } : {}),
        }), input.signal));
        const publicValues = new Set<string>();
        const collectPublicStrings = (value: JsonValue): void => {
          if (typeof value === 'string') {
            if (value.length > 0 && ![...materializationSecrets].some(secret => value.includes(secret))) publicValues.add(value);
          } else if (value !== null && typeof value === 'object') {
            for (const child of Object.values(value)) collectPublicStrings(child);
          }
        };
        if (input.operation.kind === 'materialize') {
          for (const value of Object.values(baseConfiguration.values)) collectPublicStrings(value);
        }
        return Object.freeze({
          result,
          basis: Object.freeze({
            credentialRevision: initial.credential.credentialRevision,
            ...(input.operation.kind === 'materialize' ? { materializationPublicValues: Object.freeze([...publicValues]) } : {}),
            credentialHealth: observedCredentialHealth,
            credentialConfigurationRevision:
              initial.credential.configurationRevision,
            runtimeConfigurationRevision,
            occurrenceId: runtimeLease.occurrenceId,
            sourceCustody: runtimeLease.sourceCustody,
            isCurrent,
            async prepareCredentialReplacement(
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
              // A Saved Secret held key keeps its one record; a runtime write never inlines a copy beside it.
              const secretRefs = Object.fromEntries(Object.entries(credentialPayload.secretRefs ?? {})
                .filter(([key]) => !deletedKeys.has(key)));
              if (Object.keys(stagedPayload.values).some(key => Object.hasOwn(secretRefs, key))) {
                throw new Error('Connected-account credential mutation cannot replace a Saved Secret held key');
              }
              const payload =
                QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
                  v: 1,
                  values: {
                    ...replacementValues,
                    ...stagedPayload.values,
                  },
                  ...(Object.keys(secretRefs).length ? { secretRefs } : {}),
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
              const currentMode = await runCurrentAccountRead(() => params.getAccountEncryptionMode(input.signal, { usage: 'fresh-authority' }), input.signal);
              assertNotAborted(input.signal);
              if (currentMode !== accountMode || !isCurrent()) {
                throw new Error('Connected-account credential mutation basis is no longer current');
              }
              const content = params.sealCredentialContent(accountMode, plaintext);
              return Object.freeze({
                authenticationModeId,
                content,
                metadata,
              });
            },
          }),
        });
      } finally {
        await observeMaterializationPhase('established_registry_release', () => lease.release());
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
  }>): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>> {
    assertNotAborted(input.signal);
    await assertAccountRuntimeCurrent(input.signal);
    if (!await input.isCurrent()) throw new QualifiedConnectedAccountMaterialError('connected_account_runtime_not_current', 'connected_account_runtime_not_current');
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
          await assertAccountRuntimeCurrent(input.signal);
          if (!await input.isCurrent()) throw new QualifiedConnectedAccountMaterialError('connected_account_runtime_not_current', 'connected_account_runtime_not_current');
          return input.material.configuration?.secretValues[fieldId] ?? null;
        },
      });
      const credentials: ConnectedAccountCredentialReader = Object.freeze({
        async get(key) {
          await assertAccountRuntimeCurrent(input.signal);
          if (!await input.isCurrent()) throw new QualifiedConnectedAccountMaterialError('connected_account_runtime_not_current', 'connected_account_runtime_not_current');
          return input.material.credential.values[key] ?? null;
        },
      });
      return await runCurrentAccountRead(async () => {
        if (!await input.isCurrent()) throw new QualifiedConnectedAccountMaterialError('connected_account_runtime_not_current', 'connected_account_runtime_not_current');
        return await invoker.invokeEstablished({
          target: Object.freeze({
            account: input.account,
            expectedCredentialRevision: input.sourceVersion,
            expectedRuntimeConfigurationRevision: input.sourceVersion,
          }),
          operation: input.operation,
          context: Object.freeze({ account: input.account, configuration, credentials }),
          isConfigurationCurrent: async (candidate) => candidate === configuration
            && await isAccountRuntimeCurrent(input.signal) && await input.isCurrent(),
          isCredentialRevisionCurrent: async () => await isAccountRuntimeCurrent(input.signal)
            && await input.isCurrent(),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }, input.signal);
    } finally {
      await lease.release();
    }
  }

  async function readConfiguredEndpoints(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    signal?: AbortSignal;
  }>): Promise<readonly ConnectedAccountConfiguredEndpoint[]> {
    assertNotAborted(input.signal);
    const accountMode = await runCurrentAccountRead(() => params.getAccountEncryptionMode(input.signal), input.signal);
    if (accountMode === 'unknown') {
      throw new QualifiedConnectedAccountMaterialError('account_encryption_mode_unavailable', 'Connected-account account encryption mode is unavailable');
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
                params.openContent({
                  kind: 'configuration',
                  accountMode,
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

  async function readQuotaSourceSnapshot(
    input: Parameters<QualifiedConnectedAccountEstablishedRuntimeOwner<TQuota>['readQuotaSourceSnapshot']>[0],
  ) {
    const materialSnapshot = await readMaterialSnapshot({ account: input.account, signal: input.signal });
    if (materialSnapshot.credentialRevision !== input.credentialRevision
      || materialSnapshot.configurationRevision !== input.configurationRevision
      || await params.getAccountEncryptionMode(input.signal, { usage: 'fresh-authority' }) !== input.accountMode) return null;
    const lease = await params.reloadController.acquireRuntimeRegistry();
    try {
      const runtimeLease = await lease.registry.resolveConnectedAccountRuntime?.(input.account.service);
      if (!runtimeLease || !('quota' in runtimeLease.runtime) || !runtimeLease.runtime.quota
        || runtimeLease.occurrenceId !== materialSnapshot.contributionContractVersion
        || !sameService(runtimeLease.ref, input.account.service)) return null;
      const isCurrent = async () => {
        if (!await materialSnapshot.isCurrent()
          || await params.getAccountEncryptionMode(input.signal, { usage: 'fresh-authority' }) !== input.accountMode) return false;
        // Recheck the synchronous generation fence after every asynchronous read.
        return params.reloadController.isRuntimeRegistryCurrent(lease.registry)
          && runtimeLease.isCurrent();
      };
      if (!await isCurrent()) return null;
      return Object.freeze({
        credentialRevision: materialSnapshot.credentialRevision,
        credentialConfigurationRevision: materialSnapshot.configurationRevision,
        isCurrent,
      });
    } finally {
      await lease.release();
    }
  }

  async function recordScopeChallenge(
    input: Parameters<QualifiedConnectedAccountEstablishedRuntimeOwner<TQuota>['recordScopeChallenge']>[0],
  ): Promise<RequestAuthFailureOutcomeV1> {
    assertNotAborted(input.signal);
    if (!sameService(input.account.service, HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1)
      || !params.configurationOwner) return { status: 'denied' };
    const accountMode = await params.getAccountEncryptionMode(input.signal);
    if (accountMode === 'unknown') return { status: 'denied' };
    const snapshots = await readExactSnapshots(input.account, input.signal);
    if (snapshots.credential.credentialRevision !== input.expectedCredentialRevision) return { status: 'stale_context' };
    if (!snapshots.configuration) return { status: 'denied' };
    const lease = await params.reloadController.acquireRuntimeRegistry();
    try {
      const contribution = lease.registry.connectedAccountContributions?.describe(input.account.service);
      const mode = contribution?.descriptor.authentication.modes.find(candidate => candidate.id === snapshots.credential.authenticationModeId);
      if (!contribution || contribution.sourceCustody.kind !== 'host' || !mode
        || !contribution.isCurrent() || !params.reloadController.isRuntimeRegistryCurrent(lease.registry)) return { status: 'stale_context' };
      const target = configurationTarget(input.account, mode);
      if (target.kind !== 'account') return { status: 'denied' };
      const record = parseConnectedAccountConfigurationRecordContent(params.openContent({
        kind: 'configuration', accountMode,
        envelope: snapshots.configuration.configurationContent,
      }), snapshots.configuration.configurationRevision);
      const previous = record.values.stepUpScopes;
      if (previous !== undefined && (!Array.isArray(previous) || previous.some(scope => typeof scope !== 'string'))) return { status: 'denied' };
      const scopes = [...new Set([...(Array.isArray(previous) ? previous : []), ...input.requiredScopes])];
      if (Array.isArray(previous) && scopes.length === previous.length) return { status: 'current_unchanged' };
      assertNotAborted(input.signal);
      // Recheck token custody immediately before the same configuration owner
      // performs its revision comparison and persistence operation.
      const current = await readExactSnapshots(input.account, input.signal);
      if (current.credential.credentialRevision !== input.expectedCredentialRevision) return { status: 'stale_context' };
      const result = await params.configurationOwner.replaceForControl({
        target, mode, expectedRevision: record.revision,
        values: { ...record.values, stepUpScopes: scopes }, secretValues: {},
        occurrenceId: contribution.occurrenceId, sourceCustody: contribution.sourceCustody,
      });
      return { status: result.status === 'committed' ? 'current_changed' : 'denied' };
    } finally { await lease.release(); }
  }

  const owner: QualifiedConnectedAccountEstablishedRuntimeOwner<TQuota> = {
    async invokeScheduledWithReceipts(input) {
      if (!input.status && !input.quota) return {};
      // This pair belongs only to this call. It is not retained by the owner or
      // reused at any subsequent operation's currentness/effect checkpoint.
      const initial = runIndependentAccountRead(() => observeMaterializationPhase(
        'established_snapshots', () => readExactSnapshots(input.account, input.signal)), input.signal);
      void initial.catch(() => {}); // Both independently cancelled operations may reject before awaiting it.
      const settled = <T>(work: Promise<T>): Promise<PromiseSettledResult<T>> => work.then(
        value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
      const [status, quota] = await Promise.all([
        input.status ? settled(runMaterialization(() => invokeWithReceipt({ account: input.account,
          operation: { kind: 'status' as const }, ...input.status }, initial), input.status.signal)) : undefined,
        input.quota ? settled(runIndependentAccountRead(() => invokeWithReceipt({ account: input.account,
          operation: { kind: 'quota' as const },
          ...input.quota }, initial), input.quota.signal ?? input.signal)) : undefined,
      ]);
      return { status, quota };
    },
    recordScopeChallenge: input => runIndependentAccountRead(() => recordScopeChallenge(input), input.signal),
    readCredentialConfigurationRevision: (input) => runIndependentAccountRead(() => readCredentialConfigurationRevision(input), input.signal),
    readCredentialRevision: (input) => runIndependentAccountRead(() => readCredentialRevision(input), input.signal),
    // Direct delivery and MCP resource checks prepare one snapshot through the
    // same entry/publication fences as runtime materialization. Public reentry
    // still starts a new admission; only its internal field readers share it.
    readMaterialSnapshot: (input) => runMaterialization(() => readMaterialSnapshot(input), input.signal),
    readQuotaSourceSnapshot: (input) => runIndependentAccountRead(() => readQuotaSourceSnapshot(input), input.signal),
    invokeDirectMaterial: (input) => runMaterialization(() => invokeDirectMaterial(input), input.signal),
    readConfiguredEndpoints: (input) => runIndependentAccountRead(() => readConfiguredEndpoints(input), input.signal),
    invokeWithReceipt: (input) => input.operation.kind === 'materialize' || input.operation.kind === 'status'
      ? runMaterialization(() => invokeWithReceipt(input), input.signal)
      : runIndependentAccountRead(() => invokeWithReceipt(input), input.signal),
    async invoke<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
      input: Readonly<{
        account: QualifiedConnectedAccountRef;
        operation: TOperation;
        expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
        expectedConfigurationRevision?: string | null;
        assertEffectfulOperationAllowed?: () => void;
        signal?: AbortSignal;
      }>,
    ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>> {
      return (await owner.invokeWithReceipt(input)).result;
    },
  };
  return Object.freeze(owner);
}
