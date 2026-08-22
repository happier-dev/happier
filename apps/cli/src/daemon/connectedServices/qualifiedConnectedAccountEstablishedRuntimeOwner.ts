import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  QualifiedConnectedAccountCredentialPayloadV1Schema,
  QualifiedConnectedAccountCredentialMetadataV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  projectQualifiedConnectedAccountCredentialPlaintextV1,
  sealQualifiedConnectedAccountContentEnvelope,
  type AccountScopedCryptoMaterial,
  type BuiltInLegacyConnectedServiceId,
  type ConnectedServiceCredentialRevisionV1,
  type PluginConnectedAccountAuthenticationModeV2,
  type QualifiedConnectedAccountConfigurationSnapshotV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
  readQualifiedConnectedAccountConfigurationV4,
  readQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import {
  resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
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
type RevisionedQualifiedConnectedAccountConfigurationSnapshotV4 = Extract<
  QualifiedConnectedAccountConfigurationSnapshotV4,
  { revisionSemantics: 'revisioned' }
>;

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

type RevisionedLegacyConnectedAccountMaterializationOperation = Extract<
  ConnectedAccountRuntimeEstablishedOperation,
  { kind: 'materialize' }
>;
type RevisionedLegacyConnectedAccountMaterializationInput = Readonly<{
  account: QualifiedConnectedAccountRef;
  serviceId: BuiltInLegacyConnectedServiceId;
  request: RevisionedLegacyConnectedAccountMaterializationOperation['request'];
  /** Host-private callback fence; never a public plugin capability field. */
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
  signal?: AbortSignal;
}>;
type RevisionedLegacyConnectedAccountMaterializationResult =
  ConnectedAccountRuntimeEstablishedResult<
    RevisionedLegacyConnectedAccountMaterializationOperation
  >;

export type RevisionedLegacyConnectedAccountMaterializationOwner = Readonly<{
  invokeWithReceipt(
    input: RevisionedLegacyConnectedAccountMaterializationInput,
  ): Promise<Readonly<{
    result: RevisionedLegacyConnectedAccountMaterializationResult;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>>;
  invoke(
    input: RevisionedLegacyConnectedAccountMaterializationInput,
  ): Promise<RevisionedLegacyConnectedAccountMaterializationResult>;
}>;

export type QualifiedConnectedAccountEstablishedInvocationBasis = Readonly<{
  credentialRevision: string;
  credentialConfigurationRevision: string | null;
  runtimeConfigurationRevision: string;
  generation: string;
  immutableGenerationId: string;
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

function sameAccount(
  left: QualifiedConnectedAccountRef,
  right: QualifiedConnectedAccountRef,
): boolean {
  return sameService(left.service, right.service)
    && left.accountId === right.accountId;
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

function resolveCryptoMaterial(
  credentials: StoredCredentials,
): AccountScopedCryptoMaterial | null {
  if (!credentials.encryption) return null;
  return credentials.encryption.type === 'legacy'
    ? Object.freeze({
        type: 'legacy' as const,
        secret: credentials.encryption.secret,
      })
    : Object.freeze({
        type: 'dataKey' as const,
        machineKey: credentials.encryption.machineKey,
      });
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
  if (!sameAccount(snapshot.ref, account)) {
    throw new Error('Connected-account credential snapshot does not match the exact qualified account');
  }
}

function assertConfigurationSnapshotIdentity(
  snapshot: QualifiedConnectedAccountConfigurationSnapshotV4,
  account: QualifiedConnectedAccountRef,
): void {
  if (
    snapshot.target.kind !== 'account'
    || !sameAccount(snapshot.target.ref, account)
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
          createConnectedAccountConfigurationOwner({
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
                || !sameAccount(target.account, exactConfigurationTarget.account)
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
            isGenerationCurrent: () => (
              params.reloadController.isRuntimeRegistryCurrent(lease.registry)
              && runtimeLease.isCurrent()
            ),
          });
        const admittedConfiguration = await configurationOwner.admit({
          intent: 'reconnect',
          service: input.account.service,
          account: input.account,
          mode,
          generation: runtimeLease.generation,
          immutableGenerationId: runtimeLease.immutableGenerationId,
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
              && sameAccount(latest.ref, input.account)
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
            generation: runtimeLease.generation,
            immutableGenerationId: runtimeLease.immutableGenerationId,
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

export function createRevisionedLegacyConnectedAccountMaterializationOwner(
  params: Readonly<{
    reloadController: Pick<
      PluginReloadController,
      'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
    >;
    credentials: StoredCredentials;
    api: Pick<
      ConnectedServiceCredentialApi,
      | 'getAccountEncryptionMode'
      | 'getConnectedServiceCredentialPlain'
      | 'getConnectedServiceCredentialSealed'
    >;
    getAccountEncryptionMode():
      Promise<ConnectedServiceAccountEncryptionMode>;
    configuration: Pick<
      ConnectedAccountDaemonPersistence['configuration'],
      'read' | 'secrets'
    >;
    randomBytes?: (length: number) => Uint8Array;
  }>,
): RevisionedLegacyConnectedAccountMaterializationOwner {
  const material = resolveCryptoMaterial(params.credentials);
  const randomBytes =
    params.randomBytes
    ?? ((length: number) => new Uint8Array(nodeRandomBytes(length)));

  async function invokeWithReceipt(
    input: RevisionedLegacyConnectedAccountMaterializationInput,
  ): Promise<Readonly<{
    result: RevisionedLegacyConnectedAccountMaterializationResult;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>> {
      const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
          input.serviceId
        ];
      if (
        !sameService(compatibility.service, input.account.service)
      ) {
        throw new Error(
          'Revisioned legacy Connected Account service identity mismatch',
        );
      }
      const accountMode =
        await params.getAccountEncryptionMode();
      if (accountMode === 'unknown') {
        throw new Error(
          'Connected-account account encryption mode is unavailable',
        );
      }
      const readCredential: CredentialSnapshotReader =
        async ({ ref }) => {
          if (!sameAccount(ref, input.account)) return null;
          const resolutions =
            await resolveConnectedServiceCredentialResolutions({
              credentials: params.credentials,
              api: params.api,
              bindings: [{
                serviceId: input.serviceId,
                profileId: input.account.accountId,
              }],
            });
          const resolution = resolutions.get(input.serviceId);
          if (
            !resolution
            || resolution.revisionSemantics !== 'revisioned'
          ) {
            throw new Error(
              'Revisioned legacy Connected Account credential is unavailable',
            );
          }
          const authenticationModeByCredentialKind:
            Readonly<Partial<Record<'oauth' | 'token', string>>> =
              compatibility.authenticationModeByCredentialKind;
          const authenticationModeId =
            authenticationModeByCredentialKind[
              resolution.record.kind
            ];
          if (!authenticationModeId) {
            throw new Error(
              'Revisioned legacy Connected Account authentication mode is unsupported',
            );
          }
          const providerAccountId =
            resolution.record.kind === 'oauth'
              ? resolution.record.oauth.providerAccountId
              : resolution.record.token.providerAccountId;
          const providerEmail =
            resolution.record.kind === 'oauth'
              ? resolution.record.oauth.providerEmail
              : resolution.record.token.providerEmail;
          const scopes =
            resolution.record.kind === 'oauth'
            && resolution.record.oauth.scope
              ? resolution.record.oauth.scope
                  .split(/\s+/u)
                  .filter(Boolean)
              : [];
          const content =
            accountMode === 'plain'
              ? {
                  t: 'plain' as const,
                  v: resolution.record,
                }
              : sealQualifiedConnectedAccountContentEnvelope({
                  kind: 'credential',
                  accountMode: 'e2ee',
                  material: requireCryptoMaterial(
                    params.credentials,
                    material,
                  ),
                  payload: resolution.record,
                  randomBytes,
                });
          return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref: input.account,
            authenticationModeId,
            revisionSemantics: 'revisioned',
            credentialRevision:
              resolution.credentialRevision,
            configurationRevision: null,
            content,
            metadata:
              QualifiedConnectedAccountCredentialMetadataV4Schema.parse({
                ...(providerAccountId || providerEmail
                  ? {
                      providerIdentity: {
                        ...(providerAccountId
                          ? { accountId: providerAccountId }
                          : {}),
                        ...(providerEmail
                          ? { email: providerEmail }
                          : {}),
                      },
                    }
                  : {}),
                scopes,
              }),
          });
        };
      const owner =
        createQualifiedConnectedAccountEstablishedRuntimeOwner({
          reloadController: params.reloadController,
          credentials: params.credentials,
          getAccountEncryptionMode: async () => accountMode,
          readCredential,
          readConfiguration: async () => null,
          configuration: params.configuration,
          randomBytes,
        });
      return await owner.invokeWithReceipt({
        account: input.account,
        operation: {
          kind: 'materialize',
          request: input.request,
        },
        ...(input.expectedCredentialRevision
          ? { expectedCredentialRevision: input.expectedCredentialRevision }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
  }

  return Object.freeze({
    invokeWithReceipt,
    async invoke(input) {
      return (await invokeWithReceipt(input)).result;
    },
  });
}
