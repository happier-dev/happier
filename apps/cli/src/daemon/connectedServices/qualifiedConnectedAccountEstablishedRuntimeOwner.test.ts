import { describe, expect, it, vi } from 'vitest';
import {
  PluginConnectedAccountDescriptorContributionV2Schema,
  ConnectedServiceCredentialRecordV1Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  sealQualifiedConnectedAccountContentEnvelope,
  type QualifiedConnectedAccountConfigurationSnapshotV4,
} from '@happier-dev/protocol';

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { ConnectedAccountConfigurationRecord } from '@/plugins/runtime/connectedAccounts/configurationOwner';
import type {
  ConnectedAccountHostRuntimeInvoker,
  ConnectedAccountRuntimeEstablishedInvocation,
} from '@/plugins/runtime/connectedAccounts/runtimeInvoker';

import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
} from './qualifiedConnectedAccountEstablishedRuntimeOwner';

const service = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});
const account = Object.freeze({ service, accountId: 'account-1' });
const requestAuthCredentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
type QualifiedConnectedAccountCredentialSnapshotV4 = ReturnType<
  typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse
>;
const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
  id: service.localId,
  title: 'Acme',
  authentication: {
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      pkce: 'required',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'account',
        changeBehavior: 'refresh',
        fields: [{
          id: 'endpoint',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 1 },
          required: true,
        }, {
          id: 'clientSecret',
          title: 'Client secret',
          schema: { type: 'string', minLength: 1 },
          secret: true,
          required: true,
        }],
      },
    }],
  },
});

const originDescriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
  id: service.localId,
  title: 'Acme',
  authentication: {
    defaultModeId: 'oauth',
    modes: [{
      id: 'oauth',
      kind: 'oauthAuthorizationCode',
      pkce: 'required',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'account',
        changeBehavior: 'refresh',
        fields: [{
          id: 'endpoint',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 1 },
          semantic: 'connectedAccountOrigin',
          required: true,
        }, {
          id: 'label',
          title: 'Label',
          schema: { type: 'string' },
        }, {
          id: 'clientSecret',
          title: 'Client secret',
          schema: { type: 'string', minLength: 1 },
          secret: true,
          required: true,
        }],
      },
    }],
  },
});

function plainEnvelope(kind: 'credential' | 'configuration', payload: unknown) {
  return sealQualifiedConnectedAccountContentEnvelope({
    kind,
    accountMode: 'plain',
    payload,
    randomBytes: (length) => new Uint8Array(length),
  });
}

describe('createQualifiedConnectedAccountEstablishedRuntimeOwner', () => {
  it('reads an exact credential revision for qualified request-auth currentness without invoking a runtime', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'account-1',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
        kind: 'oauth',
        oauth: {
          accessToken: 'access-1',
          refreshToken: null,
          idToken: null,
          tokenType: null,
          scope: null,
          expiresAt: null,
          providerAccountId: null,
          providerEmail: null,
          raw: null,
        },
        token: null,
      }),
      metadata: { scopes: [] },
    });
    const acquireRuntimeRegistry = vi.fn();
    const readCredential = vi.fn(async () => credentialSnapshot);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry,
        isRuntimeRegistryCurrent: vi.fn(),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    const signal = new AbortController().signal;
    await expect(owner.readCredentialRevision({
      account,
      signal,
    })).resolves.toBe(requestAuthCredentialRevision);
    // The caller's cancellation signal reaches the credential read itself, so an
    // aborted request-auth currentness check cannot keep an in-flight read alive.
    expect(readCredential).toHaveBeenCalledWith({ token: 'token-1', ref: account, signal });
    expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
  });

  it('refuses an unfenced snapshot before request-auth currentness can acquire a runtime', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'legacy-access' },
      }),
      metadata: { scopes: [] },
    });
    const acquireRuntimeRegistry = vi.fn();
    const readCredential = vi.fn(async () => credentialSnapshot);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry,
        isRuntimeRegistryCurrent: vi.fn(),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    await expect(owner.readCredentialRevision({ account })).rejects
      .toThrow('credential snapshot is unfenced');
    expect(readCredential).toHaveBeenCalledWith({ token: 'token-1', ref: account });
    expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
  });

  it('adopts exact qualified snapshots into the current invoker without rebuilding plugin context', async () => {
    const credentialSnapshot: QualifiedConnectedAccountCredentialSnapshotV4 = {
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-1',
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'account-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        expiresAt: null,
        kind: 'oauth',
        oauth: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          idToken: null,
          tokenType: null,
          scope: null,
          expiresAt: null,
          providerAccountId: null,
          providerEmail: null,
          raw: null,
        },
        token: null,
      }),
      metadata: { scopes: [] },
    };
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-1',
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const assertEffectfulOperationAllowed = vi.fn();
    const invokeEstablished = vi.fn(async (
      input: ConnectedAccountRuntimeEstablishedInvocation<{
        kind: 'materialize';
        request: {
          kind: 'environment';
          keys: readonly string[];
        };
      }>,
    ) => {
      expect(assertEffectfulOperationAllowed).toHaveBeenCalledOnce();
      expect(input.target).toEqual({
        account,
        expectedCredentialRevision: 'credential-1',
        expectedRuntimeConfigurationRevision: 'configuration-1',
      });
      expect(input.context.account).toEqual(account);
      expect(input.context.configuration).toMatchObject({
        target: { kind: 'account', account, modeId: 'oauth' },
        revision: 'configuration-1',
        values: { endpoint: 'https://api.example.test' },
      });
      await expect(input.context.configuration.getSecret('clientSecret'))
        .resolves.toBe('secret-value');
      await expect(input.context.credentials.get('accessToken')).resolves.toBe('access-1');
      await expect(input.context.credentials.get('missing')).resolves.toBeNull();
      await expect(input.isConfigurationCurrent(input.context.configuration)).resolves.toBe(true);
      await expect(input.isCredentialRevisionCurrent()).resolves.toBe(true);
      return { kind: 'environment' as const, env: { TOKEN: 'access-1' } };
    });
    const invoker = Object.freeze({
      invokeAuthentication: vi.fn(),
      invokeEstablished,
    // The fixture intentionally implements only the operation exercised by this owner test.
    }) as unknown as ConnectedAccountHostRuntimeInvoker;
    const runtimeLease = Object.freeze({
      ref: service,
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
      descriptor,
      runtime: {},
      isCurrent: () => true,
    });
    const registry = {
      connectedAccountRuntimeInvoker: invoker,
      resolveConnectedAccountRuntime: vi.fn(async () => runtimeLease),
    };
    const release = vi.fn(async () => undefined);
    const reloadController = {
      acquireRuntimeRegistry: vi.fn(async () => ({
        registry,
        source: 'active' as const,
        release,
      })),
      isRuntimeRegistryCurrent: vi.fn(() => true),
    } as unknown as Pick<
      PluginReloadController,
      'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
    >;
    const readCredential = vi.fn(async () => credentialSnapshot);
    const readConfiguration = vi.fn(async () => configurationSnapshot);
    const hasSavedSecret = vi.fn(async () => false);
    const readSavedSecret = vi.fn(async () => null);
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController,
      credentials: {
        token: 'token-1',
        encryption: null,
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: hasSavedSecret,
          read: readSavedSecret,
        },
      },
    });

    const receipt = await owner.invokeWithReceipt({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'environment', keys: ['TOKEN'] },
      },
      assertEffectfulOperationAllowed,
    });
    expect(receipt).toEqual({
      result: {
        kind: 'environment',
        env: { TOKEN: 'access-1' },
      },
      basis: {
        credentialRevision: 'credential-1',
        credentialConfigurationRevision: 'configuration-1',
        runtimeConfigurationRevision: 'configuration-1',
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
        isCurrent: expect.any(Function),
        prepareCredentialReplacement: expect.any(Function),
      },
    });
    expect(receipt.basis.isCurrent()).toBe(true);
    const replacement = receipt.basis.prepareCredentialReplacement({
      set: { accessToken: 'access-rotated' },
      delete: [],
    });
    expect(replacement).toMatchObject({
      authenticationModeId: 'oauth',
      metadata: { scopes: [] },
    });
    const replacementPlaintext = openQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      envelope: replacement.content,
    });
    expect(ConnectedServiceCredentialRecordV1Schema.parse(
      replacementPlaintext,
    )).toMatchObject({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'account-1',
      kind: 'oauth',
      oauth: {
        accessToken: 'access-rotated',
        refreshToken: 'refresh-1',
      },
    });
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: account,
      authenticationModeId: 'oauth',
      plaintext: replacementPlaintext,
      metadata: replacement.metadata,
    })).toEqual({
      v: 1,
      values: {
        accessToken: 'access-rotated',
        refreshToken: 'refresh-1',
      },
    });
    expect(() => receipt.basis.prepareCredentialReplacement({
      set: { accessToken: 'access-again' },
      delete: ['accessToken'],
    })).toThrow('cannot set and delete the same key');

    expect(readCredential).toHaveBeenCalledWith({
      token: 'token-1',
      ref: account,
    });
    expect(readConfiguration).toHaveBeenCalledWith({
      token: 'token-1',
      target: { kind: 'account', ref: account },
    });
    expect(hasSavedSecret).not.toHaveBeenCalled();
    expect(readSavedSecret).not.toHaveBeenCalled();
    expect(invokeEstablished).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails closed before invocation when credential/configuration revisions disagree', async () => {
    const credentialSnapshot: QualifiedConnectedAccountCredentialSnapshotV4 = {
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-2',
      configurationRevision: 'configuration-2',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-2' },
      }),
      metadata: { scopes: [] },
    };
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-stale',
      configurationRevision: 'configuration-2',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const invokeEstablished = vi.fn();
    const registry = {
      connectedAccountRuntimeInvoker: {
        invokeAuthentication: vi.fn(),
        invokeEstablished,
      },
      resolveConnectedAccountRuntime: vi.fn(async () => ({
        ref: service,
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
        descriptor,
        runtime: {},
        isCurrent: () => true,
      })),
    };
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry,
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => configurationSnapshot),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => true),
          read: vi.fn(async () => 'secret-value'),
        },
      },
    });

    await expect(owner.invoke({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'environment', keys: ['TOKEN'] },
      },
    })).rejects.toThrow('snapshot revisions do not describe one exact account state');
    expect(invokeEstablished).not.toHaveBeenCalled();
  });

  it('loads service-scoped configuration from the canonical configuration owner and fences a stale revision', async () => {
    const serviceDescriptor =
      PluginConnectedAccountDescriptorContributionV2Schema.parse({
        id: service.localId,
        title: 'Acme',
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
                required: true,
              }],
            },
          }],
        },
      });
    const credentialSnapshot: QualifiedConnectedAccountCredentialSnapshotV4 = {
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: 'credential-service-1',
      configurationRevision: null,
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-service-1' },
      }),
      metadata: { scopes: [] },
    };
    let serviceConfiguration: ConnectedAccountConfigurationRecord = Object.freeze({
      revision: 'service-configuration-1',
      values: Object.freeze({
        endpoint: 'https://api.example.test',
      }),
      secretRefs: Object.freeze({}),
    });
    const readConfigurationRecord = vi.fn(async () => serviceConfiguration);
    const invokeEstablished = vi.fn(async (
      input: ConnectedAccountRuntimeEstablishedInvocation<{
        kind: 'status';
      }>,
    ) => {
      expect(input.target).toEqual({
        account,
        expectedCredentialRevision: 'credential-service-1',
        expectedRuntimeConfigurationRevision: 'service-configuration-1',
      });
      expect(input.context.configuration).toMatchObject({
        target: { kind: 'service', service, modeId: 'oauth' },
        revision: 'service-configuration-1',
        values: { endpoint: 'https://api.example.test' },
      });
      await expect(
        input.isConfigurationCurrent(input.context.configuration),
      ).resolves.toBe(true);
      serviceConfiguration = Object.freeze({
        ...serviceConfiguration,
        revision: 'service-configuration-2',
      });
      await Promise.resolve();
      await expect(
        input.isConfigurationCurrent(input.context.configuration),
      ).resolves.toBe(false);
      return { status: 'connected' as const };
    });
    const registry = {
      connectedAccountRuntimeInvoker: {
        invokeAuthentication: vi.fn(),
        invokeEstablished,
      },
      resolveConnectedAccountRuntime: vi.fn(async () => ({
        ref: service,
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
        descriptor: serviceDescriptor,
        runtime: {},
        isCurrent: () => true,
      })),
    };
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry,
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => null),
      configuration: {
        read: readConfigurationRecord,
        secrets: {
          has: vi.fn(async () => true),
          read: vi.fn(async () => 'secret-value'),
        },
      },
    });

    const receipt = await owner.invokeWithReceipt({
      account,
      operation: { kind: 'status' },
    });
    expect(receipt.result).toEqual({ status: 'connected' });
    expect(receipt.basis).toMatchObject({
      credentialRevision: 'credential-service-1',
      credentialConfigurationRevision: null,
      runtimeConfigurationRevision: 'service-configuration-1',
    });
    expect(invokeEstablished).toHaveBeenCalledTimes(1);
    expect(readConfigurationRecord).toHaveBeenCalledWith({
      kind: 'service',
      service,
      modeId: 'oauth',
    });
  });

  it('rejects a later materialization when the callback-pinned credential revision rotates', async () => {
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let credentialRevision = revisionA;
    const readCredential = vi.fn(async () => ({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: credentialRevision },
      }),
      metadata: { scopes: [] },
    }));
    const readConfiguration = vi.fn(async () => ({
      target: { kind: 'account' as const, ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    }));
    const invokeEstablished = vi.fn(async (
      input: ConnectedAccountRuntimeEstablishedInvocation<{
        kind: 'materialize';
        request: { kind: 'httpHeaders'; origin: string; headerNames: readonly string[] };
      }>,
    ) => {
      expect(input.target.expectedCredentialRevision).toBe(credentialRevision);
      await expect(input.isCredentialRevisionCurrent()).resolves.toBe(true);
      return {
        kind: 'httpHeaders' as const,
        headers: { authorization: `Bearer ${credentialRevision}` },
      };
    });
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished,
            },
            resolveConnectedAccountRuntime: vi.fn(async () => ({
              ref: service,
              generation: 'generation-1',
              immutableGenerationId: 'artifact-1',
              descriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: {
        token: 'token-1',
        encryption: null,
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration,
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    const first = await owner.invokeWithReceipt({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
      },
    });
    expect(first.basis.credentialRevision).toBe(revisionA);

    credentialRevision = revisionB;
    await expect(owner.invoke({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
      },
      // This host-private value is first available only after the first receipt.
      expectedCredentialRevision: first.basis.credentialRevision,
    })).rejects.toThrow('credential revision');
    expect(invokeEstablished).toHaveBeenCalledTimes(1);

    const nextCallback = await owner.invokeWithReceipt({
      account,
      operation: {
        kind: 'materialize',
        request: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] },
      },
    });
    expect(nextCallback.basis.credentialRevision).toBe(revisionB);
    expect(invokeEstablished).toHaveBeenCalledTimes(2);
  });

  it('projects only host-normalized credential-free configured origins for one exact account', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-1' },
      }),
      metadata: { scopes: [] },
    });
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://eu.example.test', label: 'Europe' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const invokeEstablished = vi.fn(async () => {
      throw new Error('configured-origin projection must not invoke a plugin runtime');
    });
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished,
            },
            resolveConnectedAccountRuntime: vi.fn(async () => Object.freeze({
              ref: service,
              generation: 'generation-1',
              immutableGenerationId: 'artifact-1',
              descriptor: originDescriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => configurationSnapshot),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    await expect(owner.readConfiguredEndpoints({ account }))
      .resolves.toEqual([{
        origin: 'https://eu.example.test',
        base: 'https://eu.example.test',
        privateNetwork: false,
      }]);
    expect(invokeEstablished).not.toHaveBeenCalled();
  });

  it('fails a configured-origin projection closed when the stored origin is not credential-free', async () => {
    const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      content: plainEnvelope('credential', {
        v: 1,
        values: { accessToken: 'access-1' },
      }),
      metadata: { scopes: [] },
    });
    const configurationSnapshot: QualifiedConnectedAccountConfigurationSnapshotV4 = {
      target: { kind: 'account', ref: account },
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: requestAuthCredentialRevision,
      configurationRevision: 'configuration-1',
      configurationContent: plainEnvelope('configuration', {
        values: { endpoint: 'https://user:secret@eu.example.test' },
        secretRefs: {},
        secretValues: { clientSecret: 'secret-value' },
      }),
    };
    const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: {
        acquireRuntimeRegistry: vi.fn(async () => ({
          registry: {
            connectedAccountRuntimeInvoker: {
              invokeAuthentication: vi.fn(),
              invokeEstablished: vi.fn(),
            },
            resolveConnectedAccountRuntime: vi.fn(async () => Object.freeze({
              ref: service,
              generation: 'generation-1',
              immutableGenerationId: 'artifact-1',
              descriptor: originDescriptor,
              runtime: {},
              isCurrent: () => true,
            })),
          },
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        })),
        isRuntimeRegistryCurrent: vi.fn(() => true),
      } as unknown as Pick<
        PluginReloadController,
        'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
      >,
      credentials: { token: 'token-1', encryption: null },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => credentialSnapshot),
      readConfiguration: vi.fn(async () => configurationSnapshot),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });

    await expect(owner.readConfiguredEndpoints({ account })).rejects.toThrow(
      'credential-free HTTPS origin',
    );
  });
});
