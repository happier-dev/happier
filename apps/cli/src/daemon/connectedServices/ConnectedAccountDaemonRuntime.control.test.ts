import { describe, expect, it, vi } from 'vitest';
import {
  PluginConnectedAccountDescriptorContributionV2Schema,
} from '@happier-dev/protocol';

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import {
  createConnectedAccountContributionRegistry,
  type ConnectedAccountRuntimeRegistration,
} from '@/plugins/runtime/connectedAccounts/contributionRegistry';
import type {
  ConnectedAccountConfigurationRecord,
  ConnectedAccountConfigurationTarget,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import type {
  ResolvedConnectedAccountDescriptorContribution,
} from '@/plugins/projection/registry/types';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from './qualifiedConnectedAccountEstablishedRuntimeOwner';

import {
  createConnectedAccountDaemonRuntime,
  type ConnectedAccountDaemonPersistence,
} from './ConnectedAccountDaemonRuntime';

type ConfigurationConsequenceApply = Parameters<
  typeof createConnectedAccountDaemonRuntime
>[0]['configurationConsequences']['apply'];

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });
const account = Object.freeze({ service, accountId: 'account-1' });
const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
  id: service.localId,
  title: 'Acme Work',
  authentication: {
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      pkce: 'required',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'service',
        changeBehavior: 'refresh',
        fields: [{
          id: 'endpoint',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 1 },
          semantic: 'connectedAccountOrigin',
          required: true,
        }, {
          id: 'clientSecret',
          title: 'Client secret',
          schema: { type: 'string', minLength: 1 },
          required: true,
          secret: true,
        }],
      },
    }, {
      id: 'account-oauth',
      kind: 'oauthDeviceCode',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'account',
        changeBehavior: 'reconnect',
        fields: [{
          id: 'tenant',
          title: 'Tenant',
          schema: { type: 'string', minLength: 1 },
          required: true,
        }],
      },
    }],
  },
});

describe('ConnectedAccountDaemonRuntime control facade', () => {
  it.each(['beginConnect', 'beginReconnect'] as const)(
    'fails %s at persistence admission before acquiring or invoking plugin runtime',
    async (operation) => {
      const unsupported = Object.assign(
        new Error('legacy unfenced mutation unsupported'),
        { code: 'connected_account_legacy_operation_unsupported' },
      );
      const assertAuthenticationActionAllowed = vi.fn(() => {
        throw unsupported;
      });
      const acquireRuntimeRegistry = vi.fn();
      const daemon = createConnectedAccountDaemonRuntime({
        reloadController: {
          acquireRuntimeRegistry,
        } as unknown as PluginReloadController,
        persistence: {
          profiles: { list: vi.fn(async () => []) },
          configuration: {
            read: vi.fn(async () => null),
            replace: vi.fn(),
            destroyAttempt: vi.fn(),
            secrets: {
              has: vi.fn(async () => false),
              read: vi.fn(async () => null),
            },
          },
          attempts: {
            assertAuthenticationActionAllowed,
            accounts: { readExact: vi.fn(async () => null) },
            oauth: { create: vi.fn() },
            settlement: { settle: vi.fn() },
          },
        } as unknown as ConnectedAccountDaemonPersistence,
        configurationConsequences: {
          assertAvailable: vi.fn(),
          apply: vi.fn(),
        },
        revocation: {} as never,
      });

      await expect(daemon.execute(
        operation === 'beginConnect'
          ? {
              operation,
              service,
              modeId: 'oauth',
            }
          : {
              operation,
              account,
            },
      )).rejects.toBe(unsupported);
      expect(assertAuthenticationActionAllowed).toHaveBeenCalledOnce();
      expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
    },
  );

  it('revalidates mutable peer admission before an active attempt invokes its plugin', async () => {
    const manualDescriptor =
      PluginConnectedAccountDescriptorContributionV2Schema.parse({
        id: service.localId,
        title: 'Acme Work',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Token',
              schema: { type: 'string' },
              secret: true,
            }],
          }],
        },
      });
    let peer: 'v4' | 'exact-old' = 'v4';
    const assertAuthenticationActionAllowed = vi.fn((_input: unknown) => {
      if (peer === 'exact-old') {
        throw Object.assign(
          new Error('credential write is no longer supported'),
          { code: 'connected_account_legacy_operation_unsupported' },
        );
      }
    });
    const invokeAuthentication = vi.fn();
    const runtimeLease = Object.freeze({
      ref: service,
      descriptor: manualDescriptor,
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
      runtime: {},
      isCurrent: () => true,
    });
    const registry = {
      generation: 'generation-1',
      connectedAccountContributions: {
        list: () => [{ ref: service }],
      },
      resolveConnectedAccountRuntime: vi.fn(async () => runtimeLease),
      connectedAccountRuntimeInvoker: { invokeAuthentication },
    };
    const lease = () => ({
      registry,
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    });
    const daemon = createConnectedAccountDaemonRuntime({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => lease()),
        tryAcquireRuntimeRegistry: vi.fn(() => lease()),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as PluginReloadController,
      persistence: {
        profiles: { list: vi.fn(async () => []) },
        configuration: {
          read: vi.fn(async () => null),
          replace: vi.fn(),
          destroyAttempt: vi.fn(),
          secrets: {
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
        attempts: {
          assertAuthenticationActionAllowed,
          accounts: { readExact: vi.fn(async () => null) },
          oauth: { create: vi.fn() },
          settlement: { settle: vi.fn() },
        },
      } as unknown as ConnectedAccountDaemonPersistence,
      configurationConsequences: {
        assertAvailable: vi.fn(),
        apply: vi.fn(),
      },
      revocation: {} as never,
    });

    const activeAttempt = await daemon.execute({
      operation: 'beginConnect',
      service,
      modeId: 'manual',
    });
    expect(activeAttempt).toEqual({
      status: 'awaitingManual',
      attemptId: expect.any(String),
    });
    const beginAdmission = assertAuthenticationActionAllowed.mock.calls.at(-1);
    expect(beginAdmission?.[0]).toMatchObject({
      intent: 'connect',
      service,
      authenticationModeId: 'manual',
      authenticationModeCardinality: 'single',
      configurationState: 'unconfigured',
    });
    if (activeAttempt.status !== 'awaitingManual') {
      throw new Error('manual attempt did not start');
    }
    peer = 'exact-old';
    await expect(daemon.execute({
      operation: 'submitManual',
      attemptId: activeAttempt.attemptId,
      fields: { token: 'secret' },
    })).resolves.toEqual({
      status: 'unavailable',
      attemptId: activeAttempt.attemptId,
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(invokeAuthentication).not.toHaveBeenCalled();
  });

  it('rejects an unsupported account-list peer before acquiring plugin runtime', async () => {
    const unsupported = Object.assign(
      new Error('exact peer does not support this service'),
      { code: 'connected_account_service_identity_unsupported' },
    );
    const acquireRuntimeRegistry = vi.fn();
    const daemon = createConnectedAccountDaemonRuntime({
      reloadController: {
        acquireRuntimeRegistry,
      } as unknown as PluginReloadController,
      persistence: {
        profiles: { list: vi.fn(async () => []) },
        configuration: {
          read: vi.fn(async () => null),
          replace: vi.fn(),
          destroyAttempt: vi.fn(),
          secrets: {
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
        attempts: {
          accounts: { readExact: vi.fn(async () => null) },
          oauth: { create: vi.fn() },
          settlement: { settle: vi.fn() },
        },
      } as unknown as ConnectedAccountDaemonPersistence,
      resolvePeerOperationTransport: vi.fn(() => {
        throw unsupported;
      }),
      configurationConsequences: {
        assertAvailable: vi.fn(),
        apply: vi.fn(),
      },
      revocation: {} as never,
    });

    await expect(daemon.control({
      operation: 'describeService',
      service,
      requiredOperation: 'account_list',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_service_identity_unsupported',
    });
    expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
  });

  it('keeps revisioned legacy credential deletion on its exact guarded route', async () => {
    const legacyService = Object.freeze({
      pluginId: 'happier.scm.forge.github',
      localId: 'github-account',
    });
    const legacyAccount = Object.freeze({
      service: legacyService,
      accountId: 'work',
    });
    const deleteConnectedServiceCredentialRevisioned =
      vi.fn(async () => undefined);
    const invokeWithReceipt = vi.fn();
    const daemon = createConnectedAccountDaemonRuntime({
      reloadController: {} as PluginReloadController,
      persistence: {
        profiles: { list: vi.fn(async () => []) },
        configuration: {
          read: vi.fn(async () => null),
          replace: vi.fn(),
          destroyAttempt: vi.fn(),
          secrets: {
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
        attempts: {
          accounts: { readExact: vi.fn(async () => null) },
          oauth: { create: vi.fn() },
          settlement: { settle: vi.fn() },
        },
      } as unknown as ConnectedAccountDaemonPersistence,
      resolvePeerOperationTransport: () => ({
        kind: 'legacy',
        peerClass: 'revisioned_v2_v3',
        serviceId: 'github',
      }),
      configurationConsequences: {
        assertAvailable: vi.fn(),
        apply: vi.fn(),
      },
      revocation: {
        token: 'token-1',
        establishedRuntimeOwner: {
          invokeWithReceipt,
        } as unknown as Pick<
          QualifiedConnectedAccountEstablishedRuntimeOwner,
          'invokeWithReceipt'
        >,
        resolveV4Support: () => 'absent',
        legacyCredentialApi: {
          getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
          getConnectedServiceCredentialPlain: vi.fn(async () => ({
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            content: {
              t: 'plain' as const,
              v: {
                v: 1 as const,
                serviceId: 'github' as const,
                profileId: 'work',
                createdAt: 1,
                updatedAt: 1,
                expiresAt: null,
                kind: 'token' as const,
                oauth: null,
                token: {
                  token: 'secret',
                  providerAccountId: null,
                  providerEmail: null,
                  raw: null,
                },
              },
            },
          })),
          getConnectedServiceCredentialSealed: vi.fn(),
          deleteConnectedServiceCredentialRevisioned,
        },
      },
    });

    await expect(daemon.control({
      operation: 'revokeAccount',
      account: legacyAccount,
      cleanupGroupReferences: true,
    })).resolves.toEqual({
      status: 'revoked',
      account: legacyAccount,
      remoteStatus: 'remoteUnsupported',
    });
    expect(deleteConnectedServiceCredentialRevisioned).toHaveBeenCalledWith({
      storageMode: 'plain',
      serviceId: 'github',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      cleanupGroupReferences: true,
    });
    expect(invokeWithReceipt).not.toHaveBeenCalled();
  });

  it('describes one current qualified service and owns normalized configuration read/replace', async () => {
    const records = new Map<string, ConnectedAccountConfigurationRecord>();
    let nextRevision = 2;
    const key = (target: ConnectedAccountConfigurationTarget) =>
      JSON.stringify(target);
    const target = Object.freeze({
      kind: 'service' as const,
      service,
      modeId: 'oauth',
    });
    records.set(key(target), {
      revision: 'configuration-1',
      values: { endpoint: 'https://old.example.test' },
      secretRefs: { clientSecret: 'saved-secret-1' },
    });
    const secondAccount = Object.freeze({
      service,
      accountId: 'account-2',
    });
    const otherModeAccount = Object.freeze({
      service,
      accountId: 'account-other-mode',
    });
    const foreignAccount = Object.freeze({
      service: {
        pluginId: 'other.accounts',
        localId: service.localId,
      },
      accountId: 'account-foreign',
    });
    const listProfiles = vi.fn(async () => [{
      ref: account,
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-1',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }, {
      ref: secondAccount,
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-2',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }, {
      ref: otherModeAccount,
      status: 'connected' as const,
      authenticationModeId: 'account-oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-3',
      configurationReady: true,
      configurationRevision: 'account-configuration-1',
      scopes: [],
    }, {
      ref: foreignAccount,
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-4',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }]);
    const readExact = vi.fn<
      ConnectedAccountDaemonPersistence['attempts']['accounts']['readExact']
    >(async () => ({
      account,
      authenticationModeId: 'oauth',
      credentialRevision: 'credential-1',
      configurationRevision: 'configuration-1',
    }));
    const persistence: ConnectedAccountDaemonPersistence = {
      profiles: {
        list: listProfiles,
      },
      configuration: {
        read: vi.fn(async (configurationTarget) =>
          records.get(key(configurationTarget)) ?? null),
        replaceForControl: vi.fn(async (input) => {
          const current = records.get(key(input.target)) ?? null;
          if ((current?.revision ?? null) !== input.expectedRevision) {
            return { status: 'conflict' as const };
          }
          const record = {
            revision: `configuration-${nextRevision++}`,
            values: input.values,
            secretRefs: Object.freeze({
              ...input.currentSecretRefs,
              ...Object.fromEntries(
                Object.keys(input.secretValues).map((fieldId) => [
                  fieldId,
                  `saved-secret-${nextRevision}`,
                ]),
              ),
            }),
          };
          records.set(key(input.target), record);
          return { status: 'committed' as const, record };
        }),
        replace: vi.fn(async (input) => {
          const current = records.get(key(input.target)) ?? null;
          if ((current?.revision ?? null) !== input.expectedRevision) {
            return { status: 'conflict' as const };
          }
          const record = {
            revision: `configuration-${nextRevision++}`,
            ...input.replacement,
          };
          records.set(key(input.target), record);
          return { status: 'committed' as const, record };
        }),
        destroyAttempt: vi.fn(),
        secrets: {
          has: vi.fn(async (id) => id.startsWith('saved-secret-')),
          read: vi.fn(async () => 'secret'),
        },
      },
      attempts: {
        accounts: {
          readExact,
        },
        oauth: {
          create: vi.fn(),
        },
        settlement: {
          settle: vi.fn(),
        },
      },
    };
    const runtimeLease = Object.freeze({
      ref: service,
      descriptor,
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
      runtime: {},
      isCurrent: () => true,
    });
    const registry = {
      generation: 'generation-1',
      connectedAccountContributions: {
        list: () => [{ ref: service }],
      },
      resolveConnectedAccountRuntime: vi.fn(async () => runtimeLease),
      connectedAccountRuntimeInvoker: {
        invokeAuthentication: vi.fn(),
      },
    };
    const release = vi.fn(async () => undefined);
    const lease = () => ({
      registry,
      source: 'active' as const,
      release,
    });
    const reloadController = {
      acquireRuntimeRegistry: vi.fn(async () => lease()),
      tryAcquireRuntimeRegistry: vi.fn(() => lease()),
      isRuntimeRegistryCurrent: vi.fn(() => true),
    } as unknown as PluginReloadController;
    const deleteCredential = vi.fn(async () => ({ success: true as const }));
    const establishedRuntimeOwner = {
      invokeWithReceipt: vi.fn(async () => ({
        result: { status: 'remoteUnsupported' as const },
        basis: {
          credentialRevision: 'credential-1',
          credentialConfigurationRevision: 'configuration-1',
          runtimeConfigurationRevision: 'configuration-1',
          generation: 'generation-1',
          immutableGenerationId: 'artifact-1',
          isCurrent: () => true,
          prepareCredentialReplacement: () => {
            throw new Error('not used by revoke');
          },
        },
      })),
    } as unknown as Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt'
    >;
    let releaseConsequence!: () => void;
    const consequenceGate = new Promise<void>((resolve) => {
      releaseConsequence = resolve;
    });
    const assertConfigurationConsequenceAvailable = vi.fn(
      async () => undefined,
    );
    const applyConfigurationConsequence = vi.fn<
      ConfigurationConsequenceApply
    >(async (input) => {
      if (input.account.accountId === account.accountId) {
        await consequenceGate;
      }
    });
    const resolvePeerOperationTransport = vi.fn((
      input: Readonly<{ operation: string }>,
    ) => input.operation === 'credential_delete'
      ? { kind: 'v4' as const }
      : {
          kind: 'legacy' as const,
          peerClass: 'exact_v0_2_1' as const,
          serviceId: 'openai-codex' as const,
        });
    const runtime = createConnectedAccountDaemonRuntime({
      reloadController,
      persistence,
      resolvePeerOperationTransport,
      configurationConsequences: {
        assertAvailable: assertConfigurationConsequenceAvailable,
        apply: applyConfigurationConsequence,
      },
      revocation: {
        token: 'token-1',
        establishedRuntimeOwner,
        resolveV4Support: () => 'advertised',
        deleteCredential,
      },
    });

    await expect(runtime.control({
      operation: 'describeService',
      service,
      requiredOperation: 'account_list',
    })).resolves.toMatchObject({
      status: 'described',
      service,
      descriptor: { id: 'work', title: 'Acme Work' },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
      operationTransport: {
        kind: 'legacy',
        peerClass: 'exact_v0_2_1',
        serviceId: 'openai-codex',
      },
    });
    expect(listProfiles).not.toHaveBeenCalled();
    expect(resolvePeerOperationTransport).toHaveBeenCalledWith({
      service,
      operation: 'account_list',
    });
    await expect(runtime.control({
      operation: 'readConfiguration',
      target: { kind: 'service', service, modeId: 'oauth' },
    })).resolves.toMatchObject({
      status: 'configuration',
      target,
      mode: { id: 'oauth' },
      configuration: {
        status: 'ready',
        revision: 'configuration-1',
        values: { endpoint: 'https://old.example.test' },
        configuredSecretFieldIds: ['clientSecret'],
      },
    });
    await expect(runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-1',
      values: { endpoint: 'not-an-origin' },
      secretValues: {},
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_configuration_invalid',
    });
    expect(persistence.configuration.replaceForControl).not.toHaveBeenCalled();
    expect(applyConfigurationConsequence).not.toHaveBeenCalled();
    expect(records.get(key(target))).toMatchObject({
      revision: 'configuration-1',
      values: { endpoint: 'https://old.example.test' },
    });
    const replacementPromise = runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-1',
      values: { endpoint: 'https://new.example.test' },
      secretValues: { clientSecret: 'replacement' },
    });
    let replacementSettled = false;
    void replacementPromise.finally(() => {
      replacementSettled = true;
    });
    await vi.waitFor(() => {
      expect(applyConfigurationConsequence).toHaveBeenCalledTimes(2);
    });
    expect(replacementSettled).toBe(false);
    releaseConsequence?.();
    await expect(replacementPromise).resolves.toMatchObject({
      status: 'configurationCommitted',
      target,
      configuration: {
        status: 'ready',
        revision: 'configuration-2',
        values: { endpoint: 'https://new.example.test' },
        configuredSecretFieldIds: ['clientSecret'],
      },
    });
    expect(applyConfigurationConsequence).toHaveBeenNthCalledWith(1, {
      account,
      authenticationModeId: 'oauth',
      configurationScope: 'service',
      behavior: 'refresh',
      runtimeConfigurationRevision: 'configuration-2',
    });
    expect(applyConfigurationConsequence).toHaveBeenNthCalledWith(2, {
      account: secondAccount,
      authenticationModeId: 'oauth',
      configurationScope: 'service',
      behavior: 'refresh',
      runtimeConfigurationRevision: 'configuration-2',
    });

    listProfiles.mockResolvedValue([]);
    await expect(runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-2',
      values: { endpoint: 'https://zero.example.test' },
      secretValues: {},
    })).resolves.toMatchObject({
      status: 'configurationCommitted',
      configuration: { revision: 'configuration-3' },
    });
    expect(applyConfigurationConsequence).toHaveBeenCalledTimes(2);

    const accountTarget = Object.freeze({
      kind: 'account' as const,
      account: otherModeAccount,
      modeId: 'account-oauth',
    });
    records.set(key(accountTarget), {
      revision: 'account-configuration-1',
      values: { tenant: 'old-tenant' },
      secretRefs: {},
    });
    readExact.mockResolvedValue({
      account: otherModeAccount,
      authenticationModeId: 'account-oauth',
      credentialRevision: 'credential-3',
      configurationRevision: 'account-configuration-1',
    });
    listProfiles.mockResolvedValue([{
      ref: account,
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-1',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }]);
    await expect(runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'account', account: otherModeAccount },
      expectedRevision: 'account-configuration-1',
      values: { tenant: 'new-tenant' },
      secretValues: {},
    })).resolves.toMatchObject({
      status: 'configurationCommitted',
      configuration: { revision: 'configuration-4' },
    });
    expect(applyConfigurationConsequence).toHaveBeenLastCalledWith({
      account: otherModeAccount,
      authenticationModeId: 'account-oauth',
      configurationScope: 'account',
      behavior: 'reconnect',
      runtimeConfigurationRevision: 'configuration-4',
    });

    assertConfigurationConsequenceAvailable.mockRejectedValueOnce(
      Object.assign(
        new Error('Configuration consequence unavailable'),
        { code: 'connected_account_configuration_consequence_unavailable' },
      ),
    );
    await expect(runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'account', account: otherModeAccount },
      expectedRevision: 'configuration-4',
      values: { tenant: 'unavailable-tenant' },
      secretValues: {},
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_configuration_consequence_unavailable',
    });
    expect(records.get(key(accountTarget))).toMatchObject({
      revision: 'configuration-4',
      values: { tenant: 'new-tenant' },
    });

    listProfiles.mockResolvedValue([{
      ref: account,
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-1',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }, {
      ref: secondAccount,
      status: 'connected' as const,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-2',
      configurationReady: true,
      configurationRevision: null,
      scopes: [],
    }]);
    applyConfigurationConsequence.mockRejectedValueOnce(
      Object.assign(
        new Error('First account consequence unavailable'),
        { code: 'connected_account_configuration_consequence_unavailable' },
      ),
    );
    await expect(runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-3',
      values: { endpoint: 'https://partial.example.test' },
      secretValues: {},
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_configuration_consequence_unavailable',
    });
    expect(applyConfigurationConsequence).toHaveBeenCalledTimes(5);
    expect(applyConfigurationConsequence.mock.calls.slice(-2).map(
      ([input]) => input.account,
    )).toEqual([account, secondAccount]);
    expect(records.get(key(target))).toMatchObject({
      revision: 'configuration-5',
      values: { endpoint: 'https://partial.example.test' },
    });

    applyConfigurationConsequence.mockRejectedValueOnce(
      Object.assign(
        new Error('First account consequence is stale'),
        { code: 'connected_account_configuration_consequence_stale' },
      ),
    );
    await expect(runtime.control({
      operation: 'replaceConfiguration',
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-5',
      values: { endpoint: 'https://stale.example.test' },
      secretValues: {},
    })).resolves.toEqual({
      status: 'conflict',
      code: 'connected_account_configuration_consequence_stale',
    });
    expect(applyConfigurationConsequence).toHaveBeenCalledTimes(7);
    expect(applyConfigurationConsequence.mock.calls.slice(-2).map(
      ([input]) => input.account,
    )).toEqual([account, secondAccount]);
    expect(records.get(key(target))).toMatchObject({
      revision: 'configuration-6',
      values: { endpoint: 'https://stale.example.test' },
    });
    await expect(runtime.control({
      operation: 'revokeAccount',
      account,
      cleanupGroupReferences: true,
    })).resolves.toEqual({
      status: 'revoked',
      account,
      remoteStatus: 'remoteUnsupported',
    });
    expect(deleteCredential).toHaveBeenCalledWith({
      token: 'token-1',
      deletion: {
        ref: account,
        expectedCredentialRevision: 'credential-1',
        cleanupGroupReferences: true,
      },
    });
  });

  describe('describeService over the real connected-account contribution registry', () => {
    // describeService must answer from the descriptor alone. Every provider entry
    // point throws so an accidental invocation fails the test loudly.
    const unreached = (): never => {
      throw new Error('describeService must not enter the connected-account provider');
    };
    const publishedRuntime: ConnectedAccountRuntimeRegistration['runtime'] = {
      authentication: {
        modes: {
          oauth: {
            kind: 'oauthAuthorizationCode',
            begin: unreached,
            complete: unreached,
            cancel: unreached,
          },
          'account-oauth': {
            kind: 'oauthDeviceCode',
            begin: unreached,
            poll: unreached,
            cancel: unreached,
          },
        },
      },
      refresh: unreached,
      revoke: unreached,
      status: unreached,
      materialize: unreached,
    };

    function createDaemonOverRealRegistry(input: Readonly<{
      published: boolean;
      generationCurrent(): boolean;
    }>) {
      const registrations: ConnectedAccountRuntimeRegistration[] = [];
      const contributions = createConnectedAccountContributionRegistry({
        generation: 'generation-1',
        immutableGenerationIdsByPluginId: new Map([[service.pluginId, 'artifact-1']]),
        descriptors: [{
          provenance: 'first_party',
          source: { kind: 'bundled' },
          pluginId: service.pluginId,
          definition: descriptor,
        }] satisfies readonly ResolvedConnectedAccountDescriptorContribution[],
        activateOnDemand: async (ref) => {
          if (!input.published) return;
          registrations.push({
            pluginId: ref.pluginId,
            generation: 'generation-1',
            localId: ref.localId,
            runtime: publishedRuntime,
          });
        },
        readRegistrations: () => registrations,
        isGenerationCurrent: () => input.generationCurrent(),
      });
      const registry = {
        generation: 'generation-1',
        connectedAccountContributions: contributions,
        resolveConnectedAccountRuntime: contributions.resolve,
      };
      const lease = () => ({
        registry,
        source: 'active' as const,
        release: vi.fn(async () => undefined),
      });
      return createConnectedAccountDaemonRuntime({
        reloadController: {
          acquireRuntimeRegistry: vi.fn(async () => lease()),
          tryAcquireRuntimeRegistry: vi.fn(() => lease()),
          isRuntimeRegistryCurrent: vi.fn(() => true),
        } as unknown as PluginReloadController,
        persistence: {
          profiles: { list: vi.fn(async () => []) },
          configuration: {
            read: vi.fn(async () => null),
            replace: vi.fn(),
            destroyAttempt: vi.fn(),
            secrets: {
              has: vi.fn(async () => false),
              read: vi.fn(async () => null),
            },
          },
          attempts: {
            accounts: { readExact: vi.fn(async () => null) },
            oauth: { create: vi.fn() },
            settlement: { settle: vi.fn() },
          },
        } as unknown as ConnectedAccountDaemonPersistence,
        configurationConsequences: {
          assertAvailable: vi.fn(),
          apply: vi.fn(),
        },
        revocation: {} as never,
      });
    }

    it('names an unresolvable declared service instead of the untyped control catch-all', async () => {
      const daemon = createDaemonOverRealRegistry({
        published: false,
        generationCurrent: () => true,
      });

      await expect(daemon.control({
        operation: 'describeService',
        service,
      })).resolves.toEqual({
        status: 'unavailable',
        code: 'connected_account_service_unavailable',
      });
    });

    it('keeps a retired generation distinguishable from an unavailable service', async () => {
      let current = true;
      const daemon = createDaemonOverRealRegistry({
        published: true,
        generationCurrent: () => current,
      });
      await expect(daemon.control({
        operation: 'describeService',
        service,
      })).resolves.toMatchObject({ status: 'described', service });

      current = false;
      await expect(daemon.control({
        operation: 'describeService',
        service,
      })).resolves.toEqual({
        status: 'unavailable',
        code: 'connected_account_runtime_generation_changed',
      });
    });

    it('refuses an undeclared service without inventing a runtime for it', async () => {
      const daemon = createDaemonOverRealRegistry({
        published: true,
        generationCurrent: () => true,
      });

      await expect(daemon.control({
        operation: 'describeService',
        service: { pluginId: 'acme.accounts', localId: 'not-declared' },
      })).resolves.toEqual({
        status: 'unavailable',
        code: 'connected_account_service_unavailable',
      });
    });
  });
});
