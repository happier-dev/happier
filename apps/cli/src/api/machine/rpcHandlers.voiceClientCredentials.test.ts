import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  PluginInstallReviewPrincipalDigestSchema,
  type PluginPermissionGrantListActionInputV1,
} from '@happier-dev/protocol';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readCanonicalPluginManifest } from '../../plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '../../plugins/testkit/manifestV2Fixture';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

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
  artifactDigest: `sha256:${'b'.repeat(64)}`,
});
const selection = Object.freeze({ contribution, platform: 'web' as const, cacheIdentity: identity });

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
        client: { artifactId: 'browser-client', exportName: 'activate' },
      }],
    },
  }));
  if (!parsed) throw new Error('client voice manifest fixture must be canonical');
  return parsed;
}

function manager() {
  const registrar = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger() {} });
  return {
    handlers: { get: (method: string) => (raw: unknown) => registrar.invokeLocal(method, raw) },
    registrar,
  };
}

const admittedFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
afterAll(async () => {
  const fixtures = admittedFixtures.splice(0).reverse();
  await Promise.all(fixtures.map((fixture) => fixture.lease.release()));
  for (const fixture of fixtures) await fixture.dispose();
});

async function admitClient(readSnapshot: () => ActiveAccountSettingsSnapshot | null,
  materializeAccount: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount']) {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected Account selection or listing'); };
  const connectedAccounts = createConnectedAccountPurposeBindingOwner({
    store: {
      read: async () => {
        const catalog = readSnapshot()?.connectedPurposeCatalog;
        if (catalog?.status !== 'ready' || catalog.record.key !== 'purposes') throw new Error('Purpose catalog unavailable');
        return catalog.record.value;
      }, update: unexpected, subscribe: () => ({ dispose() {} }),
    },
    selectTarget: unexpected,
    resolveTarget: async (target) => target.kind === 'account' ? { account: target.account, displayName: 'Account A' } : null,
    materializeAccount, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { connectedAccounts, resolveCurrentMachineId: () => 'machine-a' },
    plugins: [{ manifest: manifest(), files: { 'daemon.mjs': 'export function activate() {}' } }],
  });
  admittedFixtures.push(fixture);
  await fixture.registry.activateContributionsOnDemand([{ pluginId: contribution.pluginId, family: 'voiceProviders', localId: contribution.localId }]);
  return fixture;
}

describe('Voice client raw credential machine RPC', () => {
  it('materializes headers only for the exact current client projection identity and declaration tuple', async () => {
    const { handlers, registrar } = manager();

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

    const principal = PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64));
    const readSnapshot = () => ({
          source: 'network', scopeKey: 'account-scope', settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [],
          settings: accountSettingsParse({
            voiceSettingsV1: {
              credentialBindings: [{
                contribution,
                credentialSlotId: 'api_key',
                credentialSource: { kind: 'connectedAccount' },
                credentialBindings: { account: {} },
              }],
            },
          }),
          connectedPurposeCatalog: { status: 'ready', revision: 1, record: {
            key: 'purposes', value: ConnectedPurposeCatalogV1Schema.parse({
              v: 1, bindings: [{
                purpose: { consumer: contribution, purpose: 'voice.browser' },
                target: { kind: 'account', account: { service, accountId: 'account-a' } },
              }],
            }),
          } },
        } satisfies ActiveAccountSettingsSnapshot);
    const fixture = await admitClient(readSnapshot, materialize);
    registerMachineVoiceClientCredentialRpcHandlers({
      rpcHandlerManager: registrar,
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
        getAccountSettingsSnapshot: readSnapshot,
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE)?.({
      ...selection,
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
    expect(fixture.registry.resolveVoiceProviderRuntimeLifecycle?.(contribution)?.isCurrent()).toBe(true);

    const materializeRaw = handlers.get(
      RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
    );
    await expect(materializeRaw?.({
      ...selection,
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
      ...selection,
      phase: 'connection',
      expectedCredentialRevision: revisionA,
      request,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    await expect(materializeRaw?.({
      ...selection,
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
      ...selection,
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

  it('rejects browser environment access and invalid phases, and refuses unavailable access for declared phases before reading a secret', async () => {
    const { handlers, registrar } = manager();

    const materialize = vi.fn();

    await admitClient(() => null, materialize);
    registerMachineVoiceClientCredentialRpcHandlers({
      rpcHandlerManager: registrar,
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
      ...selection,
      phase: 'connection',
      request: { kind: 'environment', keys: ['VOICE_TOKEN'] },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_provider_result_invalid',
    });
    await expect(invoke?.({ ...selection, phase: 'undeclared', request })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_provider_result_invalid',
    });
    for (const phase of ['settings', 'prepare', 'connection']) {
      await expect(invoke?.({ ...selection, phase, request })).resolves.toEqual({
        ok: false,
        errorCode: 'plugin_voice_credential_access_unavailable',
      });
    }
    expect(materialize).not.toHaveBeenCalled();
  });
});
