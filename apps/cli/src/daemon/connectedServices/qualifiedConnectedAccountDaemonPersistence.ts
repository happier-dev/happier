import {
  randomBytes as nodeRandomBytes,
  randomUUID,
} from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { ConnectedConfigurationCatalogV1Schema, openConnectedAccountCatalogContentV1,
  type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { replaceConnectedServiceConfigurationCatalogV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountCredentialMetadataV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { QualifiedConnectedAccountCredentialPayloadV1Schema, openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { parseQualifiedConnectedAccountCredentialPlaintextV1, projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { isStoredJsonContentEnvelopeModeCompatible } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { AccountScopedCryptoMaterial, ConnectedServiceCredentialRecordV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import { readHttpStatus } from '@/api/client/httpStatusError';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  QualifiedConnectedAccountCompatibilityError,
  QualifiedConnectedAccountCredentialConflictError,
  executeQualifiedConnectedAccountNegotiatedOperation,
  resolveQualifiedConnectedAccountOperationTransport,
  mutateQualifiedConnectedAccountConfigurationV4,
  mutateQualifiedConnectedAccountCredentialV4,
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountConfigurationV4,
  readQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type {
  SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { generatePkceCodes } from '@/cloud/pkce';
import { logger } from '@/ui/logger';
import type { StoredCredentials } from '@/persistence';
import {
  commitActiveConnectedAccountCatalog,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { promoteSavedSecretsWithConnectedAccountCatalog, refreshSavedSecretCatalogForOperation,
  type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import {
  createSavedSecretMaterializerFromSnapshotV1,
} from '@/settings/secrets/savedSecretCatalog';
import {
  parseConnectedAccountConfigurationRecordContent,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import type {
  ConnectedAccountDeviceTransactionOwner,
  ConnectedAccountOAuthTransaction,
  ConnectedAccountOAuthTransactionOwner,
  ConnectedAccountOAuthTransactionSnapshot,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';
import type { PendingConnectedAccountAttemptTransaction } from '@/api/client/connectedAccountAttemptTransactionApi';

import type { ConnectedAccountDaemonPersistence } from './ConnectedAccountDaemonRuntime';

type CredentialReader = typeof readQualifiedConnectedAccountCredentialV4;
type ConfigurationReader = typeof readQualifiedConnectedAccountConfigurationV4;
type CredentialMutator = typeof mutateQualifiedConnectedAccountCredentialV4;
type ConfigurationMutator = typeof mutateQualifiedConnectedAccountConfigurationV4;
type ProfileLister = typeof listQualifiedConnectedAccountsV4;
type ConfigurationReadTarget = Parameters<
  ConnectedAccountDaemonPersistence['configuration']['read']
>[0];
type ConfigurationReplaceInput = Parameters<
  ConnectedAccountDaemonPersistence['configuration']['replace']
>[0];
type ConfigurationReplaceForControlInput = Parameters<NonNullable<
  ConnectedAccountDaemonPersistence['configuration']['replaceForControl']
>>[0];
type ExactAccount = Parameters<
  ConnectedAccountDaemonPersistence['attempts']['accounts']['readExact']
>[0];
type OAuthTransaction = Awaited<ReturnType<
  ConnectedAccountDaemonPersistence['attempts']['oauth']['create']
>>;
type OAuthCompletion = Parameters<OAuthTransaction['acceptCompletion']>[0];
/**
 * Projects the server's named credential-refusal cause onto the settlement
 * contract. Only the causes that mean something different to the caller are
 * named here; an ordinary CAS race stays on the shared settlement-conflict path
 * so the existing reconciliation read-back still runs.
 */
function readQualifiedConnectedAccountCredentialSettlementCause(
  error: unknown,
): Readonly<{ status: 'conflict' | 'rejected'; code: string }> | null {
  if (!(error instanceof QualifiedConnectedAccountCredentialConflictError)) return null;
  switch (error.code) {
    case 'connect_reconnect_provider_identity_mismatch':
      return Object.freeze({
        status: 'conflict' as const,
        code: 'connected_account_reconnect_provider_identity_mismatch',
      });
    case 'connect_authentication_mode_mismatch':
      return Object.freeze({
        status: 'conflict' as const,
        code: 'connected_account_authentication_mode_mismatch',
      });
    default:
      return null;
  }
}

type SettlementRequest = Parameters<
  ConnectedAccountDaemonPersistence['attempts']['settlement']['settle']
>[0];
export type QualifiedConnectedAccountAttemptTransactionAdapters = Readonly<{
  oauth?: ConnectedAccountOAuthTransactionOwner;
  device?: ConnectedAccountDeviceTransactionOwner;
  listPending?(service: Readonly<{ pluginId: string; localId: string }>): Promise<readonly PendingConnectedAccountAttemptTransaction[]>;
}>;

const MAX_ATTEMPT_CONFIGURATION_RECORDS = 64;

type ConfigurationRecord = ReturnType<
  typeof parseConnectedAccountConfigurationRecordContent
>;
type ConfigurationContent = Omit<ConfigurationRecord, 'revision'>;
type AttemptConfigurationTarget = Extract<
  ConfigurationReadTarget,
  { kind: 'attempt' }
>;
type AttemptConfigurationEntry = Readonly<{
  target: AttemptConfigurationTarget;
  record: ConfigurationRecord;
}>;

function configurationContent(record: ConfigurationRecord): ConfigurationContent {
  return Object.freeze({
    values: record.values,
    secretRefs: record.secretRefs,
    ...(record.secretValues === undefined
      ? {}
      : { secretValues: record.secretValues }),
  });
}

function parsePhysicalConfigurationRecord(input: Readonly<{
  content: unknown;
  revision: string;
  scope: 'service' | 'account' | 'attempt';
}>): ConfigurationRecord {
  const record = parseConnectedAccountConfigurationRecordContent(
    input.content,
    input.revision,
  );
  if (input.scope === 'service' && record.secretValues !== undefined) {
    throw new Error(
      'Connected-account service configuration cannot contain inline secret bytes',
    );
  }
  if (
    input.scope !== 'service'
    && Object.keys(record.secretRefs).length > 0
  ) {
    throw new Error(
      'Connected-account account and attempt configuration cannot contain SavedSecret references',
    );
  }
  return record;
}

function cryptoMaterial(
  credentials: StoredCredentials,
): AccountScopedCryptoMaterial | null {
  if (!credentials.encryption) return null;
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function requireCryptoMaterial(
  credentials: StoredCredentials,
  material: AccountScopedCryptoMaterial | null,
): AccountScopedCryptoMaterial {
  if (material) return material;
  requireAccountEncryptionCredentials(credentials);
  throw new Error(
    'Account encryption credentials unexpectedly resolved without crypto material',
  );
}

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

function defaultRandomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

export function createActiveAccountSettingsConnectedAccountSecrets(input: Readonly<{
  /** The daemon's Account; admission never validates refs for another Account. */
  expectedScopeKey: string;
}>): ConnectedAccountDaemonPersistence['configuration']['secrets'] {
  return createAccountSettingsConnectedAccountSecrets(input);
}

/** Same configuration/Saved Secret authority, bound either to the daemon or an admitted Session. */
export function createAccountSettingsConnectedAccountSecrets(input: Readonly<{
  expectedScopeKey: string;
  operationContext?: SavedSecretOperationContextV1;
}>): ConnectedAccountDaemonPersistence['configuration']['secrets'] {
  const readSnapshot = input.operationContext ? () => input.operationContext!.readSnapshot() : getActiveAccountSettingsSnapshot;
  const readMaterial: NonNullable<ConnectedAccountDaemonPersistence['configuration']['secrets']['readMaterial']> = async (secretId, options) => {
    options?.signal?.throwIfAborted();
    if (input.operationContext && !await input.operationContext.isCurrent()) return null;
    const snapshot = readSnapshot();
    if (!snapshot || snapshot.scopeKey !== input.expectedScopeKey) return null;
    const resolved = createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent: () => readSnapshot() === snapshot }).resolve(secretId);
    if (resolved.status !== 'ready') return null;
    options?.signal?.throwIfAborted();
    return readSnapshot() === snapshot
      ? Object.freeze({ value: resolved.value, fingerprint: resolved.fingerprint })
      : null;
  };
  return Object.freeze({
    async admit(secretIds, options) {
      // A record without references has nothing to admit; the admission owner
      // itself resolves personal-only batches without a Home request.
      if (secretIds.length === 0) return;
      await refreshSavedSecretCatalogForOperation({
        expectedScopeKey: input.expectedScopeKey,
        ...(input.operationContext ? { operationContext: input.operationContext } : {}),
        references: secretIds.map((ref) => ({ ref })),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
    async has(secretId) {
      if (input.operationContext && !await input.operationContext.isCurrent()) return false;
      const snapshot = readSnapshot();
      return Boolean(
        snapshot
        && snapshot.scopeKey === input.expectedScopeKey
        && createSavedSecretMaterializerFromSnapshotV1(snapshot).inspect(secretId).status === 'ready',
      );
    },
    async read(secretId, options) {
      return (await readMaterial(secretId, options))?.value ?? null;
    },
    readMaterial,
  });
}

function openContent(input: Readonly<{
  kind: 'credential' | 'configuration';
  accountMode: Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'>;
  credentials: StoredCredentials;
  material: AccountScopedCryptoMaterial | null;
  envelope: Parameters<typeof openQualifiedConnectedAccountContentEnvelope>[0]['envelope'];
}>): unknown | null {
  return input.accountMode === 'plain'
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
}

function sealContent(input: Readonly<{
  kind: 'credential' | 'configuration';
  accountMode: Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'>;
  credentials: StoredCredentials;
  material: AccountScopedCryptoMaterial | null;
  payload: unknown;
  randomBytes(length: number): Uint8Array;
}>) {
  return input.accountMode === 'plain'
    ? sealQualifiedConnectedAccountContentEnvelope({
        kind: input.kind,
        accountMode: 'plain',
        payload: input.payload,
        randomBytes: input.randomBytes,
      })
    : sealQualifiedConnectedAccountContentEnvelope({
        kind: input.kind,
        accountMode: 'e2ee',
        material: requireCryptoMaterial(input.credentials, input.material),
        payload: input.payload,
        randomBytes: input.randomBytes,
      });
}

export function createQualifiedConnectedAccountDaemonPersistence(
  params: Readonly<{
    credentials: StoredCredentials;
    getAccountEncryptionMode(): Promise<ConnectedServiceAccountEncryptionMode>;
    readCredential?: CredentialReader;
    readConfiguration?: ConfigurationReader;
    mutateCredential?: CredentialMutator;
    mutateConfiguration?: ConfigurationMutator;
    listProfiles?: ProfileLister;
    resolveServerFeaturesSnapshot?: (
      ) => CliServerFeaturesSnapshot | undefined;
    resolveSessionSyncPendingInputServerContractResult?: (
      ) => SessionSyncPendingInputServerContractResult | null;
    secrets: ConnectedAccountDaemonPersistence['configuration']['secrets'];
    randomBytes?: (length: number) => Uint8Array;
    callbackUrl?: string;
    operationContext?: SavedSecretOperationContextV1;
    createConfigurationRevision?: () => string;
    createSecretId?: () => string;
    now?: () => number;
    attemptTransactions?: QualifiedConnectedAccountAttemptTransactionAdapters;
    onAccountSettled?: (input: Readonly<{
      account: QualifiedConnectedAccountRef;
      credentialRevision: string;
      configurationRevision: string | null;
      accountMode: 'plain' | 'e2ee';
    }>) => Promise<void>;
  }>,
): ConnectedAccountDaemonPersistence {
  const readCredential =
    params.readCredential ?? readQualifiedConnectedAccountCredentialV4;
  const readConfiguration =
    params.readConfiguration ?? readQualifiedConnectedAccountConfigurationV4;
  const mutateCredential =
    params.mutateCredential ?? mutateQualifiedConnectedAccountCredentialV4;
  const mutateConfiguration =
    params.mutateConfiguration ?? mutateQualifiedConnectedAccountConfigurationV4;
  const listProfiles =
    params.listProfiles ?? listQualifiedConnectedAccountsV4;
  const material = cryptoMaterial(params.credentials);
  const randomBytes = params.randomBytes ?? defaultRandomBytes;
  const createConfigurationRevision =
    params.createConfigurationRevision
    ?? (() => `connected-account-configuration-${randomUUID()}`);
  const createSecretId =
    params.createSecretId
    ?? (() => `connected-account-secret-${randomUUID()}`);
  const now = params.now ?? Date.now;
  const attemptConfigurations = new Map<string, AttemptConfigurationEntry>();
  const oauthTransactions = new Map<string, {
    snapshot: ConnectedAccountOAuthTransactionSnapshot;
    state: string;
    challenge: string;
    verifier: string;
    callbackUrl: string;
    consumed: boolean;
    closed: boolean;
  }>();

  function sameOAuthSnapshotIdentity(
    left: ConnectedAccountOAuthTransactionSnapshot,
    right: ConnectedAccountOAuthTransactionSnapshot,
  ): boolean {
    return left.attemptId === right.attemptId
      && left.createdAtMs === right.createdAtMs
      && left.intent === right.intent
      && sameService(left.service, right.service)
      && (
        left.account === undefined
          ? right.account === undefined
          : right.account !== undefined && sameQualifiedConnectedAccountRef(left.account, right.account)
      )
      && left.modeId === right.modeId
      && pluginSourceCustodyV1Equal(left.sourceCustody, right.sourceCustody)
      && left.expectedCredentialRevision === right.expectedCredentialRevision
      && left.expectedCredentialConfigurationRevision
        === right.expectedCredentialConfigurationRevision
      && left.expectedConfigurationRevision === right.expectedConfigurationRevision
      && isDeepStrictEqual(
        left.stagedAccountConfigurationContent,
        right.stagedAccountConfigurationContent,
      );
  }

  function createLocalOAuthTransactionHandle(
    record: NonNullable<ReturnType<typeof oauthTransactions.get>>,
  ): ConnectedAccountOAuthTransaction & Readonly<{
    snapshot: ConnectedAccountOAuthTransactionSnapshot;
  }> {
    return Object.freeze({
      get snapshot() {
        return record.snapshot;
      },
      request: Object.freeze({
        callbackUrl: record.callbackUrl,
        state: record.state,
        pkce: Object.freeze({
          challenge: record.challenge,
          method: 'S256' as const,
        }),
      }),
      acknowledge(snapshot) {
        if (
          record.closed
          || !sameOAuthSnapshotIdentity(record.snapshot, snapshot)
          || (
            record.snapshot.phase === 'outcomeUnknown'
            && snapshot.phase !== 'outcomeUnknown'
          )
          || (
            record.snapshot.phase === 'awaitingOAuth'
            && snapshot.phase === 'starting'
          )
        ) {
          throw new Error('Connected-account OAuth transaction acknowledgement is invalid');
        }
        record.snapshot = snapshot;
      },
      acceptCompletion(completion: OAuthCompletion) {
        if (
          record.closed
          || record.consumed
          || completion.state !== record.state
          || completion.callbackUrl !== record.callbackUrl
        ) {
          throw new Error('Connected-account OAuth completion does not match its transaction');
        }
        record.consumed = true;
        return Object.freeze({
          ...completion,
          pkceVerifier: record.verifier,
        });
      },
      close() {
        record.closed = true;
        if (oauthTransactions.get(record.snapshot.attemptId) === record) {
          oauthTransactions.delete(record.snapshot.attemptId);
        }
      },
    });
  }

  const localOAuthTransactionOwner: ConnectedAccountOAuthTransactionOwner =
    Object.freeze({
      async create(input) {
        if (
          input.attemptId !== input.snapshot.attemptId
          || !sameService(input.service, input.snapshot.service)
          || oauthTransactions.has(input.attemptId)
          || oauthTransactions.size >= MAX_ATTEMPT_CONFIGURATION_RECORDS
        ) {
          throw new Error('Connected-account OAuth transaction identity is unavailable');
        }
        const pkce = generatePkceCodes();
        const record = {
          snapshot: input.snapshot,
          state: Buffer.from(randomBytes(32)).toString('base64url'),
          challenge: pkce.challenge,
          verifier: pkce.verifier,
          callbackUrl:
            params.callbackUrl ?? 'http://localhost:1455/auth/callback',
          consumed: false,
          closed: false,
        };
        oauthTransactions.set(input.attemptId, record);
        return createLocalOAuthTransactionHandle(record);
      },
      read(attemptId) {
        const record = oauthTransactions.get(attemptId);
        return !record || record.closed
          ? null
          : createLocalOAuthTransactionHandle(record);
      },
    });

  async function readDurableAttemptConfiguration(
    target: Extract<ConfigurationReadTarget, { kind: 'attempt' }>,
  ): Promise<
    ReturnType<typeof parseConnectedAccountConfigurationRecordContent>
    | null
  > {
    const [oauthTransaction, deviceTransaction] = await Promise.all([
      params.attemptTransactions?.oauth?.read?.(target.attemptId) ?? null,
      params.attemptTransactions?.device?.read(target.attemptId) ?? null,
    ]);
    const snapshots = [
      oauthTransaction?.snapshot ?? null,
      deviceTransaction,
    ].filter((snapshot) => snapshot !== null);
    if (snapshots.length !== 1) return null;
    const snapshot = snapshots[0]!;
    if (
      snapshot.attemptId !== target.attemptId
      || !sameService(snapshot.service, target.service)
      || snapshot.modeId !== target.modeId
      || snapshot.stagedAccountConfigurationContent === undefined
    ) {
      return null;
    }
    return parsePhysicalConfigurationRecord({
      content: snapshot.stagedAccountConfigurationContent,
      revision: snapshot.expectedConfigurationRevision,
      scope: 'attempt',
    });
  }

  async function replaceServiceConfiguration(input: Readonly<{
    target: Extract<ConfigurationReadTarget, { kind: 'service' }>;
    expectedRevision: string | null;
    replacement: ConfigurationContent;
    currentSecretRefs?: Readonly<Record<string, string>>;
    secretValues?: Readonly<Record<string, string>>;
  }>) {
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
    const store = createCliConnectedAccountCatalogStore({ credentials: params.credentials,
      ...(params.operationContext ? { operationContext: params.operationContext } : {}) });
    let acknowledged = false;
    try {
      const catalog = await runWithServerHttpBaseUrl(store.serverHttpBaseUrl,
        () => readActiveConnectedAccountCatalog({ credentials: params.credentials, key: 'configurations',
          ...(params.operationContext ? { operationContext: params.operationContext } : {}) }));
      store.assertCurrent();
      if (catalog.status !== 'ready' || catalog.record.key !== 'configurations') throw new Error('Configuration catalog unavailable');
      const matchesTarget = (entry: typeof catalog.record.value.entries[number]) =>
        sameService(entry.service, input.target.service) && entry.modeId === input.target.modeId;
      const write = replaceConnectedServiceConfigurationCatalogV1({ catalog, target: input.target,
        expectedRevision: input.expectedRevision, values: input.replacement.values, secretRefs: input.replacement.secretRefs,
        secretValues: input.secretValues ?? {}, ...(input.currentSecretRefs ? { expectedSecretRefs: input.currentSecretRefs } : {}),
        createRevision: createConfigurationRevision, createSecretId });
      if (!write) {
        return { status: 'conflict' as const, code: 'connected_account_configuration_changed' };
      }
      const preparedSavedSecrets = write.newSecrets.map(({ id, fieldId, value }) => {
        const timestamp = now();
        return { id, record: SavedSecretSchema.parse({ id, name: `Connected Account ${fieldId}`.slice(0, 100), kind: 'other',
          encryptedValue: { _isSecretValue: true, value }, createdAt: timestamp, updatedAt: timestamp }) };
      });
      const record = write.record;
      const replacement = record.value.entries.find(matchesTarget)!;
      if (preparedSavedSecrets.length > 0) {
        const result = await runWithServerHttpBaseUrl(store.serverHttpBaseUrl,
          () => promoteSavedSecretsWithConnectedAccountCatalog({ credentials: params.credentials, preparedSavedSecrets,
            connectedAccountCatalog: { expectedRevision: catalog.revision, record },
            ...(params.operationContext ? { operationContext: params.operationContext } : {}) }));
        if (result.status !== 'applied') return { status: result.status === 'conflict' ? 'conflict' as const : 'unavailable' as const,
          code: result.status === 'conflict' ? 'connected_account_configuration_changed'
            : result.status === 'outcome_unknown' ? 'connected_account_configuration_outcome_unknown'
              : 'connected_account_configuration_persistence_unavailable' };
      } else {
        const result = await store.writeRecord({ expectedRevision: catalog.revision, record });
        if (result.status !== 'updated') return { status: result.status === 'conflict' ? 'conflict' as const : 'unavailable' as const,
          code: result.status === 'conflict' ? 'connected_account_configuration_changed' : 'connected_account_configuration_persistence_unavailable' };
      }
      acknowledged = true;
      // Promotion remaps prepared references at the shared SavedSecret owner.
      // Only the current canonical row may provide those committed bindings.
      const storage = await store.readStorageContext();
      const row = await store.readRow('configurations');
      if (row.status !== 'present') throw new Error('Committed configuration row unavailable');
      const opened = openConnectedAccountCatalogContentV1({ key: 'configurations', ...storage, content: row.content });
      if (opened.status !== 'opened' || opened.record.key !== 'configurations') throw new Error('Committed configuration row unavailable');
      const entry = opened.record.value.entries.find(candidate => sameService(candidate.service, input.target.service)
        && candidate.modeId === input.target.modeId);
      if (!entry || entry.revision !== replacement.revision) throw new Error('Committed configuration changed before readback');
      store.assertCurrent();
      const ready = { status: 'ready' as const, revision: row.revision, record: opened.record };
      const published = params.operationContext
        ? await params.operationContext.commitConnectedAccountCatalog({ key: 'configurations', catalog: ready })
        : commitActiveConnectedAccountCatalog({ scopeKey, lifetimeToken, key: 'configurations', catalog: ready });
      store.assertCurrent();
      if (!published) throw new Error('Committed configuration Account retired');
      return { status: 'committed' as const, record: parsePhysicalConfigurationRecord({
        content: { values: entry.values, secretRefs: entry.secretRefs }, revision: entry.revision, scope: 'service' }) };
    } catch (error) {
      return { status: 'unavailable' as const, code: error instanceof Error && 'code' in error && error.code === 'outcome_unknown'
        ? 'connected_account_configuration_outcome_unknown' : acknowledged
          ? 'connected_account_configuration_committed_readback_unavailable'
          : 'connected_account_configuration_persistence_unavailable' };
    }
  }

  async function resolveAccountMode(): Promise<
    Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'>
  > {
    const mode = await params.getAccountEncryptionMode();
    if (mode === 'unknown') {
      throw new Error('Connected-account account encryption mode is unavailable');
    }
    return mode;
  }

  async function executeNegotiatedOperation<V4Result>(
    input: Readonly<{
      service: QualifiedConnectedAccountRef['service'];
      operation: Parameters<
        typeof executeQualifiedConnectedAccountNegotiatedOperation
      >[0]['operation'];
      executeV4(): Promise<V4Result>;
    }>,
  ): Promise<V4Result> {
    if (!params.resolveServerFeaturesSnapshot) {
      return await input.executeV4();
    }
    const snapshot = params.resolveServerFeaturesSnapshot();
    const serverContract =
      params.resolveSessionSyncPendingInputServerContractResult?.() ?? null;
    return await executeQualifiedConnectedAccountNegotiatedOperation({
      snapshot,
      serverContract,
      service: input.service,
      operation: input.operation,
      executeV4: input.executeV4,
    });
  }

  const persistence: ConnectedAccountDaemonPersistence = Object.freeze({
    profiles: Object.freeze({
      async list(service: QualifiedConnectedAccountRef['service']) {
        const result = await executeNegotiatedOperation({
          service,
          operation: { kind: 'account_list' },
          executeV4: async () => await listProfiles({
            token: params.credentials.token,
            service,
          }),
        });
        if (!sameService(result.service, service)) {
          throw new Error(
            'Connected-account profile list does not match the exact qualified service',
          );
        }
        return result.accounts;
      },
    }),
    configuration: Object.freeze({
      async replaceForControl(input: ConfigurationReplaceForControlInput) {
        if (input.target.kind !== 'service') {
          return Object.freeze({
            status: 'unavailable' as const,
            code: 'connected_account_configuration_atomic_service_settlement_unavailable',
          });
        }
        return replaceServiceConfiguration({ target: input.target, expectedRevision: input.expectedRevision,
          replacement: { values: input.values, secretRefs: input.currentSecretRefs },
          currentSecretRefs: input.currentSecretRefs, secretValues: input.secretValues });
      },
      async read(target: ConfigurationReadTarget) {
        if (target.kind === 'attempt') {
          const staged = attemptConfigurations.get(target.attemptId);
          if (staged) {
            return sameService(staged.target.service, target.service)
              && staged.target.modeId === target.modeId
              ? staged.record
              : null;
          }
          return await readDurableAttemptConfiguration(target);
        }
        if (target.kind === 'service') {
          const catalog = await readActiveConnectedAccountCatalog({ credentials: params.credentials,
            key: 'configurations', ...(params.operationContext ? { operationContext: params.operationContext } : {}) });
          if (catalog.status !== 'ready' || catalog.record.key !== 'configurations') {
            throw Object.assign(new Error('Connected Account configuration catalog is unavailable'), {
              code: 'connected_account_configuration_persistence_unavailable',
            });
          }
          const entry = catalog.record.value.entries.find(entry => sameService(entry.service, target.service)
            && entry.modeId === target.modeId);
          return entry ? parsePhysicalConfigurationRecord({ content: { values: entry.values, secretRefs: entry.secretRefs },
            revision: entry.revision, scope: 'service' }) : null;
        }
        const snapshot = await executeNegotiatedOperation({
          service: target.account.service,
          operation: { kind: 'configuration_read' },
          executeV4: async () => await readConfiguration({
            token: params.credentials.token,
            target: accountTarget(target.account),
          }),
        });
        if (
          !snapshot
          || !sameQualifiedConnectedAccountRef(snapshot.target.ref, target.account)
          || snapshot.authenticationModeId !== target.modeId
        ) {
          return null;
        }
        const accountMode = await resolveAccountMode();
        if (!isStoredJsonContentEnvelopeModeCompatible(
          accountMode,
          snapshot.configurationContent,
        )) {
          throw new Error(
            'Connected-account configuration content does not match the persisted Account encryption mode',
          );
        }
        const opened = openContent({
          kind: 'configuration',
          accountMode,
          credentials: params.credentials,
          material,
          envelope: snapshot.configurationContent,
        });
        if (opened === null) return null;
        return parsePhysicalConfigurationRecord({
          content: opened,
          revision: snapshot.configurationRevision,
          scope: 'account',
        });
      },
      async replace(input: ConfigurationReplaceInput) {
        if (input.target.kind === 'attempt') {
          const currentEntry =
            attemptConfigurations.get(input.target.attemptId) ?? null;
          if (
            currentEntry
            && (
              !sameService(currentEntry.target.service, input.target.service)
              || currentEntry.target.modeId !== input.target.modeId
            )
          ) {
            return Object.freeze({
              status: 'conflict' as const,
              code: 'connected_account_configuration_changed',
            });
          }
          const current = currentEntry?.record ?? null;
          if ((current?.revision ?? null) !== input.expectedRevision) {
            return Object.freeze({
              status: 'conflict' as const,
              code: 'connected_account_configuration_changed',
            });
          }
          if (
            current === null
            && attemptConfigurations.size >= MAX_ATTEMPT_CONFIGURATION_RECORDS
          ) {
            return Object.freeze({
              status: 'unavailable' as const,
              code: 'connected_account_attempt_configuration_capacity_exhausted',
            });
          }
          try {
            const record = parsePhysicalConfigurationRecord({
              content: input.replacement,
              revision: createConfigurationRevision(),
              scope: 'attempt',
            });
            attemptConfigurations.set(input.target.attemptId, Object.freeze({
              target: Object.freeze({
                kind: 'attempt',
                attemptId: input.target.attemptId,
                service: Object.freeze({ ...input.target.service }),
                modeId: input.target.modeId,
              }),
              record,
            }));
            return Object.freeze({
              status: 'committed' as const,
              record,
            });
          } catch {
            return Object.freeze({
              status: 'unavailable' as const,
              code: 'connected_account_configuration_persistence_unavailable',
            });
          }
        }
        if (input.target.kind === 'service') {
          return replaceServiceConfiguration({ target: input.target, expectedRevision: input.expectedRevision,
            replacement: input.replacement });
        }
        const exactAccountTarget = input.target;
        let replacement: ConfigurationContent;
        try {
          replacement = configurationContent(parsePhysicalConfigurationRecord({
            content: input.replacement,
            revision: 'connected-account-configuration-candidate',
            scope: 'account',
          }));
          return await executeNegotiatedOperation({
            service: exactAccountTarget.account.service,
            operation: { kind: 'configuration_write' },
            executeV4: async () => {
              const credential = await readCredential({
                token: params.credentials.token,
                ref: exactAccountTarget.account,
              });
              if (
                !credential
                || !sameQualifiedConnectedAccountRef(credential.ref, exactAccountTarget.account)
                || credential.authenticationModeId !== exactAccountTarget.modeId
              ) {
                return Object.freeze({
                  status: 'conflict' as const,
                  code: 'connected_account_credential_changed',
                });
              }
              const accountMode = await resolveAccountMode();
              const result = await mutateConfiguration({
                token: params.credentials.token,
                patch: {
                  target: accountTarget(exactAccountTarget.account),
                  expectedConfigurationRevision: input.expectedRevision,
                  expectedCredentialRevision: credential.credentialRevision,
                  replacementContentEnvelope: sealContent({
                    kind: 'configuration',
                    accountMode,
                    credentials: params.credentials,
                    material,
                    payload: replacement,
                    randomBytes,
                  }),
                },
              });
              if (!result.configurationRevision) {
                return Object.freeze({
                  status: 'unavailable' as const,
                  code: 'connected_account_configuration_revision_unavailable',
                });
              }
              return Object.freeze({
                status: 'committed' as const,
                record: Object.freeze({
                  revision: result.configurationRevision,
                  ...replacement,
                }),
              });
            },
          });
        } catch (error) {
          return Object.freeze({
            status: readHttpStatus(error) === 409
              ? 'conflict' as const
              : 'unavailable' as const,
            code: readHttpStatus(error) === 409
              ? 'connected_account_configuration_changed'
              : 'connected_account_configuration_persistence_unavailable',
          });
        }
      },
      async destroyAttempt(attemptId: string) {
        attemptConfigurations.delete(attemptId);
      },
      secrets: params.secrets,
    }),
    attempts: Object.freeze({
      assertAuthenticationActionAllowed(
        input: Parameters<
          NonNullable<
            ConnectedAccountDaemonPersistence[
              'attempts'
            ]['assertAuthenticationActionAllowed']
          >
        >[0],
      ) {
        if (!params.resolveServerFeaturesSnapshot) return;
        const snapshot = params.resolveServerFeaturesSnapshot();
        const serverContract =
          params.resolveSessionSyncPendingInputServerContractResult?.()
          ?? null;
        const transport =
          resolveQualifiedConnectedAccountOperationTransport({
            snapshot,
            serverContract,
            service: input.service,
            operation: {
              kind: 'credential_write',
              // Preflight has not admitted configuration yet. The attempt
              // owner re-runs this check with the exact admitted state before
              // it publishes or continues an attempt.
              configurationState:
                input.configurationState ?? 'unconfigured',
            },
          });
      },
      accounts: Object.freeze({
        async readExact(account: ExactAccount) {
          const snapshot = await executeNegotiatedOperation({
            service: account.service,
            operation: {
              kind: 'credential_read',
              configurationState: 'unconfigured',
            },
            executeV4: async () => await readCredential({
              token: params.credentials.token,
              ref: account,
            }),
          });
          if (
            !snapshot
            || !sameQualifiedConnectedAccountRef(snapshot.ref, account)
            || snapshot.authenticationModeId === null
            || snapshot.revisionSemantics !== 'revisioned'
          ) {
            return null;
          }
          return Object.freeze({
            account: Object.freeze({
              service: Object.freeze({ ...snapshot.ref.service }),
              accountId: snapshot.ref.accountId,
            }),
            authenticationModeId: snapshot.authenticationModeId,
            credentialRevision: snapshot.credentialRevision,
            configurationRevision: snapshot.configurationRevision,
          });
        },
      }),
      oauth:
        params.attemptTransactions?.oauth ?? localOAuthTransactionOwner,
      ...(params.attemptTransactions?.device
        ? { deviceTransactions: params.attemptTransactions.device }
        : {}),
      listPending: params.attemptTransactions?.listPending ?? (async () => {
        throw new Error('Connected-account pending attempt discovery is unavailable');
      }),
      settlement: (() => {
        async function publishSettledAccount(
          input: Parameters<NonNullable<typeof params.onAccountSettled>>[0],
        ) {
          try {
            await params.onAccountSettled?.(input);
          } catch {
            // Credentials are already committed. Preserve connection settlement;
            // the canonical quota poll retries source initialization before provider work.
            logger.debug('[DAEMON] Qualified Connected Account quota source initialization failed (non-fatal)');
          }
          return Object.freeze({ status: 'connected' as const, account: input.account });
        }
        const settle = async (
          request: SettlementRequest,
          reconciliation: boolean,
        ) => {
          const account = Object.freeze({
            service: Object.freeze({ ...request.service }),
            accountId: request.accountId,
          });
          const preparedCredentialMetadata =
            QualifiedConnectedAccountCredentialMetadataV4Schema.parse({
              ...(request.providerIdentity
                ? { providerIdentity: request.providerIdentity }
                : {}),
              displayName: request.displayName,
              scopes: request.scopes,
            });
          let settledBasis: Parameters<NonNullable<typeof params.onAccountSettled>>[0] | undefined;
          let stagedAccountConfigurationContent:
            ConfigurationContent
            | undefined;
          if (request.stagedAccountConfigurationContent !== undefined) {
            if (
              request.intent !== 'connect'
              || request.expectedCredentialRevision !== null
              || request.expectedCredentialConfigurationRevision !== null
            ) {
              return Object.freeze({
                status: 'unavailable' as const,
                code: 'connected_account_settlement_configuration_invalid',
              });
            }
            try {
              stagedAccountConfigurationContent = configurationContent(
                parsePhysicalConfigurationRecord({
                  content: request.stagedAccountConfigurationContent,
                  revision: request.expectedConfigurationRevision,
                  scope: 'account',
                }),
              );
            } catch {
              return Object.freeze({
                status: 'unavailable' as const,
                code: 'connected_account_settlement_configuration_invalid',
              });
            }
          }
          try {
            await executeNegotiatedOperation({
              service: account.service,
              operation: {
                kind: 'credential_write',
                configurationState:
                  request.expectedConfigurationRevision === 'unconfigured'
                  && stagedAccountConfigurationContent === undefined
                    ? 'unconfigured'
                    : 'configured',
              },
              executeV4: async () => {
                const accountMode = await resolveAccountMode();
                const payload =
                  QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
                    v: 1,
                    values: request.stagedCredentials,
                  });
                const content = sealContent({
                  kind: 'credential',
                  accountMode,
                  credentials: params.credentials,
                  material,
                  payload:
                    projectQualifiedConnectedAccountCredentialPlaintextV1({
                      ref: account,
                      authenticationModeId: request.authenticationModeId,
                      payload,
                      metadata: {
                        ...(preparedCredentialMetadata.providerIdentity
                          ? {
                              providerIdentity:
                                preparedCredentialMetadata.providerIdentity,
                            }
                          : {}),
                        scopes: preparedCredentialMetadata.scopes,
                      },
                      now: now(),
                    }),
                  randomBytes,
                });
                const initialConfiguration =
                  request.expectedCredentialRevision === null
                  && stagedAccountConfigurationContent !== undefined
                    ? {
                        expectedConfigurationRevision: null,
                        replacementContentEnvelope: sealContent({
                          kind: 'configuration',
                          accountMode,
                          credentials: params.credentials,
                          material,
                          payload: stagedAccountConfigurationContent,
                          randomBytes,
                        }),
                      }
                    : undefined;
                const settled = await mutateCredential({
                  token: params.credentials.token,
                  mutation: {
                    ref: account,
                    authenticationModeId: request.authenticationModeId,
                    directExportContract: request.directExportContract ?? null,
                    ...(request.contributionContractVersion
                      ? { contributionContractVersion: request.contributionContractVersion }
                      : {}),
                    content,
                    metadata: preparedCredentialMetadata,
                    expectedCredentialRevision:
                      request.expectedCredentialRevision,
                    ...(request.expectedCredentialRevision === null
                      ? (initialConfiguration
                          ? { initialConfiguration }
                          : {})
                      : {
                          expectedConfigurationRevision:
                            request.expectedCredentialConfigurationRevision,
                        }),
                  },
                });
                const configurationSettled =
                  initialConfiguration !== undefined
                    ? settled.configurationRevision !== null
                    : settled.configurationRevision
                      === request.expectedCredentialConfigurationRevision;
                if (!configurationSettled) {
                  throw new Error(
                    'Qualified Connected Account settlement did not commit the exact configuration basis',
                  );
                }
                settledBasis = {
                  account,
                  accountMode,
                  credentialRevision: settled.credentialRevision,
                  configurationRevision: settled.configurationRevision,
                };
              },
            });
            if (!settledBasis) {
              throw new Error('Qualified Connected Account settlement basis is unavailable');
            }
            return await publishSettledAccount(settledBasis);
          } catch (error) {
            const namedCause = readQualifiedConnectedAccountCredentialSettlementCause(error);
            if (namedCause) return namedCause;
            const reconciliationConflict =
              readHttpStatus(error) === 409
              && reconciliation;
            if (
              readHttpStatus(error) === 409
              && !reconciliationConflict
            ) {
              return Object.freeze({
                status: 'conflict' as const,
                code: 'connected_account_settlement_conflict',
              });
            }
            try {
              const accountMode = await resolveAccountMode();
              const committed = await readCredential({
                token: params.credentials.token,
                ref: account,
              });
              if (
                !committed
                || !sameQualifiedConnectedAccountRef(committed.ref, account)
                || committed.authenticationModeId !== request.authenticationModeId
              ) {
                throw error;
              }
              const opened = openContent({
                kind: 'credential',
                accountMode,
                credentials: params.credentials,
                material,
                envelope: committed.content,
              });
              let payload:
                ReturnType<
                  typeof parseQualifiedConnectedAccountCredentialPlaintextV1
                >;
              try {
                payload =
                  parseQualifiedConnectedAccountCredentialPlaintextV1({
                    ref: account,
                    authenticationModeId: committed.authenticationModeId,
                    plaintext: opened,
                    metadata: committed.metadata,
                  });
              } catch {
                throw error;
              }
              if (
                !isDeepStrictEqual(payload.values, request.stagedCredentials)
                || !isDeepStrictEqual(
                  committed.metadata,
                  preparedCredentialMetadata,
                )
                || (
                  stagedAccountConfigurationContent === undefined
                  && committed.configurationRevision
                    !== request.expectedCredentialConfigurationRevision
                )
              ) {
                throw error;
              }
              if (stagedAccountConfigurationContent !== undefined) {
                const configuration = await readConfiguration({
                  token: params.credentials.token,
                  target: accountTarget(account),
                });
                if (
                  !configuration
                  || configuration.credentialRevision !== committed.credentialRevision
                  || configuration.configurationRevision
                    !== committed.configurationRevision
                ) {
                  throw error;
                }
                const openedConfigurationContent = openContent({
                  kind: 'configuration',
                  accountMode,
                  credentials: params.credentials,
                  material,
                  envelope: configuration.configurationContent,
                });
                let committedConfigurationContent: ConfigurationContent;
                try {
                  committedConfigurationContent = configurationContent(
                    parsePhysicalConfigurationRecord({
                      content: openedConfigurationContent,
                      revision: configuration.configurationRevision,
                      scope: 'account',
                    }),
                  );
                } catch {
                  throw error;
                }
                if (!isDeepStrictEqual(
                  committedConfigurationContent,
                  stagedAccountConfigurationContent,
                )) {
                  throw error;
                }
              }
              return await publishSettledAccount({
                account,
                accountMode,
                credentialRevision: committed.credentialRevision,
                configurationRevision: committed.configurationRevision,
              });
            } catch {
              if (reconciliationConflict) {
                return Object.freeze({
                  status: 'conflict' as const,
                  code: 'connected_account_settlement_conflict',
                });
              }
              throw error;
            }
          }
        };
        return Object.freeze({
          settle: async (request: SettlementRequest) =>
            await settle(request, false),
          reconcile: async (request: SettlementRequest) =>
            await settle(request, true),
        });
      })(),
      }),
  });
  return persistence;
}
