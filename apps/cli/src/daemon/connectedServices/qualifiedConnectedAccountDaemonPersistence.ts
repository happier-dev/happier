import {
  randomBytes as nodeRandomBytes,
  randomUUID,
} from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES,
  CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY,
  AccountSettingsSavedSecretMutationError,
  QualifiedConnectedAccountCredentialMetadataV4Schema,
  QualifiedConnectedAccountCredentialPayloadV1Schema,
  SavedSecretSchema,
  applyAccountSettingsSavedSecretMutation,
  accountSettingsParse,
  decryptSecretValueWithKeysV1,
  sameQualifiedConnectedAccountRef,
  parseBuiltInLegacyConnectedServiceCredentialRecordV1,
  parseConnectedAccountServiceConfigurationsV1,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  openQualifiedConnectedAccountContentEnvelope,
  projectQualifiedConnectedAccountCredentialPlaintextV1,
  sealQualifiedConnectedAccountContentEnvelope,
  type AccountScopedCryptoMaterial,
  type ConnectedServiceCredentialRecordV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { readHttpStatus } from '@/api/client/httpStatusError';
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
import {
  storeConnectedServiceCredentialForAccount,
  type ConnectedServiceCredentialStorageApi,
} from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';
import {
  resolveConnectedServiceCredentialSource,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { StoredCredentials } from '@/persistence';
import {
  commitActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  updateAccountSettingsV2OnceAgainstLatest,
  type AccountSettingsMutationResult,
  type AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import {
  indexSavedSecretsByIdFromAccountSettings,
} from '@/settings/secrets/indexSavedSecretsById';
import {
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';
import {
  parseConnectedAccountConfigurationRecordContent,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import type {
  ConnectedAccountDeviceTransactionOwner,
  ConnectedAccountOAuthTransaction,
  ConnectedAccountOAuthTransactionOwner,
  ConnectedAccountOAuthTransactionSnapshot,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';

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
type AccountSettingsMutator = (
  current: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

type AccountSettingsUpdateOutcome =
  | Readonly<{
      kind: 'settings';
      settings: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: 'settlement';
      result: Exclude<AccountSettingsMutationResult, Readonly<{
        status: 'applied' | 'satisfied' | 'unchanged';
      }>>;
    }>;

function isSettledAccountSettingsSuccess(
  result: AccountSettingsMutationResult,
): result is Extract<AccountSettingsMutationResult, Readonly<{
  status: 'applied' | 'satisfied' | 'unchanged';
}>> {
  return result.status === 'applied'
    || result.status === 'satisfied'
    || result.status === 'unchanged';
}

function configurationFailureForAccountSettingsSettlement(
  result: Exclude<AccountSettingsMutationResult, Readonly<{
    status: 'applied' | 'satisfied' | 'unchanged';
  }>>,
) {
  switch (result.status) {
    case 'conflict':
      return Object.freeze({
        status: 'conflict' as const,
        code: 'connected_account_configuration_settings_conflict',
      });
    case 'outcomeUnknown':
      return Object.freeze({
        status: 'unavailable' as const,
        code: 'connected_account_configuration_settings_outcome_unknown',
      });
    case 'cancelled':
      return Object.freeze({
        status: 'unavailable' as const,
        code: 'connected_account_configuration_settings_cancelled',
      });
    case 'locked':
      return Object.freeze({
        status: 'unavailable' as const,
        code: 'connected_account_configuration_settings_locked',
      });
    case 'invalid':
      return Object.freeze({
        status: 'unavailable' as const,
        code: 'connected_account_configuration_settings_invalid',
      });
    case 'unavailable':
      return Object.freeze({
        status: 'unavailable' as const,
        code: 'connected_account_configuration_settings_unavailable',
      });
  }
}

export type QualifiedConnectedAccountAttemptTransactionAdapters = Readonly<{
  oauth?: ConnectedAccountOAuthTransactionOwner;
  device?: ConnectedAccountDeviceTransactionOwner;
}>;

class ConfigurationRevisionConflict extends Error {}
class LegacyCredentialSettlementConflict extends Error {}
class LegacyCredentialSettlementError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Legacy connected-account settlement failed');
    this.name = 'LegacyCredentialSettlementError';
    this.cause = cause;
  }
}

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

type ServiceConfigurationEntry = Readonly<{
  service: QualifiedConnectedAccountRef['service'];
  modeId: string;
  record: ConfigurationRecord;
}>;

function serviceConfigurationKey(input: Readonly<{
  service: QualifiedConnectedAccountRef['service'];
  modeId: string;
}>): string {
  return JSON.stringify([
    input.service.pluginId,
    input.service.localId,
    input.modeId,
  ]);
}

function parseServiceConfigurationEntries(
  settings: Readonly<Record<string, unknown>>,
): Map<string, ServiceConfigurationEntry> {
  const rawStore =
    settings[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY];
  if (rawStore === undefined) return new Map();
  const store = parseConnectedAccountServiceConfigurationsV1(rawStore);
  const entries = new Map<string, ServiceConfigurationEntry>();
  for (const entry of store.entries) {
    const normalizedService = Object.freeze({
      pluginId: entry.service.pluginId,
      localId: entry.service.localId,
    });
    const record = parsePhysicalConfigurationRecord({
      content: {
        values: entry.values,
        secretRefs: entry.secretRefs,
      },
      revision: entry.revision,
      scope: 'service',
    });
    const normalized = Object.freeze({
      service: normalizedService,
      modeId: entry.modeId,
      record,
    });
    const key = serviceConfigurationKey(normalized);
    if (entries.has(key)) {
      throw new Error('Connected-account service configuration entry is duplicated');
    }
    entries.set(key, normalized);
  }
  return entries;
}

function serializeServiceConfigurationEntries(
  entries: ReadonlyMap<string, ServiceConfigurationEntry>,
): Readonly<Record<string, unknown>> {
  return parseConnectedAccountServiceConfigurationsV1({
    v: 1,
    entries: [...entries.values()]
      .sort((left, right) => (
        serviceConfigurationKey(left).localeCompare(serviceConfigurationKey(right))
      ))
      .map((entry) => ({
        service: entry.service,
        modeId: entry.modeId,
        revision: entry.record.revision,
        values: entry.record.values,
        secretRefs: entry.record.secretRefs,
      })),
  });
}

function retireUnreferencedReplacedServiceConfigurationSecrets(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  previousSecretIds: readonly string[];
}>): Readonly<Record<string, unknown>> {
  let settings = input.settings;
  for (const secretId of new Set(input.previousSecretIds)) {
    const savedSecret = Array.isArray(settings.secrets)
      ? settings.secrets
        .map((candidate) => SavedSecretSchema.safeParse(candidate))
        .find((candidate) => candidate.success && candidate.data.id === secretId)
      : undefined;
    if (!savedSecret?.success) continue;
    try {
      settings = applyAccountSettingsSavedSecretMutation(settings, {
        kind: 'delete',
        secretId,
        expectedUpdatedAt: savedSecret.data.updatedAt,
      }).settings;
    } catch (error) {
      if (
        error instanceof AccountSettingsSavedSecretMutationError
        && error.code === 'saved_secret_in_use'
      ) {
        continue;
      }
      throw error;
    }
  }
  return settings;
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

type LegacyConnectedServiceId =
  keyof typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID;
type LegacyConnectedAccountApi = ConnectedServiceCredentialStorageApi & Readonly<{
  listConnectedServiceProfiles(input: Readonly<{
    serviceId: LegacyConnectedServiceId;
    forceRefresh?: boolean;
  }>): Promise<Readonly<{
    serviceId: LegacyConnectedServiceId;
    profiles: readonly Readonly<{
      profileId: string;
      status:
        | 'connected'
        | 'refreshing'
        | 'needs_reauth'
        | 'refresh_failed_retryable';
      kind?: 'oauth' | 'token' | null;
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
      lastUsedAt?: number | null;
    }>[];
  }>>;
}>;

function projectLegacyAuthenticationMode(
  serviceId: LegacyConnectedServiceId,
  kind: ConnectedServiceCredentialRecordV1['kind'],
  status:
    | 'connected'
    | 'refreshing'
    | 'needs_reauth'
    | 'refresh_failed_retryable',
): Readonly<{
  authenticationModeId: string | null;
  status:
    | 'connected'
    | 'refreshing'
    | 'needs_reauth'
    | 'refresh_failed_retryable';
}> {
  const compatibility =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[serviceId];
  const supportedModeId = (
    compatibility.authenticationModeByCredentialKind as Readonly<
      Partial<Record<ConnectedServiceCredentialRecordV1['kind'], string>>
    >
  )[kind];
  if (supportedModeId) {
    return Object.freeze({
      authenticationModeId: supportedModeId,
      status,
    });
  }
  const unsupportedModeId = (
    compatibility.unsupportedAuthenticationModeByCredentialKind as Readonly<
      Partial<Record<ConnectedServiceCredentialRecordV1['kind'], string>>
    >
  )[kind];
  if (unsupportedModeId) {
    return Object.freeze({
      authenticationModeId: null,
      status: 'needs_reauth',
    });
  }
  throw new QualifiedConnectedAccountCompatibilityError(
    'connected_account_legacy_operation_unsupported',
  );
}

function legacyAuthenticationModeCardinality(
  service: QualifiedConnectedAccountRef['service'],
): 'single' | 'multiple' {
  for (const compatibility of Object.values(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  )) {
    if (!sameService(compatibility.service, service)) continue;
    return new Set(
      [
        ...Object.values(
          compatibility.authenticationModeByCredentialKind,
        ),
        ...Object.values(
          compatibility.unsupportedAuthenticationModeByCredentialKind,
        ),
      ],
    ).size > 1
      ? 'multiple'
      : 'single';
  }
  return 'single';
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

export function createActiveAccountSettingsConnectedAccountSecrets():
  ConnectedAccountDaemonPersistence['configuration']['secrets'] {
  return Object.freeze({
    async has(secretId) {
      const snapshot = getActiveAccountSettingsSnapshot();
      return Boolean(
        snapshot
        && indexSavedSecretsByIdFromAccountSettings(snapshot.settings).has(secretId),
      );
    },
    async read(secretId, options) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('Operation aborted');
      }
      const snapshot = getActiveAccountSettingsSnapshot();
      if (!snapshot) return null;
      const savedSecret =
        indexSavedSecretsByIdFromAccountSettings(snapshot.settings).get(secretId)
        ?? null;
      if (!savedSecret) return null;
      const value = decryptSecretValueWithKeysV1(
        savedSecret,
        snapshot.settingsSecretsReadKeys,
      );
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('Operation aborted');
      }
      return getActiveAccountSettingsSnapshot() === snapshot ? value : null;
    },
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
    legacyCredentialApi?: LegacyConnectedAccountApi;
    secrets: ConnectedAccountDaemonPersistence['configuration']['secrets'];
    randomBytes?: (length: number) => Uint8Array;
    callbackUrl?: string;
    readAccountSettings?: () => Readonly<Record<string, unknown>> | null;
    updateAccountSettings?: (
      mutate: AccountSettingsMutator,
    ) => Promise<Readonly<Record<string, unknown>>>;
    accountSettingsUpdateDeps?: AccountSettingsUpdateV2Deps;
    createConfigurationRevision?: () => string;
    createSecretId?: () => string;
    now?: () => number;
    attemptTransactions?: QualifiedConnectedAccountAttemptTransactionAdapters;
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
      && left.immutableGenerationId === right.immutableGenerationId
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

  function readAccountSettings(): Readonly<Record<string, unknown>> | null {
    if (params.readAccountSettings) return params.readAccountSettings();
    const snapshot = getActiveAccountSettingsSnapshot();
    if (
      !snapshot
      || snapshot.scopeKey !== resolveAccountSettingsScopeKey(params.credentials)
    ) {
      return null;
    }
    return snapshot.settings;
  }

  async function updateAccountSettings(
    mutate: AccountSettingsMutator,
  ): Promise<AccountSettingsUpdateOutcome> {
    if (params.updateAccountSettings) {
      return Object.freeze({
        kind: 'settings' as const,
        settings: await params.updateAccountSettings(mutate),
      });
    }
    const expectedScopeKey = resolveAccountSettingsScopeKey(params.credentials);
    const activeAtStart = getActiveAccountSettingsSnapshot();
    const activeLifetimeTokenAtStart = getActiveAccountSettingsSnapshotLifetimeToken();
    if (activeAtStart?.scopeKey && activeAtStart.scopeKey !== expectedScopeKey) {
      return Object.freeze({
        kind: 'settlement' as const,
        result: Object.freeze({ status: 'unavailable' as const, retryable: false }),
      });
    }
    const current = readAccountSettings();
    if (!current) {
      return Object.freeze({
        kind: 'settlement' as const,
        result: Object.freeze({ status: 'unavailable' as const, retryable: false }),
      });
    }
    const remainsCurrent = (): boolean => {
      const active = getActiveAccountSettingsSnapshot();
      return getActiveAccountSettingsSnapshotLifetimeToken()
        === activeLifetimeTokenAtStart
        && (active === activeAtStart || active?.scopeKey === expectedScopeKey);
    };
    const result = await updateAccountSettingsV2OnceAgainstLatest({
      credentials: params.credentials,
      // Service configuration and SavedSecret updates are one atomic domain
      // delta. The callback runs once against one fetched version; a
      // concurrent winner returns a truthful conflict rather than replaying
      // caller code.
      mutate,
      shouldSubmit: remainsCurrent,
      shouldCommit: remainsCurrent,
      ...(params.accountSettingsUpdateDeps
        ? { deps: params.accountSettingsUpdateDeps }
        : {}),
    });
    if (!isSettledAccountSettingsSuccess(result)) {
      return Object.freeze({ kind: 'settlement' as const, result });
    }
    if (!remainsCurrent()) {
      return Object.freeze({
        kind: 'settlement' as const,
        result: Object.freeze({ status: 'unavailable' as const, retryable: false }),
      });
    }
    const committed = commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: result.settings,
      settingsVersion: result.version,
      loadedAtMs: now(),
      settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(
        params.credentials,
      ),
      scopeKey: resolveAccountSettingsScopeKey(params.credentials),
    });
    return Object.freeze({
      kind: 'settings' as const,
      settings: committed.snapshot.settings,
    });
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

  async function executeNegotiatedOperation<V4Result, LegacyResult>(
    input: Readonly<{
      service: QualifiedConnectedAccountRef['service'];
      operation: Parameters<
        typeof executeQualifiedConnectedAccountNegotiatedOperation
      >[0]['operation'];
      executeV4(): Promise<V4Result>;
      executeLegacy(
        serviceId: LegacyConnectedServiceId,
        api: LegacyConnectedAccountApi,
      ): Promise<LegacyResult>;
    }>,
  ): Promise<V4Result | LegacyResult> {
    if (!params.resolveServerFeaturesSnapshot) {
      return await input.executeV4();
    }
    const snapshot = params.resolveServerFeaturesSnapshot();
    const serverContract =
      params.resolveSessionSyncPendingInputServerContractResult?.() ?? null;
    const transport = resolveQualifiedConnectedAccountOperationTransport({
      snapshot,
      serverContract,
      service: input.service,
      operation: input.operation,
    });
    if (
      transport.kind === 'legacy'
      && transport.peerClass === 'exact_v0_2_1'
    ) {
      // Exact unfenced rows remain readable only through the legacy resolver.
      // The qualified daemon surface cannot invent a credential revision.
      throw new QualifiedConnectedAccountCompatibilityError(
        'connected_account_legacy_operation_unsupported',
      );
    }
    return await executeQualifiedConnectedAccountNegotiatedOperation({
      snapshot,
      serverContract,
      service: input.service,
      operation: input.operation,
      executeV4: input.executeV4,
      executeLegacy: async (serviceId) => {
        if (!params.legacyCredentialApi) {
          throw new QualifiedConnectedAccountCompatibilityError(
            'connected_account_legacy_operation_unsupported',
          );
        }
        return await input.executeLegacy(
          serviceId,
          params.legacyCredentialApi,
        );
      },
    });
  }

  async function readLegacyCredentialRecord(input: Readonly<{
    api: LegacyConnectedAccountApi;
    serviceId: LegacyConnectedServiceId;
    accountId: string;
  }>): Promise<Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    credentialRevision: string;
  }> | null> {
    const accountMode = await resolveAccountMode();
    const binding = {
      serviceId: input.serviceId,
      profileId: input.accountId,
    };
    const stored = await resolveConnectedServiceCredentialSource({
      credentials: params.credentials,
      api: input.api,
      binding,
      accountMode,
    });
    if (!stored) return null;
    if (stored.revisionSemantics !== 'revisioned') {
      throw new QualifiedConnectedAccountCompatibilityError(
        'connected_account_legacy_operation_unsupported',
      );
    }
    return Object.freeze({
      record: stored.record,
      credentialRevision: stored.credentialRevision,
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
          executeLegacy: async (serviceId, api) => {
            const listed = await api.listConnectedServiceProfiles({
              serviceId,
            });
            const compatibility =
              BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
                serviceId
              ];
            const accounts = await Promise.all(
              listed.profiles.map(async (profile) => {
                const exact = await readLegacyCredentialRecord({
                  api,
                  serviceId,
                  accountId: profile.profileId,
                });
                if (!exact) {
                  throw new QualifiedConnectedAccountCompatibilityError(
                    'connected_account_legacy_operation_unsupported',
                  );
                }
                const providerIdentity = {
                  ...(profile.providerAccountId
                    ? { accountId: profile.providerAccountId }
                    : {}),
                  ...(profile.providerEmail
                    ? { email: profile.providerEmail }
                    : {}),
                };
                const publicAuthentication =
                  projectLegacyAuthenticationMode(
                    serviceId,
                    exact.record.kind,
                    profile.status,
                  );
                return Object.freeze({
                  ref: Object.freeze({
                    service: compatibility.service,
                    accountId: profile.profileId,
                  }),
                  status: publicAuthentication.status,
                  authenticationModeId:
                    publicAuthentication.authenticationModeId,
                  revisionSemantics: 'revisioned' as const,
                  credentialRevision: exact.credentialRevision,
                  configurationReady: false,
                  configurationRevision: null,
                  kind: exact.record.kind,
                  ...(Object.keys(providerIdentity).length > 0
                    ? { providerIdentity }
                    : {}),
                  scopes: [],
                  ...(profile.expiresAt === undefined
                    ? {}
                    : { expiresAt: profile.expiresAt }),
                  ...(profile.lastUsedAt === undefined
                    ? {}
                    : { lastUsedAt: profile.lastUsedAt }),
                });
              }),
            );
            return Object.freeze({
              service: compatibility.service,
              accounts: Object.freeze(accounts),
            });
          },
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
        const serviceTarget = input.target;
        try {
          const revision = createConfigurationRevision();
          let committed:
            ReturnType<typeof parseConnectedAccountConfigurationRecordContent>
            | null = null;
          const update = await updateAccountSettings((settings) => {
            const entries = parseServiceConfigurationEntries(settings);
            const key = serviceConfigurationKey(serviceTarget);
            const current = entries.get(key)?.record ?? null;
            if (
              (current?.revision ?? null) !== input.expectedRevision
              || !isDeepStrictEqual(
                current?.secretRefs ?? {},
                input.currentSecretRefs,
              )
            ) {
              throw new ConfigurationRevisionConflict();
            }
            if (
              current === null
              && entries.size >= CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES
            ) {
              throw new Error(
                'Connected-account service configuration capacity is exhausted',
              );
            }
            let nextSettings = settings;
            const secretRefs: Record<string, string> = {
              ...input.currentSecretRefs,
            };
            const replacedSecretIds = Object.keys(input.secretValues)
              .flatMap((fieldId) => {
                const previousSecretId = input.currentSecretRefs[fieldId];
                return previousSecretId === undefined ? [] : [previousSecretId];
              });
            for (const [fieldId, value] of Object.entries(input.secretValues)) {
              const secretId = createSecretId();
              const timestamp = now();
              const savedSecret = SavedSecretSchema.parse({
                id: secretId,
                name: `Connected Account ${fieldId}`.slice(0, 100),
                kind: 'other',
                // The Account Settings write owner applies the Account's actual encryption
                // mode to every SavedSecret on its way to the envelope: E2EE Accounts get the
                // canonical sealed form, plaintext Accounts — which correctly hold no Account
                // data-encryption material — get the canonical plain envelope. Encrypting here
                // would make this adapter a second decision-maker and would fail closed for
                // every plaintext Account.
                encryptedValue: { _isSecretValue: true, value },
                createdAt: timestamp,
                updatedAt: timestamp,
              });
              nextSettings = applyAccountSettingsSavedSecretMutation(
                nextSettings,
                { kind: 'add', secret: savedSecret },
              ).settings;
              secretRefs[fieldId] = secretId;
            }
            committed = Object.freeze({
              revision,
              values: input.values,
              secretRefs: Object.freeze(secretRefs),
            });
            entries.set(key, Object.freeze({
              service: Object.freeze({ ...serviceTarget.service }),
              modeId: serviceTarget.modeId,
              record: committed,
            }));
            const withConfiguration = Object.freeze({
              ...nextSettings,
              [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]:
                serializeServiceConfigurationEntries(entries),
            });
            return retireUnreferencedReplacedServiceConfigurationSecrets({
              settings: withConfiguration,
              previousSecretIds: replacedSecretIds,
            });
          });
          if (update.kind === 'settlement') {
            return configurationFailureForAccountSettingsSettlement(update.result);
          }
          if (!committed) {
            throw new Error(
              'Connected-account service configuration commit was not observed',
            );
          }
          return Object.freeze({
            status: 'committed' as const,
            record: committed,
          });
        } catch (error) {
          return Object.freeze({
            status: error instanceof ConfigurationRevisionConflict
              ? 'conflict' as const
              : 'unavailable' as const,
            code: error instanceof ConfigurationRevisionConflict
              ? 'connected_account_configuration_changed'
              : 'connected_account_configuration_persistence_unavailable',
          });
        }
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
          const settings = readAccountSettings();
          if (!settings) return null;
          return parseServiceConfigurationEntries(settings).get(
            serviceConfigurationKey(target),
          )?.record ?? null;
        }
        const snapshot = await executeNegotiatedOperation({
          service: target.account.service,
          operation: { kind: 'configuration_read' },
          executeV4: async () => await readConfiguration({
            token: params.credentials.token,
            target: accountTarget(target.account),
          }),
          executeLegacy: async () => {
            throw new QualifiedConnectedAccountCompatibilityError(
              'connected_account_legacy_operation_unsupported',
            );
          },
        });
        if (
          !snapshot
          || !sameQualifiedConnectedAccountRef(snapshot.target.ref, target.account)
          || snapshot.authenticationModeId !== target.modeId
        ) {
          return null;
        }
        const accountMode = await resolveAccountMode();
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
          const serviceTarget = input.target;
          try {
            const revision = createConfigurationRevision();
            let committed:
              ReturnType<typeof parseConnectedAccountConfigurationRecordContent>
              | null = null;
            const update = await updateAccountSettings((settings) => {
              const entries = parseServiceConfigurationEntries(settings);
              const key = serviceConfigurationKey(serviceTarget);
              const current = entries.get(key)?.record ?? null;
              if ((current?.revision ?? null) !== input.expectedRevision) {
                throw new ConfigurationRevisionConflict();
              }
              if (
                current === null
                && entries.size >= CONNECTED_ACCOUNT_SERVICE_CONFIGURATION_MAX_ENTRIES
              ) {
                throw new Error(
                  'Connected-account service configuration capacity is exhausted',
                );
              }
              committed = parsePhysicalConfigurationRecord({
                content: input.replacement,
                revision,
                scope: 'service',
              });
              entries.set(key, Object.freeze({
                service: Object.freeze({ ...serviceTarget.service }),
                modeId: serviceTarget.modeId,
                record: committed,
              }));
              return Object.freeze({
                ...settings,
                [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]:
                  serializeServiceConfigurationEntries(entries),
              });
            });
            if (update.kind === 'settlement') {
              return configurationFailureForAccountSettingsSettlement(update.result);
            }
            if (!committed) {
              throw new Error(
                'Connected-account service configuration commit was not observed',
              );
            }
            return Object.freeze({
              status: 'committed' as const,
              record: committed,
            });
          } catch (error) {
            return Object.freeze({
              status: error instanceof ConfigurationRevisionConflict
                ? 'conflict' as const
                : 'unavailable' as const,
              code: error instanceof ConfigurationRevisionConflict
                ? 'connected_account_configuration_changed'
                : 'connected_account_configuration_persistence_unavailable',
            });
          }
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
            executeLegacy: async () => {
              throw new QualifiedConnectedAccountCompatibilityError(
                'connected_account_legacy_operation_unsupported',
              );
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
              authenticationModeCardinality:
                input.authenticationModeCardinality
                ?? legacyAuthenticationModeCardinality(input.service),
            },
          });
        if (
          transport.kind === 'legacy'
          && input.authenticationModeId !== undefined
        ) {
          const compatibility =
            BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
              transport.serviceId
            ];
          const representableModeIds = new Set<string>(
            Object.values(
              compatibility.authenticationModeByCredentialKind,
            ),
          );
          if (!representableModeIds.has(input.authenticationModeId)) {
            throw new QualifiedConnectedAccountCompatibilityError(
              'connected_account_legacy_operation_unsupported',
            );
          }
        }
      },
      accounts: Object.freeze({
        async readExact(account: ExactAccount) {
          const snapshot = await executeNegotiatedOperation({
            service: account.service,
            operation: {
              kind: 'credential_read',
              configurationState: 'unconfigured',
              authenticationModeCardinality:
                legacyAuthenticationModeCardinality(account.service),
            },
            executeV4: async () => await readCredential({
              token: params.credentials.token,
              ref: account,
            }),
            executeLegacy: async (serviceId, api) => {
              const exact = await readLegacyCredentialRecord({
                api,
                serviceId,
                accountId: account.accountId,
              });
              if (!exact) return null;
              const publicAuthentication = projectLegacyAuthenticationMode(
                serviceId,
                exact.record.kind,
                'connected',
              );
              if (publicAuthentication.authenticationModeId === null) {
                return null;
              }
              return Object.freeze({
                ref: account,
                authenticationModeId:
                  publicAuthentication.authenticationModeId,
                revisionSemantics: 'revisioned' as const,
                credentialRevision: exact.credentialRevision,
                configurationRevision: null,
              });
            },
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
      settlement: (() => {
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
                authenticationModeCardinality:
                  legacyAuthenticationModeCardinality(account.service),
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
              },
              executeLegacy: async (serviceId, api) => {
                try {
                  const current = await readLegacyCredentialRecord({
                    api,
                    serviceId,
                    accountId: request.accountId,
                  });
                  if (reconciliation) {
                    if (!current) {
                      throw new LegacyCredentialSettlementConflict();
                    }
                    const currentAuthentication =
                      projectLegacyAuthenticationMode(
                        serviceId,
                        current.record.kind,
                        'connected',
                      );
                    let currentPayload:
                      ReturnType<
                        typeof parseQualifiedConnectedAccountCredentialPlaintextV1
                      >;
                    try {
                      currentPayload =
                        parseQualifiedConnectedAccountCredentialPlaintextV1({
                          ref: account,
                          authenticationModeId:
                            request.authenticationModeId,
                          plaintext: current.record,
                        });
                    } catch {
                      throw new LegacyCredentialSettlementConflict();
                    }
                    if (
                      currentAuthentication.authenticationModeId
                        !== request.authenticationModeId
                      || !isDeepStrictEqual(
                        currentPayload.values,
                        request.stagedCredentials,
                      )
                    ) {
                      throw new LegacyCredentialSettlementConflict();
                    }
                    return;
                  }
                  if (
                    (current?.credentialRevision ?? null)
                    !== request.expectedCredentialRevision
                  ) {
                    throw new QualifiedConnectedAccountCompatibilityError(
                      'connected_account_legacy_operation_unsupported',
                    );
                  }
                  const payload =
                    QualifiedConnectedAccountCredentialPayloadV1Schema.parse({
                      v: 1,
                      values: request.stagedCredentials,
                  });
                  const record =
                    projectQualifiedConnectedAccountCredentialPlaintextV1({
                      ref: account,
                      authenticationModeId: request.authenticationModeId,
                      payload,
                      metadata: {
                        ...(request.providerIdentity
                          ? { providerIdentity: request.providerIdentity }
                          : {}),
                        scopes: request.scopes,
                      },
                      now: now(),
                    });
                  const legacyRecord =
                    parseBuiltInLegacyConnectedServiceCredentialRecordV1(record);
                  if (
                    legacyRecord.serviceId !== serviceId
                    || legacyRecord.profileId !== request.accountId
                  ) {
                    throw new QualifiedConnectedAccountCompatibilityError(
                      'connected_account_legacy_operation_unsupported',
                    );
                  }
                  await storeConnectedServiceCredentialForAccount({
                    api,
                    credentials: params.credentials,
                    record: legacyRecord,
                    serverContract:
                      params
                        .resolveSessionSyncPendingInputServerContractResult?.()
                      ?? null,
                    randomBytes,
                  });
                } catch (error) {
                  throw new LegacyCredentialSettlementError(error);
                }
              },
            });
            return Object.freeze({
              status: 'connected' as const,
              account,
            });
          } catch (error) {
            if (error instanceof LegacyCredentialSettlementError) {
              if (
                error.cause
                instanceof LegacyCredentialSettlementConflict
              ) {
                return Object.freeze({
                  status: 'conflict' as const,
                  code: 'connected_account_settlement_conflict',
                });
              }
              if (readHttpStatus(error.cause) === 409) {
                return Object.freeze({
                  status: 'conflict' as const,
                  code: 'connected_account_settlement_conflict',
                });
              }
              throw error.cause;
            }
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
              return Object.freeze({
                status: 'connected' as const,
                account,
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
