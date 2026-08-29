import { describe, expect, it, vi } from 'vitest';

import {
  PluginInstallReviewPrincipalDigestSchema,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { derivePluginInstallReviewPrincipalDigest } from '../../plugins/daemon/installReviewPrincipal';
import {
  createMachineVoiceClientCredentialAuthorizationService,
  registerMachineVoiceClientCredentialAuthorizationRpcHandlers,
} from './rpcHandlers.voiceClientCredentialAuthorization';

const daemonGrantAuthority = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-1',
  installationId: 'installation-1',
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
    publisherIdentity: Object.freeze({
      status: 'unverified' as const,
      id: 'acme',
      displayName: 'Acme',
    }),
    packageSignature: Object.freeze({
      status: 'verified' as const,
      keyId: 'acme-key',
    }),
});
const principal = derivePluginInstallReviewPrincipalDigest(principalPresentation);
const principalSnapshot = Object.freeze({
  digest: principal,
  presentation: principalPresentation,
});

function manifest() {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: contribution.pluginId,
    displayName: 'Acme Voice',
    version: '2.0.0',
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
            rawGrants: [{
              ...webConnectionAuthorizationGrant,
            }, {
              ...webPrepareAuthorizationGrant,
            }, {
              ...iosConnectionAuthorizationGrant,
            }],
          }],
        },
        client: { artifactId: 'browser-client', modulePath: './voice', exportName: 'activate' },
      }],
    },
  }));
  if (!parsed) throw new Error('Voice authorization fixture must be canonical');
  return parsed;
}

function manager() {
  const handlers = new Map<string, RpcHandler>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return {
    handlers,
    registrar,
  };
}

function createHarness(overrides: Readonly<{
  current?: () => boolean;
  materialization?: () => PluginMachineMaterializationRefV1 | null;
  principalSnapshot?: typeof principalSnapshot;
  accountSettingsSnapshot?: unknown;
}> = {}) {
  const exactManifest = manifest();
  const release = vi.fn(async () => undefined);
  const requesterRequest = vi.fn();
  const materialization = Object.freeze({
    pluginId: contribution.pluginId,
    machineId: 'machine-1',
    materializationId: 'materialization-1',
  });
  const resolveCurrentPluginMaterializationRef = vi.fn(
    overrides.materialization ?? ((pluginId: string) => (
      pluginId === contribution.pluginId ? materialization : null
    )),
  );
  const resolveVoiceProviderRuntimeLifecycle = vi.fn((identity: typeof contribution) => (
    identity.pluginId === contribution.pluginId && identity.localId === contribution.localId
      ? {
          generation: 'generation-1',
          isCurrent: overrides.current ?? (() => true),
          retirementSignal: new AbortController().signal,
        }
      : null
  ));
  const service = createMachineVoiceClientCredentialAuthorizationService({
    machineId: 'machine-1',
    acquireRuntimeLease: async () => ({
      registry: {
        contributes: {
          voiceProviders: [{
            provenance: 'external',
            source: { kind: 'package' },
            pluginId: contribution.pluginId,
            pluginVersion: exactManifest.version,
            identity: contribution,
            manifestPath: '/plugins/acme.voice/plugin.json',
            sourceSpec: {
              kind: 'package',
              locator: 'https://user:password@example.test/private.tgz?token=secret',
              trustPolicy: 'prompt',
              installPolicy: 'managed_install',
            },
            definition: exactManifest.contributes.voiceProviders![0]!,
          }],
        },
        resolveVoiceProviderRuntimeLifecycle,
        resolveCurrentPluginMaterializationRef,
      },
      release,
    } as never),
    readManifest: async () => ({
      ok: true as const,
      manifestPath: '/plugins/acme.voice/plugin.json',
      manifestRawText: '{}',
      manifest: exactManifest,
    }),
    currentInstallReviewPrincipal: {
      readCurrent: async () => overrides.principalSnapshot ?? principalSnapshot,
    },
    readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
    getAccountSettingsSnapshot: () => overrides.accountSettingsSnapshot === undefined
      ? {
          source: 'network' as const,
          scopeKey: 'account-scope',
          settingsVersion: 1,
          loadedAtMs: 1,
          settingsSecretsReadKeys: [],
          settings: {
            secrets: [{
              id: 'saved-secret',
              name: 'Voice API key',
              kind: 'apiKey',
              encryptedValue: { _isSecretValue: true, value: 'not-disclosed' },
              createdAt: 1,
              updatedAt: 1,
            }],
            voiceSettingsV1: {
              credentialBindings: [{
                contribution,
                credentialSlotId: 'api_key',
                credentialSource: { kind: 'savedSecret' },
                credentialBindings: { account: { api_key: 'saved-secret' } },
              }],
            },
          } as never,
        }
      : overrides.accountSettingsSnapshot as never,
    ensureAccountSettingsSnapshot: async () => undefined,
    readStoredCredentials: async () => ({ token: 'account-token' } as never),
    createGrantRequester: () => ({
      request: async (input) => {
        requesterRequest(input);
        return {
          pendingRequest: {
            v: 1,
            id: 'request-1',
            accountId: 'account-1',
            pluginId: input.pluginId,
            capability: input.capability,
            targetScope: input.targetScope,
            subject: input.subject,
            requester: input.requester,
            reason: input.reason,
            authoritySource: daemonGrantAuthority,
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        };
      },
    }),
  });
  return {
    service,
    release,
    requesterRequest,
    resolveVoiceProviderRuntimeLifecycle,
    resolveCurrentPluginMaterializationRef,
  };
}

describe('Voice client raw credential authorization RPC', () => {
  it('inspects the current host-derived subject and exact normalized disclosure without creating a request', async () => {
    const { service, requesterRequest, release, resolveVoiceProviderRuntimeLifecycle } = createHarness();

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
          installReviewPrincipalDigest: principal,
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
        publisher: { status: 'unverified', id: 'acme', displayName: 'Acme' },
        packageSignature: { status: 'verified', keyId: 'acme-key' },
        contribution: { identity: contribution, name: 'Browser Voice' },
        credentialSlot: { id: 'api_key', name: 'API key', purpose: 'voice.browser' },
      },
    });
    expect(requesterRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(inspected)).not.toContain('password');
    expect(JSON.stringify(inspected)).not.toContain('token=secret');
    expect(resolveVoiceProviderRuntimeLifecycle).toHaveBeenCalledWith(contribution);
    expect(release).toHaveBeenCalledOnce();
  });

  it('requests only the exact daemon-derived subject for the current installed contribution', async () => {
    const { service, requesterRequest } = createHarness();

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
      caller: {
        pluginId: contribution.pluginId,
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
    }));
  });

  it('fails closed before requesting when the exact current materialization is unavailable', async () => {
    const { service, requesterRequest } = createHarness({ materialization: () => null });

    await expect(service.request({ contribution, rawGrant: webConnectionAuthorizationGrant })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
    expect(requesterRequest).not.toHaveBeenCalled();
  });

  it('fails closed when Account Settings has no selected raw credential authority', async () => {
    const { service } = createHarness({ accountSettingsSnapshot: null });

    await expect(service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('never projects publisher or package-signature presentation from a mismatched review principal', async () => {
    const mismatchedPrincipalSnapshot = Object.freeze({
      ...principalSnapshot,
      digest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
    });
    const { service } = createHarness({ principalSnapshot: mismatchedPrincipalSnapshot });

    await expect(service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant })).resolves.toMatchObject({
      review: {
        publisher: { status: 'unavailable' },
        packageSignature: { status: 'unavailable' },
      },
    });
  });

  it('rejects stale runtime authority and strict caller attempts to supply a subject', async () => {
    const stale = createHarness({ current: () => false });
    await expect(stale.service.inspect({ contribution, rawGrant: webConnectionAuthorizationGrant })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });

    const { handlers, registrar } = manager();
    const service = createHarness().service;
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
    const { service } = createHarness();

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
