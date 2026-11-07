import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
  randomBytes as nodeRandomBytes,
  randomUUID,
} from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createConnectedAccountCredentialSettlement } from '@happier-dev/cli-common/connectedAccounts';
import { promoteConnectedAccountCredentialSecrets } from '@/settings/secrets/promoteConnectedAccountCredentialSecrets';

import { ConnectedConfigurationCatalogV1Schema, openConnectedAccountCatalogContentV1,
  type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { replaceConnectedServiceConfigurationCatalogV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { connectedAccountSourceCustodyV1Equal } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
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
  mutateQualifiedConnectedAccountCredentialHealthV4,
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountConfigurationV4,
  readQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { AccountEncryptionModeReadOptions, ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type {
  SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
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
import { promoteSavedSecretsWithConnectedAccountCatalog } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { acquireSavedSecretMaterializerForOperation, readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import {
  createSavedSecretMaterializerFromSnapshotV1,
  type SavedSecretMaterializerV1,
} from '@/settings/secrets/savedSecretCatalog';
import {
  createConnectedAccountAttemptConfigurationStore,
  parseConnectedAccountConfigurationRecordContent,
  resolveConnectedAccountPublicOAuthClient,
} from '@happier-dev/cli-common/connectedAccounts';
import type {
  ConnectedAccountAttemptAddressOwner,
  ConnectedAccountDeviceTransactionOwner,
  ConnectedAccountOAuthTransactionOwner,
} from '@happier-dev/cli-common/connectedAccounts';
import type { PendingConnectedAccountAttemptTransaction } from '@/api/client/connectedAccountAttemptTransactionApi';

import type { ConnectedAccountDaemonPersistence } from './ConnectedAccountDaemonRuntime';

type CredentialReader = typeof readQualifiedConnectedAccountCredentialV4;
type ConfigurationReader = typeof readQualifiedConnectedAccountConfigurationV4;
type CredentialMutator = typeof mutateQualifiedConnectedAccountCredentialV4;
type CredentialHealthMutator = typeof mutateQualifiedConnectedAccountCredentialHealthV4;
type ConfigurationMutator = typeof mutateQualifiedConnectedAccountConfigurationV4;
type ProfileLister = (params: Parameters<typeof listQualifiedConnectedAccountsV4>[0]) => ReturnType<typeof listQualifiedConnectedAccountsV4>;
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
export type QualifiedConnectedAccountAttemptTransactionAdapters = Readonly<{
  address?: ConnectedAccountAttemptAddressOwner;
  oauth?: ConnectedAccountOAuthTransactionOwner;
  device?: ConnectedAccountDeviceTransactionOwner;
  listPending?(service: Readonly<{ pluginId: string; localId: string }>): Promise<readonly PendingConnectedAccountAttemptTransaction[]>;
}>;

type ConfigurationRecord = ReturnType<
  typeof parseConnectedAccountConfigurationRecordContent
>;
type ConfigurationContent = Omit<ConfigurationRecord, 'revision'>;
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
  return parseConnectedAccountConfigurationRecordContent(
    input.content,
    input.revision,
    input.scope,
  );
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
  secretSources?: TargetSecretSourcesV1;
}>): ConnectedAccountDaemonPersistence['configuration']['secrets'] {
  return createAccountSettingsConnectedAccountSecrets(input);
}

/** Same configuration/Saved Secret authority, bound either to the daemon or an admitted Session. */
export function createAccountSettingsConnectedAccountSecrets(input: Readonly<{
  expectedScopeKey: string;
  operationContext?: SavedSecretOperationContextV1;
  secretSources?: TargetSecretSourcesV1;
}>): ConnectedAccountDaemonPersistence['configuration']['secrets'] {
  const readSnapshot = input.operationContext ? () => input.operationContext!.readSnapshot() : getActiveAccountSettingsSnapshot;
  const operationReader = (materializer: SavedSecretMaterializerV1) => {
    const readMaterial: NonNullable<ConnectedAccountDaemonPersistence['configuration']['secrets']['readMaterial']> = async (secretId, options) => {
      options?.signal?.throwIfAborted();
      const resolved = materializer.resolve(secretId);
      if (resolved.status !== 'ready' && resolved.sourceFailure) {
        throw new PluginError({ code: 'secret_missing', message: 'Account secret material is unavailable',
          details: { materialStatus: resolved.status, sourceFailure: resolved.sourceFailure },
          retryable: resolved.status === 'temporarily_unavailable' });
      }
      return resolved.status === 'ready' ? Object.freeze({ value: resolved.value, fingerprint: resolved.fingerprint }) : null;
    };
    return Object.freeze({ readMaterial, read: async (secretId: string, options?: Readonly<{ signal?: AbortSignal }>) =>
      (await readMaterial(secretId, options))?.value ?? null });
  };
  const readMaterial: NonNullable<ConnectedAccountDaemonPersistence['configuration']['secrets']['readMaterial']> = async (secretId, options) => {
    options?.signal?.throwIfAborted();
    if (input.operationContext && !await input.operationContext.isCurrent(options?.signal)) return null;
    const snapshot = readSnapshot();
    if (!snapshot || snapshot.scopeKey !== input.expectedScopeKey) return null;
    const materializer = await acquireSavedSecretMaterializerForOperation({ snapshot, references: [{ ref: secretId }],
      operationContext: input.operationContext, secretSources: input.secretSources, signal: options?.signal });
    return operationReader(materializer).readMaterial(secretId, options);
  };
  return Object.freeze({
    async admit(secretIds, options) {
      // A record without references has nothing to admit; the admission owner
      // itself resolves personal-only batches without a Home request.
      if (secretIds.length === 0) return;
      const { materializer } = await readSavedSecretMaterializerForOperation({
        expectedScopeKey: input.expectedScopeKey,
        secretSources: input.secretSources,
        ...(input.operationContext ? { operationContext: input.operationContext } : {}),
        references: secretIds.map((ref) => ({ ref })),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return operationReader(materializer);
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
    getAccountEncryptionMode(options?: AccountEncryptionModeReadOptions): Promise<ConnectedServiceAccountEncryptionMode>;
    readCredential?: CredentialReader;
    readConfiguration?: ConfigurationReader;
    mutateCredential?: CredentialMutator;
    mutateCredentialHealth?: CredentialHealthMutator;
    mutateConfiguration?: ConfigurationMutator;
    listProfiles?: ProfileLister;
    resolveServerFeaturesSnapshot?: (
      ) => CliServerFeaturesSnapshot | undefined;
    resolveSessionSyncPendingInputServerContractResult?: (
      ) => SessionSyncPendingInputServerContractResult | null;
    secrets: ConnectedAccountDaemonPersistence['configuration']['secrets'];
    randomBytes?: (length: number) => Uint8Array;
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
  const mutateCredentialHealth =
    params.mutateCredentialHealth ?? mutateQualifiedConnectedAccountCredentialHealthV4;
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
  const attemptConfigurations = createConnectedAccountAttemptConfigurationStore({
    createRevision: createConfigurationRevision,
    transactions: params.attemptTransactions,
  });

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

  async function resolveAccountMode(options?: AccountEncryptionModeReadOptions): Promise<
    Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'>
  > {
    const mode = await params.getAccountEncryptionMode(options);
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
            requestPurpose: 'connected-accounts:persistence',
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
      async readPublicOAuthClient(...[input, options]: Parameters<NonNullable<
        ConnectedAccountDaemonPersistence['configuration']['readPublicOAuthClient']
      >>) {
        options?.signal?.throwIfAborted();
        const snapshot = params.resolveServerFeaturesSnapshot?.();
        return resolveConnectedAccountPublicOAuthClient({
          clients: snapshot?.status === 'ready'
            ? snapshot.features.capabilities.connectedServices.publicOAuthClients
            : undefined,
          service: input.service,
          modeId: input.modeId,
        });
      },
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
          return attemptConfigurations.read(target);
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
            requestPurpose: 'connected-accounts:persistence',
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
          return attemptConfigurations.replace({ ...input, target: input.target });
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
                requestPurpose: 'connected-accounts:persistence',
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
              const accountMode = await resolveAccountMode({ usage: 'fresh-authority' });
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
        await attemptConfigurations.destroy(attemptId);
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
        async findByProviderIdentity({ service, providerIdentity }: Parameters<NonNullable<
          ConnectedAccountDaemonPersistence['attempts']['accounts']['findByProviderIdentity']
        >>[0]) {
          const profiles = await persistence.profiles.list(service);
          return profiles.filter(profile => sameService(profile.ref.service, service)
            && profile.providerIdentity?.accountId === providerIdentity.accountId
            && (profile.providerIdentity?.organizationId ?? null) === (providerIdentity.organizationId ?? null))
            .sort((left, right) => left.ref.accountId.localeCompare(right.ref.accountId))[0] ?? null;
        },
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
              requestPurpose: 'connected-accounts:persistence',
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
        params.attemptTransactions?.oauth ?? Object.freeze({
          async create() {
            throw Object.assign(
              new Error('Connected-account durable OAuth transaction support is unavailable'),
              { code: 'connected_account_oauth_transaction_unavailable' as const },
            );
          },
        }),
      attemptAddresses: params.attemptTransactions?.address,
      ...(params.attemptTransactions?.device
        ? { deviceTransactions: params.attemptTransactions.device }
        : {}),
      listPending: params.attemptTransactions?.listPending ?? (async () => {
        throw new Error('Connected-account pending attempt discovery is unavailable');
      }),
      settlement: createConnectedAccountCredentialSettlement({
        now,
        promoteCredentialSecrets: input => promoteConnectedAccountCredentialSecrets({ credentials: params.credentials, ...input,
          ...(params.operationContext ? { operationContext: params.operationContext } : {}) }),
        rotateCredentialSecrets: async ({ secrets }) => {
          const { updateOwnedSavedSecretResourceForOperation } = await import('@/settings/secrets/personalSavedSecretActionHost');
          for (const secret of secrets) await updateOwnedSavedSecretResourceForOperation({ credentials: params.credentials,
            resourceId: secret.resourceId, nextValue: secret.value,
            ...(params.operationContext ? { operationContext: params.operationContext } : {}) });
          return 'applied';
        },
        resolveAccountMode: usage => resolveAccountMode(usage ? { usage } : undefined),
        seal: (kind, accountMode, payload) => sealContent({ kind, accountMode, credentials: params.credentials, material, payload, randomBytes }),
        open: (kind, accountMode, envelope) => openContent({ kind, accountMode, credentials: params.credentials, material, envelope }),
        parseConfigurationContent: (content, revision) => configurationContent(parsePhysicalConfigurationRecord({ content, revision, scope: 'account' })),
        mutateCredential: (mutation, request) => executeNegotiatedOperation({
          service: mutation.ref.service,
          operation: { kind: 'credential_write', configurationState: request.expectedConfigurationRevision === 'unconfigured'
            && request.stagedAccountConfigurationContent === undefined ? 'unconfigured' : 'configured' },
          executeV4: () => mutateCredential({ token: params.credentials.token, mutation }),
        }),
        mutateCredentialHealth: async patch => {
          await mutateCredentialHealth({ token: params.credentials.token, patch });
        },
        readCredential: ref => readCredential({ token: params.credentials.token, ref, requestPurpose: 'connected-accounts:persistence' }),
        readConfiguration: ref => readConfiguration({ token: params.credentials.token, target: accountTarget(ref), requestPurpose: 'connected-accounts:persistence' }),
        readHttpStatus,
        readFailureReason: error => error instanceof QualifiedConnectedAccountCredentialConflictError ? error.reason : null,
        readFailureCode: error => {
          if (error instanceof QualifiedConnectedAccountCredentialConflictError) return error.code;
          if (!error || typeof error !== 'object') return null;
          const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
          return typeof code === 'string' ? code : null;
        },
        onSettled: params.onAccountSettled,
        onPublicationFailure: () => logger.debug('[DAEMON] Qualified Connected Account quota source initialization failed (non-fatal)'),
        onUnknown: ({ account, reconciliation, failedStage, recoveryStage, error, recoveryError }) => {
          const transportFailureCode = (cause: unknown) => {
            if (typeof cause !== 'object' || cause === null) return null;
            const code: unknown = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
            return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET'
              || code === 'ECONNREFUSED' || code === 'ERR_NETWORK' ? code : null;
          };
          logger.warn('[DAEMON] Qualified Connected Account settlement remains unknown', {
            account, reconciliation, failedStage, recoveryStage,
            failureCode: transportFailureCode(error), failureHttpStatus: readHttpStatus(error) ?? null,
            recoveryCode: transportFailureCode(recoveryError), recoveryHttpStatus: readHttpStatus(recoveryError) ?? null,
          });
        },
      }),
      }),
  });
  return persistence;
}
