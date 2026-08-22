import { describe, expect, it, vi } from 'vitest';

import {
  PluginInstallReviewPrincipalDigestSchema,
  type PluginPermissionGrantListActionInputV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';

const runtimeLeaseMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));

import { registerMachineVoiceClientCredentialRpcHandlers } from './rpcHandlers.voiceClientCredentials';

const daemonGrantAuthority = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-1',
  installationId: 'installation-1',
});

const contribution = Object.freeze({ pluginId: 'acme.voice', localId: 'browser' });
const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'oauth' });
const request = Object.freeze({
  kind: 'httpHeaders' as const,
  origin: 'https://voice.example.test',
  headerNames: Object.freeze(['authorization']),
});
const identity = Object.freeze({
  pluginId: contribution.pluginId,
  contributionId: contribution.localId,
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  hostAppVersion: '2.0.0',
  hostUiApiVersion: '1.0.0',
  reactVersion: '19.0.0',
  reactNativeVersion: '0.83.4',
  platform: 'web' as const,
  channel: 'internal' as const,
  nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
  projectionGeneration: 12,
});

function manifest() {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: contribution.pluginId,
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
            kind: 'connectedAccount',
            service,
            rawGrants: [{ realm: 'web', phase: 'connection', request }],
          }],
        },
        client: { artifactId: 'browser-client', modulePath: './voice', exportName: 'activate' },
      }],
    },
  }));
  if (!parsed) throw new Error('client voice manifest fixture must be canonical');
  return parsed;
}

function manager() {
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  return {
    handlers,
    registrar: {
      registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
        handlers.set(method, handler);
      },
    },
  };
}

describe('Voice client raw credential machine RPC', () => {
  it('materializes headers only for the exact current client projection identity and declaration tuple', async () => {
    const { handlers, registrar } = manager();
    const exactManifest = manifest();
    const current = vi.fn(() => true);
    const resolveVoiceProviderRuntimeLifecycle = vi.fn((candidate: typeof contribution) => (
      candidate.pluginId === contribution.pluginId && candidate.localId === contribution.localId
        ? {
            generation: 'immutable-provider-generation-12',
            isCurrent: current,
            retirementSignal: new AbortController().signal,
          }
        : null
    ));
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let credentialRevision = revisionA;
    const materialize = vi.fn(async (input: Readonly<{
      credentialRevisionBasis?: Readonly<{
        captureCredentialRevision(credentialRevision: string): void;
      }>;
    }>) => {
      input.credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
      return {
        kind: 'httpHeaders' as const,
        headers: { authorization: `Bearer ${credentialRevision}` },
      };
    });
    const listInputs: PluginPermissionGrantListActionInputV1[] = [];
    runtimeLeaseMocks.acquire.mockResolvedValue({
      registry: {
        generation: 12,
        contributes: {
          activationTargets: [{
            pluginId: contribution.pluginId,
            manifest: exactManifest,
          }],
          voiceProviders: [{
            pluginId: contribution.pluginId,
            identity: contribution,
            definition: exactManifest.contributes.voiceProviders![0]!,
          }],
        },
        resolveVoiceProviderRuntimeLifecycle,
        resolveConnectedAccountPurposeBindingOwner: () => ({
          getBinding: async () => ({
            purpose: 'voice.browser',
            service,
            account: { service, accountId: 'account-a' },
            target: { kind: 'account' as const, displayName: 'Account A' },
          }),
          materialize,
        }),
      },
      release: runtimeLeaseMocks.release,
    });
    const principal = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));
    registerMachineVoiceClientCredentialRpcHandlers({
      rpcHandlerManager: registrar as never,
      machineId: 'machine-a',
      resolveRawCredentialDependencies: async () => ({
        currentInstallReviewPrincipal: { readCurrent: async () => ({ digest: principal, presentation: null }) },
        readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
        grants: {
          list: async (input) => {
            listInputs.push(input);
            return {
              grants: [{
                v: 1,
                id: 'grant-1',
                accountId: 'account-scope',
                pluginId: contribution.pluginId,
                capability: 'credentials.materialize.raw',
                targetScope: { kind: 'account' },
                subject: input.subject!,
                authoritySource: daemonGrantAuthority,
                status: 'active',
                grantedByUserId: 'user-1',
                grantedAt: 1,
                createdAt: 1,
                updatedAt: 1,
              }],
              pendingRequests: [],
            };
          },
        },
        getAccountSettingsSnapshot: () => ({
          source: 'network', scopeKey: 'account-scope', settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [],
          settings: {
            voiceSettingsV1: {
              credentialBindings: [{
                contribution,
                credentialSlotId: 'api_key',
                credentialSource: { kind: 'connectedAccount' },
                credentialBindings: { account: {} },
              }],
            },
            connectedAccountPurposeBindingsV1: {
              v: 1,
              bindings: [{
                purpose: { consumer: contribution, purpose: 'voice.browser' },
                target: { kind: 'account', account: { service, accountId: 'account-a' } },
              }],
            },
          } as never,
        }),
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE)?.({
      cacheIdentity: identity,
      phase: 'connection',
      request,
    })).resolves.toEqual({
      ok: true,
      materialization: { kind: 'httpHeaders', headers: { authorization: `Bearer ${revisionA}` } },
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(listInputs.at(-1)).toMatchObject({
      pluginId: contribution.pluginId,
      subject: { contribution },
    });
    expect(current).toHaveBeenCalled();
    expect(resolveVoiceProviderRuntimeLifecycle).toHaveBeenCalledWith(contribution);

    const materializeRaw = handlers.get(
      RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
    );
    await expect(materializeRaw?.({
      cacheIdentity: identity,
      phase: 'connection',
      expectedCredentialRevision: null,
      request,
    })).resolves.toEqual({
      ok: true,
      materialization: { kind: 'httpHeaders', headers: { authorization: `Bearer ${revisionA}` } },
      credentialRevision: revisionA,
    });

    credentialRevision = revisionB;
    await expect(materializeRaw?.({
      cacheIdentity: identity,
      phase: 'connection',
      expectedCredentialRevision: revisionA,
      request,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    await expect(materializeRaw?.({
      cacheIdentity: identity,
      phase: 'connection',
      expectedCredentialRevision: null,
      request,
    })).resolves.toEqual({
      ok: true,
      materialization: { kind: 'httpHeaders', headers: { authorization: `Bearer ${revisionB}` } },
      credentialRevision: revisionB,
    });

    materialize.mockRejectedValueOnce(new Error('must-not-reflect-secret-cause'));
    const failed = await handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE)?.({
      cacheIdentity: identity,
      phase: 'connection',
      request,
    });
    expect(failed).toEqual({
      ok: false,
      errorCode: 'plugin_voice_provider_operation_failed',
    });
    expect(failed).not.toHaveProperty('cause');
    expect(failed).not.toHaveProperty('error');
  });

  it('rejects browser environment access and an undeclared phase before reading a secret', async () => {
    const { handlers, registrar } = manager();
    const exactManifest = manifest();
    const materialize = vi.fn();
    runtimeLeaseMocks.acquire.mockResolvedValue({
      registry: {
        generation: 12,
        contributes: {
          activationTargets: [{
            pluginId: contribution.pluginId,
            manifest: exactManifest,
          }],
          voiceProviders: [{
            pluginId: contribution.pluginId,
            identity: contribution,
            definition: exactManifest.contributes.voiceProviders![0]!,
          }],
        },
        resolveVoiceProviderRuntimeLifecycle: () => ({
          generation: '12', isCurrent: () => true, retirementSignal: new AbortController().signal,
        }),
        resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
      },
      release: runtimeLeaseMocks.release,
    });
    registerMachineVoiceClientCredentialRpcHandlers({
      rpcHandlerManager: registrar as never,
      machineId: 'machine-a',
      resolveRawCredentialDependencies: async () => ({
        currentInstallReviewPrincipal: { readCurrent: async () => ({
          digest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
          presentation: null,
        }) },
        readCurrentGrantAuthoritySource: async () => daemonGrantAuthority,
        grants: { list: vi.fn() },
        getAccountSettingsSnapshot: () => null,
      }),
    });
    const invoke = handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE);

    await expect(invoke?.({
      cacheIdentity: identity,
      phase: 'connection',
      request: { kind: 'environment', keys: ['VOICE_TOKEN'] },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_provider_result_invalid',
    });
    await expect(invoke?.({ cacheIdentity: identity, phase: 'settings', request })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_provider_result_invalid',
    });
    await expect(invoke?.({ cacheIdentity: identity, phase: 'connection', request })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(materialize).not.toHaveBeenCalled();
  });
});
