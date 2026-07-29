import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountCredentialMutationV4Schema,
  QualifiedConnectedAccountRefreshLeaseV4Schema,
  QualifiedProviderAccountUsageWriteV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
  type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type {
  ConnectedAccountConfigurationRecord,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
  createConnectedAccountDaemonRuntime,
  type ConnectedAccountDaemonPersistence,
} from '../ConnectedAccountDaemonRuntime';
import {
  ConnectedServiceRefreshCoordinator,
  type QualifiedConnectedAccountRefreshRuntime,
} from './ConnectedServiceRefreshCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../quotas/ConnectedServiceQuotasCoordinator';

const service = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});
const account = Object.freeze({ service, accountId: 'work' });
const firstRevision = 'csr_abcdefghijklmnopqrstuv';
const secondRevision = 'csr_bcdefghijklmnopqrstuvw';
const thirdRevision = 'csr_cdefghijklmnopqrstuvwx';
const now = 1_000_000;
const createdDirectories: string[] = [];
const createdRegistries: Array<Readonly<{ dispose(): Promise<void> }>> = [];

async function createTrustedLocalLinkInstall(input: Readonly<{
  pluginId: string;
  sourceRootPath: string;
}>) {
  return {
    mode: 'link' as const,
    manifestVersion: '1.0.0',
    manifestDigest: null,
    installedPath: null,
    trust: createPluginTrustRecord({
      pluginId: input.pluginId,
      distribution:
        await createLocalPathPluginDistributionIdentity(input.sourceRootPath),
      approvedAtMs: 1,
    }),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('ConnectedServiceRefreshCoordinator qualified refresh integration', () => {
  it('rejects a failed revision that becomes stale while the qualified status probe awaits', async () => {
    const credentials: Credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(8),
      },
    };
    const legacyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 1,
      oauth: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        idToken: null,
        providerAccountId: 'work',
        providerEmail: null,
        scope: null,
        tokenType: 'Bearer',
      },
    });
    const qualifiedContent = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: {
        v: 1,
        values: {
          accessToken: 'access-newer',
          refreshToken: 'refresh-newer',
          providerAccountId: 'work',
        },
      },
      randomBytes: (length) => new Uint8Array(length),
    });
    let authoritativeRevision = firstRevision;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: legacyRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: authoritativeRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;
    const invokeWithReceipt = vi.fn(async () => {
      authoritativeRevision = secondRevision;
      return {
        result: {
          status: 'connected' as const,
          displayName: 'work',
          scopes: [],
        },
        basis: {
          credentialRevision: secondRevision,
          credentialConfigurationRevision: null,
          runtimeConfigurationRevision: 'runtime-2',
          generation: 'generation-2',
          immutableGenerationId: 'immutable-2',
          isCurrent: () => true,
          prepareCredentialReplacement: vi.fn(),
        },
      };
    });
    // The system-boundary fake is narrowed through unknown because the real owner method is
    // operation-indexed; only the status operation is reachable in this stale-revision case.
    const establishedRuntimeOwner = {
      invokeWithReceipt,
    } as unknown as QualifiedConnectedAccountRefreshRuntime['establishedRuntimeOwner'];
    const readCredential = vi.fn(async () => (
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'oauth',
        credentialRevision: authoritativeRevision,
        configurationRevision: null,
        content: qualifiedContent,
        metadata: {
          providerIdentity: { accountId: 'work' },
          displayName: 'work',
          scopes: [],
        },
      })
    ));
    const mutateCredentialHealth = vi.fn(async () => ({
      credentialRevision: authoritativeRevision,
      configurationRevision: null,
    }));
    const acquireRefreshLease = vi.fn(async () => {
      throw new Error('stale revision must not acquire a refresh lease');
    });
    const mutateCredential = vi.fn(async () => {
      throw new Error('stale revision must not mutate a credential');
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:runtime-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        readCredential,
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
      },
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
      expectedCredentialRevision: firstRevision,
    })).rejects.toThrow('connected_service_credential_revision_mismatch');

    expect(mutateCredentialHealth).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
    expect(acquireRefreshLease).not.toHaveBeenCalled();
    expect(mutateCredential).not.toHaveBeenCalled();
  });

  it('routes a forced built-in compatibility target through the current plugin leaf and exact K settlement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      expires_in: 3600,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-refresh-coordinator-'));
    createdDirectories.push(happyHomeDir);
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      pluginIds: [service.pluginId],
    });
    createdRegistries.push(registry);
    const credentials: Credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(8),
      },
    };
    let qualifiedRevision = firstRevision;
    let qualifiedContent = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: {
        v: 1,
        values: {
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          idToken: 'id-old',
          providerAccountId: 'work',
        },
      },
      randomBytes: (length) => new Uint8Array(length),
    });
    let legacyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 1,
      oauth: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        idToken: 'id-old',
        providerAccountId: 'work',
        providerEmail: null,
        scope: null,
        tokenType: 'Bearer',
      },
    });
    const readCredential = vi.fn(async () => ({
      ref: account,
      authenticationModeId: 'oauth',
      credentialRevision: qualifiedRevision,
      configurationRevision: null,
      content: qualifiedContent,
      metadata: {
        providerIdentity: { accountId: 'work' },
        displayName: 'work',
        scopes: ['openid'],
      },
    }));
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: {
          async acquireRuntimeRegistry() {
            return {
              registry,
              source: 'active' as const,
              release: vi.fn(async () => undefined),
            };
          },
          isRuntimeRegistryCurrent(candidate: typeof registry) {
            return candidate === registry;
          },
        },
        credentials,
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        configuration: {
          read: vi.fn(async () => null),
          secrets: {
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: legacyRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: qualifiedRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const acquireRefreshLease = vi.fn(async () => ({
      acquired: true,
      leaseUntil: now + 60_000,
      ownerId: 'machine-1:runtime-1',
      credentialRevision: qualifiedRevision,
    }));
    const mutateCredentialHealth = vi.fn(async () => ({
      success: true as const,
      credentialRevision: qualifiedRevision,
      configurationRevision: null,
    }));
    const mutateCredential = vi.fn(async (input: Readonly<{
      token: string;
      mutation: unknown;
    }>) => {
      const mutation =
        QualifiedConnectedAccountCredentialMutationV4Schema.parse(
          input.mutation,
        );
      const plaintext = openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        envelope: mutation.content,
      });
      const opened =
        parseQualifiedConnectedAccountCredentialPlaintextV1({
          ref: mutation.ref,
          authenticationModeId: mutation.authenticationModeId,
          plaintext,
          metadata: mutation.metadata,
        });
      qualifiedContent = mutation.content;
      qualifiedRevision = secondRevision;
      legacyRecord = buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: Number(opened.values.expiresAtMs),
        oauth: {
          accessToken: opened.values.accessToken!,
          refreshToken: opened.values.refreshToken!,
          idToken: opened.values.idToken!,
          providerAccountId: opened.values.providerAccountId!,
          providerEmail: null,
          scope: null,
          tokenType: 'Bearer',
        },
      });
      return {
        success: true as const,
        credentialRevision: secondRevision,
        configurationRevision: null,
      };
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:runtime-1',
      activeServerDir: join(happyHomeDir, 'active'),
      baseDir: join(happyHomeDir, 'materialized'),
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        readCredential,
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
      },
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toMatchObject({
      kind: 'oauth',
      oauth: {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        idToken: 'id-new',
      },
    });

    expect(mutateCredentialHealth).toHaveBeenCalledOnce();
    expect(acquireRefreshLease).toHaveBeenCalled();
    expect(mutateCredential).toHaveBeenCalledOnce();
    expect(mutateCredential.mock.calls[0]![0]).toMatchObject({
      token: 'happier-token',
      mutation: {
        ref: account,
        expectedCredentialRevision: firstRevision,
        expectedConfigurationRevision: null,
        refreshLeaseOwnerId: 'machine-1:runtime-1',
      },
    });
  });

  it('schedules a novel qualified service through the real coordinator and current plugin runtime without a legacy enum id', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-novel-qualified-refresh-home-'),
    );
    const pluginRoot = await mkdtemp(
      join(tmpdir(), 'happier-novel-qualified-refresh-plugin-'),
    );
    createdDirectories.push(happyHomeDir, pluginRoot);
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'acme.novel.refresh',
        version: '1.0.0',
        displayName: 'Novel refresh',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {
          connectedAccountDescriptors: [{
            id: 'novel-service',
            title: 'Novel service',
            authentication: {
              defaultModeId: 'manual',
              modes: [{
                id: 'manual',
                kind: 'manual',
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
                fields: [{
                  id: 'token',
                  title: 'Token',
                  schema: { type: 'string' },
                  secret: true,
                }],
              }],
            },
          }],
        },
      }),
      'utf8',
    );
    await writeFile(
      join(pluginRoot, 'daemon.mjs'),
      `export function activate(api) {
        api.connectedAccounts.register('novel-service', {
          authentication: {
            modes: {
              manual: {
                kind: 'manual',
                async complete() {
                  return {
                    status: 'connected',
                    accountId: 'novel-account',
                    displayName: 'Novel account',
                    scopes: [],
                  };
                },
              },
            },
          },
          async status() {
            return { status: 'connected', displayName: 'Novel account', scopes: [] };
          },
          async refresh(context) {
            await context.stagedCredentials.set('token', 'novel-token-refreshed');
            return { status: 'connected', displayName: 'Novel account', scopes: [] };
          },
          async quota() {
            return {
              observedAtMs: 1000000,
              limits: [{
                id: 'requests',
                used: 40,
                remaining: 60,
                resetsAtMs: 1060000,
              }, {
                id: 'optional-diagnostic',
              }],
            };
          },
          async revoke() {
            return { status: 'remoteUnsupported' };
          },
          async materialize() {
            return { kind: 'environment', env: {} };
          },
        });
      }`,
      'utf8',
    );
    await writeCommittedLocalPathPluginFixture({
      happyHomeDir,
      pluginId: 'acme.novel.refresh',
      sourceRootPath: pluginRoot,
      plugin: {
        source: {
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: pluginRoot,
          manifestPath: join(
            pluginRoot,
            '.happier-plugin',
            'plugin.json',
          ),
        },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: await createTrustedLocalLinkInstall({
          pluginId: 'acme.novel.refresh',
          sourceRootPath: pluginRoot,
        }),
        state: { enabled: true },
      },
    });
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
    });
    createdRegistries.push(registry);
    const novelService = Object.freeze({
      pluginId: 'acme.novel.refresh',
      localId: 'novel-service',
    });
    const novelAccount = Object.freeze({
      service: novelService,
      accountId: 'novel-account',
    });
    const credentials: Credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    let revision = firstRevision;
    let serviceConfiguration: ConnectedAccountConfigurationRecord = {
      revision: 'configuration-1',
      values: { endpoint: 'https://old.example.test' },
      secretRefs: {},
    };
    let content = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: { v: 1, values: { token: 'novel-token-old' } },
      randomBytes: (length) => new Uint8Array(length),
    });
    const readCredential = vi.fn(async () => ({
      ref: novelAccount,
      authenticationModeId: 'manual',
      credentialRevision: revision,
      configurationRevision: null,
      content,
      metadata: {
        displayName: 'Novel account',
        scopes: [],
      },
    }));
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: {
          async acquireRuntimeRegistry() {
            return {
              registry,
              source: 'active' as const,
              release: vi.fn(async () => undefined),
            };
          },
          isRuntimeRegistryCurrent(candidate: typeof registry) {
            return candidate === registry;
          },
        },
        credentials,
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        configuration: {
          read: vi.fn(async () => serviceConfiguration),
          secrets: {
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const mutateCredential = vi.fn(async (input: Readonly<{
      token: string;
      mutation: unknown;
    }>) => {
      const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(
        input.mutation,
      );
      content = mutation.content;
      revision = revision === firstRevision
        ? secondRevision
        : thirdRevision;
      return {
        success: true as const,
        credentialRevision: revision,
        configurationRevision: null,
      };
    });
    const onCredentialUpdated = vi.fn();
    const acquireRefreshLease = vi.fn(async (input: Readonly<{
      token: string;
      lease: unknown;
    }>) => {
      const lease = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(
        input.lease,
      );
      return {
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: lease.ownerId,
        credentialRevision: lease.expectedCredentialRevision,
      };
    });
    const mutateCredentialHealth = vi.fn(async () => ({
      success: true as const,
      credentialRevision: revision,
      configurationRevision: null,
    }));
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      } as unknown as ApiClient,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:runtime-1',
      activeServerDir: join(happyHomeDir, 'active'),
      baseDir: join(happyHomeDir, 'materialized'),
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        readCredential,
        listScheduledAccounts: vi.fn(async (): Promise<
          readonly QualifiedConnectedAccountProfileV4[]
        > => [{
          ref: novelAccount,
          status: 'connected',
          authenticationModeId: 'manual',
          credentialRevision: firstRevision,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth',
          expiresAt: now + 1,
          displayName: 'Novel account',
          scopes: [],
        }]),
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
        onCredentialUpdated,
      },
    });

    await expect(coordinator.tickOnce()).resolves.toBeUndefined();

    expect(mutateCredential).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        ref: novelAccount,
        expectedCredentialRevision: firstRevision,
        expectedConfigurationRevision: null,
      }),
    }));
    expect(onCredentialUpdated).toHaveBeenCalledWith(novelAccount);

    const persistence: ConnectedAccountDaemonPersistence = {
      profiles: {
        list: vi.fn(async () => [{
          ref: novelAccount,
          status: 'connected' as const,
          authenticationModeId: 'manual',
          credentialRevision: revision,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth' as const,
          expiresAt: now + 60_000,
          displayName: 'Novel account',
          scopes: [],
        }]),
      },
      configuration: {
        read: vi.fn(async () => serviceConfiguration),
        replaceForControl: vi.fn(async (input) => {
          if (input.expectedRevision !== serviceConfiguration.revision) {
            return {
              status: 'conflict' as const,
              code: 'connected_account_configuration_changed',
            };
          }
          serviceConfiguration = {
            revision: 'configuration-2',
            values: input.values,
            secretRefs: input.currentSecretRefs,
          };
          return {
            status: 'committed' as const,
            record: serviceConfiguration,
          };
        }),
        replace: vi.fn(async (input) => {
          if (input.expectedRevision !== serviceConfiguration.revision) {
            return {
              status: 'conflict' as const,
              code: 'connected_account_configuration_changed',
            };
          }
          serviceConfiguration = {
            revision: 'configuration-2',
            ...input.replacement,
          };
          return {
            status: 'committed' as const,
            record: serviceConfiguration,
          };
        }),
        destroyAttempt: vi.fn(),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
      attempts: {
        accounts: {
          readExact: vi.fn(async () => ({
            account: novelAccount,
            authenticationModeId: 'manual',
            credentialRevision: revision,
            configurationRevision: null,
          })),
        },
        oauth: { create: vi.fn() },
        settlement: { settle: vi.fn() },
      },
    };
    const lease = () => ({
      registry,
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    });
    const reloadController = {
      acquireRuntimeRegistry: vi.fn(async () => lease()),
      tryAcquireRuntimeRegistry: vi.fn(() => lease()),
      isRuntimeRegistryCurrent: vi.fn(
        (candidate: typeof registry) => candidate === registry,
      ),
    } as unknown as PluginReloadController;
    const controlRuntime = createConnectedAccountDaemonRuntime({
      reloadController,
      persistence,
      configurationConsequences: {
        assertAvailable: async () => undefined,
        async apply(input) {
          await coordinator
            .applyQualifiedConnectedAccountConfigurationConsequence(input);
        },
      },
      revocation: {
        token: credentials.token,
        establishedRuntimeOwner,
        resolveV4Support: () => 'advertised',
        deleteCredential: vi.fn(async () => ({ success: true as const })),
      },
    });

    await expect(controlRuntime.control({
      operation: 'replaceConfiguration',
      target: {
        kind: 'service',
        service: novelService,
        modeId: 'manual',
      },
      expectedRevision: 'configuration-1',
      values: { endpoint: 'https://new.example.test' },
      secretValues: {},
    })).resolves.toMatchObject({
      status: 'configurationCommitted',
      configuration: {
        revision: 'configuration-2',
        values: { endpoint: 'https://new.example.test' },
      },
    });

    expect(mutateCredential).toHaveBeenCalledTimes(2);
    expect(mutateCredential).toHaveBeenLastCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        ref: novelAccount,
        expectedCredentialRevision: secondRevision,
        expectedConfigurationRevision: null,
      }),
    }));
    expect(acquireRefreshLease).toHaveBeenLastCalledWith(expect.objectContaining({
      lease: expect.objectContaining({
        expectedCredentialRevision: secondRevision,
        ownerId: expect.stringMatching(/:configuration:/),
      }),
    }));
    expect(onCredentialUpdated).toHaveBeenCalledTimes(2);

    await expect(
      coordinator.applyQualifiedConnectedAccountConfigurationConsequence({
        account: novelAccount,
        authenticationModeId: 'manual',
        configurationScope: 'service',
        behavior: 'reconnect',
        runtimeConfigurationRevision: 'configuration-2',
      }),
    ).resolves.toBeUndefined();
    expect(mutateCredentialHealth).toHaveBeenLastCalledWith({
      token: 'happier-token',
      patch: {
        ref: novelAccount,
        expectedCredentialRevision: thirdRevision,
        expectedConfigurationRevision: null,
        health: {
          v: 1,
          status: 'needs_reauth',
          reconnectRequired: true,
          providerErrorCode:
            'connected_account_configuration_changed',
        },
      },
    });
    expect(onCredentialUpdated).toHaveBeenCalledTimes(3);

    acquireRefreshLease.mockResolvedValueOnce({
      acquired: false,
      leaseUntil: now + 60_000,
      ownerId: 'another-refresh-owner',
      credentialRevision: thirdRevision,
    });
    await expect(
      coordinator.applyQualifiedConnectedAccountConfigurationConsequence({
        account: novelAccount,
        authenticationModeId: 'manual',
        configurationScope: 'service',
        behavior: 'refresh',
        runtimeConfigurationRevision: 'configuration-2',
      }),
    ).rejects.toMatchObject({
      code: 'connected_account_configuration_consequence_unavailable',
    });
    expect(mutateCredential).toHaveBeenCalledTimes(2);
    expect(onCredentialUpdated).toHaveBeenCalledTimes(3);

    const writeProviderAccountUsage = vi.fn(async (input: Readonly<{
      token: string;
      write: unknown;
    }>) => {
      QualifiedProviderAccountUsageWriteV4Schema.parse(input.write);
      return { success: true as const };
    });
    const quotaCoordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      } as unknown as ConstructorParameters<
        typeof ConnectedServiceQuotasCoordinator
      >[0]['api'],
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length),
      discoveryEnabled: false,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        listScheduledAccounts: vi.fn(async (): Promise<
          readonly QualifiedConnectedAccountProfileV4[]
        > => [{
          ref: novelAccount,
          status: 'connected',
          authenticationModeId: 'manual',
          credentialRevision: thirdRevision,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth',
          expiresAt: now + 60_000,
          displayName: 'Novel account',
          scopes: [],
        }]),
        readQuota: vi.fn(async () => null),
        writeProviderAccountUsage,
      },
    });

    await expect(quotaCoordinator.tickOnce()).resolves.toBeUndefined();

    expect(writeProviderAccountUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'happier-token',
        write: expect.objectContaining({
          source: {
            ref: novelAccount,
            bindingKind: 'account',
          },
          expectedCredentialRevision: thirdRevision,
          expectedConfigurationRevision: null,
          payloadMode: 'plain_json_v1',
          status: 'ok',
          snapshot: expect.objectContaining({
            observedAtMs: now,
            meters: expect.arrayContaining([expect.objectContaining({
              meterId: 'requests',
              used: 40,
              remaining: 60,
              limit: 100,
            })]),
          }),
        }),
      }),
    );
  });
});
