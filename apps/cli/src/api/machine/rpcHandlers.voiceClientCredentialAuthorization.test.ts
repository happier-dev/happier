import { describe, expect, it, vi } from 'vitest';

import { PluginInstallReviewPrincipalDigestSchema } from '@happier-dev/protocol';
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
        platforms: ['web'],
        capabilities: { turn: { cancelResponse: true, bargeIn: true } },
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.browser', title: 'API key' },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'web',
              phase: 'connection',
              request: {
                kind: 'httpHeaders',
                origin: 'https://voice.example.test',
                headerNames: ['authorization'],
              },
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
  principalSnapshot?: typeof principalSnapshot;
  accountSettingsSnapshot?: unknown;
}> = {}) {
  const exactManifest = manifest();
  const release = vi.fn(async () => undefined);
  const requesterRequest = vi.fn();
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
            ...input,
            authoritySource: daemonGrantAuthority,
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        };
      },
    }),
  });
  return { service, release, requesterRequest, resolveVoiceProviderRuntimeLifecycle };
}

describe('Voice client raw credential authorization RPC', () => {
  it('inspects the current host-derived subject and exact normalized disclosure without creating a request', async () => {
    const { service, requesterRequest, release, resolveVoiceProviderRuntimeLifecycle } = createHarness();

    const inspected = await service.inspect({ contribution });
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

    await expect(service.request({ contribution })).resolves.toMatchObject({
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
    }));
  });

  it('fails closed when Account Settings has no selected raw credential authority', async () => {
    const { service } = createHarness({ accountSettingsSnapshot: null });

    await expect(service.inspect({ contribution })).rejects.toMatchObject({
      code: 'plugin_voice_credential_access_unavailable',
    });
  });

  it('never projects publisher or package-signature presentation from a mismatched review principal', async () => {
    const mismatchedPrincipalSnapshot = Object.freeze({
      ...principalSnapshot,
      digest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
    });
    const { service } = createHarness({ principalSnapshot: mismatchedPrincipalSnapshot });

    await expect(service.inspect({ contribution })).resolves.toMatchObject({
      review: {
        publisher: { status: 'unavailable' },
        packageSignature: { status: 'unavailable' },
      },
    });
  });

  it('rejects stale runtime authority and strict caller attempts to supply a subject', async () => {
    const stale = createHarness({ current: () => false });
    await expect(stale.service.inspect({ contribution })).rejects.toMatchObject({
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
    )?.({ contribution, subject: { kind: 'general' } }))).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
    });
  });
});
