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
  type PluginConnectedAccountAuthenticationModeV2,
  type QualifiedConnectedAccountConfigurationSnapshotV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  PluginConnectedAccountCredentialReader,
  PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/runtime';

import {
  readQualifiedConnectedAccountConfigurationV4,
  readQualifiedConnectedAccountCredentialV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import {
  resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import {
  createConnectedAccountConfigurationOwner,
  parseConnectedAccountConfigurationRecordContent,
  type ConnectedAccountConfigurationOwner,
  type ConnectedAccountConfigurationRecord,
  type ConnectedAccountConfigurationTarget,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import type {
  ConnectedAccountRuntimeEstablishedOperation,
  ConnectedAccountRuntimeEstablishedResult,
} from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';

import type { ConnectedAccountDaemonPersistence } from './ConnectedAccountDaemonRuntime';

type MaybePromise<T> = T | Promise<T>;

type CredentialSnapshotReader = typeof readQualifiedConnectedAccountCredentialV4;
type ConfigurationSnapshotReader = typeof readQualifiedConnectedAccountConfigurationV4;
type QualifiedConnectedAccountCredentialSnapshotV4 = ReturnType<
  typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse
>;

export type QualifiedConnectedAccountEstablishedRuntimeOwner = Readonly<{
  invokeWithReceipt<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
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
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>,
  ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>>;
}>;

export type RevisionedLegacyConnectedAccountMaterializationOwner =
  Readonly<{
    invoke(input: Readonly<{
      account: QualifiedConnectedAccountRef;
      serviceId: BuiltInLegacyConnectedServiceId;
      request: Extract<
        ConnectedAccountRuntimeEstablishedOperation,
        { kind: 'materialize' }
      >['request'];
      signal?: AbortSignal;
    }>): Promise<
      ConnectedAccountRuntimeEstablishedResult<
        Extract<
          ConnectedAccountRuntimeEstablishedOperation,
          { kind: 'materialize' }
        >
      >
    >;
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

function resolveCryptoMaterial(credentials: Credentials): AccountScopedCryptoMaterial {
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

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Connected-account established operation was aborted');
}

function openEnvelope(input: Readonly<{
  kind: 'credential' | 'configuration';
  accountMode: Exclude<ConnectedServiceAccountEncryptionMode, 'unknown'>;
  material: AccountScopedCryptoMaterial;
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
        material: input.material,
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

function assertSnapshotPair(input: Readonly<{
  credential: QualifiedConnectedAccountCredentialSnapshotV4;
  configuration: QualifiedConnectedAccountConfigurationSnapshotV4 | null;
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
    credentials: Credentials;
    getAccountEncryptionMode(): Promise<ConnectedServiceAccountEncryptionMode>;
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
    credential: QualifiedConnectedAccountCredentialSnapshotV4;
    configuration: QualifiedConnectedAccountConfigurationSnapshotV4 | null;
  }>> {
    assertNotAborted(signal);
    const credential = await readCredential({
      token: params.credentials.token,
      ref: account,
    });
    assertNotAborted(signal);
    if (!credential) {
      throw new Error('Connected-account credential snapshot is unavailable');
    }
    assertCredentialSnapshotIdentity(credential, account);
    const configuration = credential.configurationRevision === null
      ? null
      : await readConfiguration({
          token: params.credentials.token,
          target: accountTarget(account),
        });
    assertNotAborted(signal);
    if (configuration) assertConfigurationSnapshotIdentity(configuration, account);
    assertSnapshotPair({ credential, configuration });
    return Object.freeze({ credential, configuration });
  }

  async function invokeWithReceipt<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation,
  >(
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      operation: TOperation;
      assertEffectfulOperationAllowed?: () => void;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{
    result: ConnectedAccountRuntimeEstablishedResult<TOperation>;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>> {
      assertNotAborted(input.signal);
      const accountMode = await params.getAccountEncryptionMode();
      if (accountMode === 'unknown') {
        throw new Error('Connected-account account encryption mode is unavailable');
      }
      const initial = await readExactSnapshots(input.account, input.signal);
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
        const credentialReader: PluginConnectedAccountCredentialReader =
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
            expectedCredentialRevision: initial.credential.credentialRevision,
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
          async isCredentialRevisionCurrent() {
            const latest = await readCredential({
              token: params.credentials.token,
              ref: input.account,
            });
            return Boolean(
              latest
              && sameAccount(latest.ref, input.account)
              && latest.credentialRevision === initial.credential.credentialRevision,
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
                    material,
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

  return Object.freeze({
    invokeWithReceipt,
    async invoke<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
      input: Readonly<{
        account: QualifiedConnectedAccountRef;
        operation: TOperation;
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
    credentials: Credentials;
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

  return Object.freeze({
    async invoke(input) {
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
                  material,
                  payload: resolution.record,
                  randomBytes,
                });
          return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref: input.account,
            authenticationModeId,
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
      return await owner.invoke({
        account: input.account,
        operation: {
          kind: 'materialize',
          request: input.request,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  });
}
