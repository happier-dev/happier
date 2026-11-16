import axios, { AxiosHeaders } from 'axios';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  PluginInstallReviewPrincipalDigestSchema,
  SavedSecretSchema,
  PluginPermissionGrantRequestActionInputV1Schema,
  type PluginPermissionGrantRequestActionInputV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema, DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema } from '@happier-dev/protocol/daemon/voiceCredentials';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { resolveCurrentPluginPermissionGrantAuthoritySource } from '@/daemon/identity/currentMachineInstallation';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createRegistryInstallReviewPrincipalReader } from '@/plugins/runtime/credentials/registryInstallReviewPrincipalReader';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { persistInstallationStateRevision, readInstallationStateRevision } from '@/plugins/store/registry/generationStore';
import { replacePluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { derivePluginInstallReviewPrincipalDigest } from '../../plugins/daemon/installReviewPrincipal';
import {
  createMachineVoiceClientCredentialAuthorizationService,
  registerMachineVoiceClientCredentialAuthorizationRpcHandlers,
} from './rpcHandlers.voiceClientCredentialAuthorization';

const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE'] as const;
let envScope = createEnvKeyScope(envKeys);
let home: string;
beforeEach(async () => {
  home = await createTempDir('happier-voice-authorization-');
  envScope = createEnvKeyScope(envKeys);
  envScope.patch({ HAPPIER_SERVER_URL: 'http://voice-authorization.test', HAPPIER_HOME_DIR: home,
    HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
  reloadConfiguration();
  await writeCredentialsTokenOnlyForServerId(configuration.activeServerId, { token: 'account-token' });
  await updateSettings((settings) => ({ ...settings,
    machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: 'machine-1' },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  envScope.restore();
  reloadConfiguration();
  await removeTempDir(home);
});
const admittedFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
afterAll(async () => {
  const fixtures = admittedFixtures.splice(0).reverse();
  await Promise.all(fixtures.map((fixture) => fixture.lease.release()));
  for (const fixture of fixtures) await fixture.dispose();
});

const contribution = Object.freeze({ pluginId: 'acme.voice', localId: 'browser' });
const webConnectionAuthorizationGrant = Object.freeze({
  realm: 'web' as const,
  phase: 'connection' as const,
  request: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
  }),
});
const webPrepareAuthorizationGrant = Object.freeze({
  realm: 'web' as const,
  phase: 'prepare' as const,
  request: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://prepare.voice.example.test',
    headerNames: Object.freeze(['x-prepare-token']),
  }),
});
const iosConnectionAuthorizationGrant = Object.freeze({
  ...webConnectionAuthorizationGrant,
  realm: 'ios' as const,
});
const principalPresentation = Object.freeze({
    v: 1 as const,
    packageIdentity: Object.freeze({
      pluginId: contribution.pluginId,
      packageName: '@acme/voice',
    }),
    distributionIdentity: Object.freeze({
      kind: 'npm' as const,
      packageName: '@acme/voice',
      registryOrigin: 'https://registry.npmjs.org',
    }),
});
const principal = derivePluginInstallReviewPrincipalDigest(principalPresentation);
const principalSnapshot = Object.freeze({
  digest: principal,
  presentation: principalPresentation,
});

function manifest(mediatedOnly = false) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: contribution.pluginId,
    displayName: 'Acme Voice',
    version: '2.0.0',
    description: 'Private source metadata https://user:password@example.test/private.tgz?token=secret',
    contributes: {
      voiceProviders: [{
        id: contribution.localId,
        title: 'Browser Voice',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web', 'ios'],
        capabilities: { turn: { cancelResponse: true, bargeIn: true } },
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.browser', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            ...(mediatedOnly ? { operationProjections: [{ kind: 'recipientCredential',
              operation: 'client-auth', phase: 'connection', format: 'bearer' }] } : { rawGrants: [{
              ...webConnectionAuthorizationGrant,
            }, {
              ...webPrepareAuthorizationGrant,
            }, {
              ...iosConnectionAuthorizationGrant,
            }] }),
          }],
          ...(mediatedOnly ? { hostMediated: { operations: [{
            id: 'client-auth', purpose: 'voice.client-auth', credentialSlotId: 'api_key', effect: 'read',
            request: { origin: 'https://voice.example.test', pathTemplate: '/session', queryTemplate: [],
              headerTemplate: [], bodyTemplate: { kind: 'none' }, method: 'POST',
              credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
              redirect: 'error', maxBodyBytes: 0, contentTypes: [] },
            parameters: { schema: { type: 'object', properties: {}, additionalProperties: false }, mapping: [] },
            response: { maxBytes: 1024, contentTypes: ['application/json'] },
          }] } } : {}),
        },
        client: { artifactId: 'browser-client', exportName: 'activate' },
      }],
    },
  }));
  if (!parsed) throw new Error('Voice authorization fixture must be canonical');
  return parsed;
}

function manager() {
  const registrar = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger() {} });
  return {
    handlers: { get: (method: string) => (raw: unknown) => registrar.invokeLocal(method, raw) },
    registrar,
  };
}

async function createHarness(overrides: Readonly<{
  retireBeforeInspection?: boolean;
  materializationUnavailable?: boolean;
  rejectedPrincipalSnapshot?: typeof principalSnapshot;
  omitPrincipal?: boolean;
  accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
  mediatedOnly?: boolean;
}> = {}) {
  const exactManifest = manifest(overrides.mediatedOnly);
  const requesterRequest = vi.fn<(input: PluginPermissionGrantRequestActionInputV1) => void>();
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { resolveCurrentMachineId: () => overrides.materializationUnavailable ? null : 'machine-1' },
    plugins: [{ manifest: exactManifest, files: { 'daemon.mjs': 'export function activate() {}' } }],
  });
  admittedFixtures.push(fixture);
  await fixture.registry.activateContributionsOnDemand([{ pluginId: contribution.pluginId, family: 'voiceProviders', localId: contribution.localId }]);
  const commit = fixture.committed.commit;
  if (!commit) throw new Error('Expected committed authored installation');
  const paths = resolvePluginStorePaths({ happyHomeDir: fixture.happyHomeDir });
  const state = await readInstallationStateRevision({ paths, reference: commit.installationState, commit });
  const installation = state.plugins[contribution.pluginId];
  if (!installation) throw new Error('Expected admitted installation state');
  const reviewed = overrides.rejectedPrincipalSnapshot ?? principalSnapshot;
  const nextState = (includePresentation: boolean) => ({ ...state, revisionId: `state-${randomUUID()}`,
    createdAtMs: Date.now(), plugins: { ...state.plugins, [contribution.pluginId]: { ...installation,
      installReviewPrincipalDigest: overrides.omitPrincipal ? undefined : reviewed.digest,
      ...(includePresentation ? { installReviewPrincipalPresentation: overrides.omitPrincipal ? undefined : reviewed.presentation } : {}),
    } },
  });
  if (overrides.rejectedPrincipalSnapshot) {
    // An inconsistent pair cannot enter canonical storage. The valid
    // digest-only record then exercises the existing unavailable-review path.
    await expect(persistInstallationStateRevision({ paths, state: nextState(true) })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'custom',
        path: ['plugins', contribution.pluginId, 'installReviewPrincipalPresentation'],
      })]),
    });
  }
  const installationState = await persistInstallationStateRevision({
    paths, state: nextState(!overrides.rejectedPrincipalSnapshot),
  });
  await replacePluginRegistryCommitRecord({ paths, expectedCurrent: commit, next: {
    ...commit, revision: commit.revision + 1, baseRevision: commit.revision,
    transactionId: `fixture-review-${randomUUID()}`, installationState, createdAtMs: Date.now(),
  } });
  const materialization = fixture.registry.resolveCurrentPluginMaterializationRef?.(contribution.pluginId);
  if (overrides.retireBeforeInspection) {
    const successor = await createAuthoredAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: contribution.pluginId }), files: { 'daemon.mjs': 'export function activate() {}' } }],
    });
    admittedFixtures.push(successor);
  }
  vi.spyOn(axios, 'post').mockImplementation(async (_url, rawInput) => {
    const input = PluginPermissionGrantRequestActionInputV1Schema.parse(rawInput);
    requesterRequest(input);
    const authoritySource = await resolveCurrentPluginPermissionGrantAuthoritySource();
    if (!authoritySource) throw new Error('Expected actual installation publisher authority');
    return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: {
      pendingRequest: { v: 1, id: 'request-1', accountId: 'account-1', pluginId: input.pluginId,
        capability: input.capability, targetScope: input.targetScope, subject: input.subject,
        requester: input.requester, reason: input.reason, authoritySource,
        status: 'pending', createdAt: 1, updatedAt: 1 },
    } };
  });
  const service = createMachineVoiceClientCredentialAuthorizationService({
    machineId: 'machine-1',
    currentInstallReviewPrincipal: createRegistryInstallReviewPrincipalReader({ happyHomeDir: fixture.happyHomeDir }),
    getAccountSettingsSnapshot: () => overrides.accountSettingsSnapshot === undefined
      ? {
          source: 'network' as const,
          scopeKey: 'account-scope',
          settingsVersion: 1,
          loadedAtMs: 1,
          settingsSecretsReadKeys: [],
          connectedPurposeCatalog: { status: 'ready', revision: 1, record: {
            key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }),
          } },
          settings: accountSettingsParse({
            secrets: [SavedSecretSchema.parse({
              id: 'saved-secret',
              name: 'Voice API key',
              kind: 'apiKey',
              encryptedValue: { _isSecretValue: true, value: 'not-disclosed' },
              createdAt: 1,
              updatedAt: 1,
            })],
            voiceSettingsV1: {
              credentialBindings: [{
                contribution,
                credentialSlotId: 'api_key',
                credentialSource: { kind: 'savedSecret' },
                credentialBindings: { account: { api_key: 'saved-secret' } },
              }],
            },
          }),
        } satisfies ActiveAccountSettingsSnapshot
      : overrides.accountSettingsSnapshot,
    ensureAccountSettingsSnapshot: async () => undefined,
  });
  return {
    service,
    requesterRequest,
    fixture,
    materialization,
  };
}

describe('Voice client raw credential authorization RPC', () => {
  it('uses the existing inspect and request RPCs for a mediated-only recipient with the same custodian subject', async () => {
    const resourceId = 'mediated-custodian-secret';
    const secretRef = `happier:shared-secret:v1:${resourceId}`;
    const { service, requesterRequest } = await createHarness({ mediatedOnly: true,
      accountSettingsSnapshot: { source: 'network', scopeKey: 'account-scope', settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready',
        connectedPurposeCatalog: { status: 'ready', revision: 1, record: {
          key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } },
        savedSecretResources: [{ resourceId, ownerAccountId: 'custodian', relationship: 'recipient',
          capabilities: { use: true }, displayName: 'Voice credential', kind: 'apiKey',
          encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
          storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Voice credential', kind: 'apiKey', value: 'custodian-secret-never-disclosed' } }) }],
        settings: accountSettingsParse({ voiceSettingsV1: { credentialBindings: [{ contribution,
          credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: secretRef } } }] } }),
      } });
    const { handlers, registrar } = manager();
    registerMachineVoiceClientCredentialAuthorizationRpcHandlers({ rpcHandlerManager: registrar, service });
    const input = { contribution, rawGrant: webConnectionAuthorizationGrant };
    const inspected = DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse(await handlers.get(
      RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT)(input));
    expect(inspected).toMatchObject({ ok: true, authorization: { grantRequirement: 'approval_required' } });
    if (!inspected.ok) throw new Error('Expected the existing custodian review');
    const requested = DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema.parse(await handlers.get(
      RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST)(input));
    expect(requested).toMatchObject({ ok: true, pendingRequest: {
      subject: inspected.authorization.subject, capability: 'credentials.materialize.raw', status: 'pending' } });
    expect(requesterRequest.mock.calls[0]?.[0].subject).toEqual(inspected.authorization.subject);
    expect(JSON.stringify({ inspected, requested })).not.toContain('custodian-secret-never-disclosed');
  });

  it('inspects the current host-derived subject and exact normalized disclosure without creating a request', async () => {
    const { service, requesterRequest, fixture } = await createHarness();

    const inspected = await service.inspect({
      contribution,
      rawGrant: webConnectionAuthorizationGrant,
    });
    expect(inspected).toMatchObject({
      authorization: {
        pluginId: contribution.pluginId,
        capability: 'credentials.materialize.raw',
        targetScope: { kind: 'account' },
        subject: {
          contribution,
          credentialSlotId: 'api_key',
          purpose: 'voice.browser',
        },
        disclosures: [{
          sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
          realm: 'web',
          phase: 'connection',
          materialization: 'httpHeaders',
          origin: 'https://voice.example.test',
          destination: 'authorization',
        }],
      },
      review: {
        plugin: { id: 'acme.voice', name: 'Acme Voice', version: '2.0.0' },
        package: { identity: '@acme/voice' },
        distribution: {
          kind: 'npm',
          packageName: '@acme/voice',
          registryOrigin: 'https://registry.npmjs.org',
        },
        publisher: { status: 'unavailable' },
        contribution: { identity: contribution, name: 'Browser Voice' },
        credentialSlot: { id: 'api_key', name: 'API key', purpose: 'voice.browser' },
      },
    });
    expect(requesterRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(inspected)).not.toContain('password');
    expect(JSON.stringify(inspected)).not.toContain('token=secret');
    expect(fixture.registry.resolveVoiceProviderRuntimeLifecycle?.(contribution)?.isCurrent()).toBe(true);
  });

  it('reviews bundled Google speech credentials without an installed-package principal', async () => {
    const fixture = await createAdmittedPluginRuntimeFixture({
      happyHomeDir: home,
      controller: pluginReloadController,
      runtimeOptions: {
        pluginIds: ['happier.voice.google'],
        // Account census transport is outside this install-review regression;
        // use the canonical bundled declaration projection, with real admission.
        contributes: getResolvedContributionRegistry(),
        resolveCurrentMachineId: () => 'machine-1',
      },
    });
    try {
      const principalReader = createRegistryInstallReviewPrincipalReader({ happyHomeDir: home });
      await expect(principalReader.readCurrent({ pluginId: 'happier.voice.google',
        signal: new AbortController().signal })).resolves.toBeNull();
      const contributions = fixture.registry.contributes.voiceProviders.filter(
        (provider) => provider.pluginId === 'happier.voice.google',
      );
      expect(contributions.map((provider) => provider.identity.localId).sort()).toEqual(['gemini-stt', 'google-cloud-tts']);
      const resourceId = randomUUID();
      const secretRef = `happier:shared-secret:v1:${resourceId}`;
      const service = createMachineVoiceClientCredentialAuthorizationService({
        machineId: 'machine-1',
        currentInstallReviewPrincipal: principalReader,
        getAccountSettingsSnapshot: () => ({
          source: 'network', scopeKey: 'account-scope', settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], savedSecretCatalogState: 'ready',
          connectedPurposeCatalog: { status: 'ready', revision: 1, record: {
            key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }),
          } },
          savedSecretResources: [{ resourceId, ownerAccountId: 'custodian', relationship: 'recipient',
            capabilities: { use: true }, displayName: 'Google credential', kind: 'apiKey',
            encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
              content: { v: 1, name: 'Google credential', kind: 'apiKey', value: 'never-disclosed' } }) }],
          settings: accountSettingsParse({ voiceSettingsV1: { credentialBindings: contributions.map((provider) => ({
            contribution: provider.identity, credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { api_key: secretRef } },
          })) } }),
        }),
      });
      for (const provider of contributions) {
        await fixture.registry.activateContributionsOnDemand([{
          pluginId: provider.pluginId, family: 'voiceProviders', localId: provider.identity.localId,
        }]);
        const rawGrant = provider.definition.credentials?.sources[0]?.rawGrants?.[0];
        if (!rawGrant) throw new Error('Google speech must declare its raw credential tuple');
        await expect(service.inspect({ contribution: provider.identity, rawGrant })).resolves.toMatchObject({
          authorization: { grantRequirement: 'approval_required', subject: { contribution: provider.identity } },
          review: { plugin: { id: provider.pluginId }, distribution: { kind: 'bundled' },
            publisher: { status: 'bundled_first_party', identity: 'Happier' } },
        });
      }
    } finally {
      await fixture.lease.release();
      await fixture.dispose();
    }
  });

  it('refuses an external installation whose install-review principal is absent', async () => {
    const { service } = await createHarness({ omitPrincipal: true });
    await expect(service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant }))
      .rejects.toMatchObject({ code: 'plugin_voice_credential_access_unavailable' });
  });

  it('requests only the exact daemon-derived subject for the current installed contribution', async () => {
    const { service, requesterRequest, materialization } = await createHarness();

    await expect(service.request({
      contribution,
      rawGrant: webConnectionAuthorizationGrant,
    })).resolves.toMatchObject({
      authorization: { subject: { contribution, credentialSlotId: 'api_key' } },
      pendingRequest: { id: 'request-1' },
    });
    expect(requesterRequest).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: contribution.pluginId,
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: expect.objectContaining({ contribution, credentialSlotId: 'api_key' }),
      requester: { kind: 'plugin', pluginId: contribution.pluginId },
      reason: 'Voice provider raw credential access review',
      caller: materialization,
    }));
  });

  it('fails closed before requesting when the exact current materialization is unavailable', async () => {
    const { service, requesterRequest } = await createHarness({ materializationUnavailable: true });

    await expect(service.request({ contribution, rawGrant: webConnectionAuthorizationGrant })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(requesterRequest).not.toHaveBeenCalled();
  });

  it('fails closed when Account Settings has no selected raw credential authority', async () => {
    const { service } = await createHarness({ accountSettingsSnapshot: null });

    await expect(service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('fails closed to unavailable review facts when the stored principal presentation does not match its digest', async () => {
    const mismatchedPrincipalSnapshot = Object.freeze({
      ...principalSnapshot,
      digest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
    });
    const { service } = await createHarness({ rejectedPrincipalSnapshot: mismatchedPrincipalSnapshot });

    await expect(service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant })).resolves.toMatchObject({
      review: {
        publisher: { status: 'unavailable' },
        distribution: { kind: 'unavailable' },
        package: { identity: contribution.pluginId },
      },
    });
  });

  it('rejects stale runtime authority and strict caller attempts to supply a subject', async () => {
    const stale = await createHarness({ retireBeforeInspection: true });
    expect(stale.fixture.registry.resolveVoiceProviderRuntimeLifecycle?.(contribution)?.isCurrent()).toBe(false);
    await expect(stale.service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const { handlers, registrar } = manager();
    const { service } = await createHarness();
    registerMachineVoiceClientCredentialAuthorizationRpcHandlers({
      rpcHandlerManager: registrar,
      service,
    });
    await expect(Promise.resolve(handlers.get(
      RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST,
    )?.({ contribution, rawGrant: webConnectionAuthorizationGrant, subject: { kind: 'general' } }))).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
    });
  });

  it('derives independent permission subjects and disclosure rows for exact raw tuples', async () => {
    const { service } = await createHarness();

    const web = await service.inspect({
      contribution,
      rawGrant: webConnectionAuthorizationGrant,
    });
    const prepare = await service.inspect({
      contribution,
      rawGrant: webPrepareAuthorizationGrant,
    });

    expect(web.authorization.disclosures).toEqual([expect.objectContaining({
      realm: 'web',
      phase: 'connection',
      materialization: 'httpHeaders',
      destination: 'authorization',
    })]);
    expect(prepare.authorization.disclosures).toEqual([expect.objectContaining({
      realm: 'web',
      phase: 'prepare',
      materialization: 'httpHeaders',
      destination: 'x-prepare-token',
    })]);
    expect(web.authorization.subject).not.toEqual(prepare.authorization.subject);
    const ios = await service.inspect({ contribution, rawGrant: iosConnectionAuthorizationGrant });
    expect(ios.authorization.subject).not.toEqual(web.authorization.subject);

    await expect(service.inspect({
      contribution,
      rawGrant: {
        ...webConnectionAuthorizationGrant,
        request: {
          ...webConnectionAuthorizationGrant.request,
          headerNames: ['x-other-token'],
        },
      },
    })).rejects.toMatchObject({ code: 'plugin_voice_credential_access_unavailable' });
  });
});
