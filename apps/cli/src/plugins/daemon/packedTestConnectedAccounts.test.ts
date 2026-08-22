import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';

const pluginId = 'acme.connected-accounts-conformance';
const consumer = { pluginId, localId: 'verify' } as const;
const purpose = { consumer, purpose: 'fixed' } as const;
const service = { pluginId, localId: 'vault' } as const;
const temporaryRoots: string[] = [];

type PublicProducerObservation = {
  authentication: Array<Readonly<{ service: string; token: string }>>;
  refresh: Array<Readonly<{ accountId: string; token: string }>>;
  materialize: Array<Readonly<{ accountId: string; token: string }>>;
  blockNextMaterialize?: boolean;
  abortObserved?: boolean;
  onMaterializeStarted?: () => void;
};

declare global {
  // eslint-disable-next-line no-var
  var __HAPPIER_PACKED_CONNECTED_ACCOUNT_PUBLIC_PRODUCER__:
    PublicProducerObservation | undefined;
}

function registryWithFixedPurpose(): ResolvedContributionRegistry {
  const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: pluginId,
    hostAccess: {
      required: [{
        id: 'fixed',
        capability: 'connectedAccounts',
        reason: 'Use the fixed account',
        scope: {
          serviceRefs: ['vault'],
          operations: ['select', 'use'],
        },
      }],
      optional: [],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'vault',
        title: 'Acme Vault',
        authentication: {
          defaultModeId: 'oauth',
          modes: [{
            id: 'oauth',
            kind: 'oauthDeviceCode',
            outcomeReconciliation: 'providerCheck',
          }],
        },
      }],
      actions: [{
        id: consumer.localId,
        title: 'Verify',
        scopes: ['global'],
        surfaces: ['cli'],
        execution: { target: 'daemon' },
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
        hostAccess: ['fixed'],
      }],
    },
  }));
  if (!manifest) throw new Error('Expected a canonical packed Connected Accounts manifest');
  return {
    ...emptyRegistry(),
    activationTargets: [{
      pluginId,
      manifestPath: '/fixture/.happier-plugin/plugin.json',
      daemonEntryPath: null,
      manifest,
      source: { kind: 'path' },
      provenance: 'external',
      sourceSpec: {
        kind: 'path',
        locator: '/fixture',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    }],
  };
}

function emptyRegistry(): ResolvedContributionRegistry {
  return {
    agents: [],
        providers: [],
    actions: [],
    tools: [],
    commands: [],
    resources: [],
    activationTargets: [],
    actionsById: new Map(),
    toolsById: new Map(),
    commandsById: new Map(),
    resourcesById: new Map(),
        catalogEntriesById: {},
    agentDefinitionsById: new Map(),
        providersByContributionKey: new Map(),
    pluginDiagnosticsByPluginId: {},
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('packed Connected Accounts runtime boundary', () => {
  it('routes an independent public producer through authentication, refresh, and materialization', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-packed-connected-accounts-'));
    const producerRoot = await mkdtemp(join(tmpdir(), 'happier-packed-connected-producer-'));
    temporaryRoots.push(happyHomeDir, producerRoot);
    const producerPluginId = 'acme.packed-connected-producer';
    const producerService = { pluginId: producerPluginId, localId: 'vault' } as const;
    const consumerPluginId = 'acme.packed-connected-consumer';
    await mkdir(join(producerRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(producerRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: producerPluginId,
      version: '1.0.0',
      displayName: 'Packed Connected Account producer',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      activation: { events: [{ kind: 'startup' }] },
      hostAccess: { required: [], optional: [] },
      contributes: {
        connectedAccountDescriptors: [{
          id: producerService.localId,
          title: 'Packed account',
          authentication: {
            defaultModeId: 'manual',
            modes: [{
              id: 'manual',
              kind: 'manual',
              outcomeReconciliation: 'none',
              fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string', minLength: 1 },
                secret: true,
              }],
            }],
          },
        }],
      },
    }), 'utf8');
    globalThis.__HAPPIER_PACKED_CONNECTED_ACCOUNT_PUBLIC_PRODUCER__ = {
      authentication: [],
      refresh: [],
      materialize: [],
    };
    await writeFile(join(producerRoot, 'daemon.mjs'), `export function activate(api) {
      const observation = globalThis.__HAPPIER_PACKED_CONNECTED_ACCOUNT_PUBLIC_PRODUCER__;
      if (!observation) throw new Error('Expected public producer observation');
      api.connectedAccounts.register('vault', {
        authentication: { modes: { manual: { kind: 'manual', async complete(input, context, options) {
          const token = input.fields.token;
          observation.authentication.push({ service: context.service.localId, token });
          await context.attemptCredentials.set('token', token, options);
          return { status: 'connected', displayName: 'Packed account', scopes: [] };
        } } } },
        async refresh(context, options) {
          const token = await context.credentials.get('token', options);
          observation.refresh.push({ accountId: context.account.accountId, token });
          return { status: 'connected', displayName: 'Packed account', scopes: [] };
        },
        async revoke() { return { status: 'remoteUnsupported' }; },
        async status() { return { status: 'connected', displayName: 'Packed account', scopes: [] }; },
        async materialize(request, context, options) {
          const token = await context.credentials.get('token', options);
          observation.materialize.push({ accountId: context.account.accountId, token });
          if (observation.blockNextMaterialize) {
            observation.blockNextMaterialize = false;
            observation.onMaterializeStarted?.();
            await new Promise((resolve, reject) => {
              options?.signal.addEventListener('abort', () => {
                observation.abortObserved = true;
                reject(options.signal.reason);
              }, { once: true });
            });
          }
          if (request.kind === 'environment') {
            return { kind: 'environment', env: { [request.keys[0]]: 'producer:' + context.account.accountId + ':' + token } };
          }
          if (request.kind === 'httpHeaders') return { kind: 'httpHeaders', headers: {} };
          return { kind: 'files', files: {} };
        },
      });
    }`, 'utf8');
    await seedCurrentLocalPathPluginFixture({
      happyHomeDir,
      pluginRoot: producerRoot,
      pluginId: producerPluginId,
      manifestVersion: '1.0.0',
    });
    const reloadController = createPluginReloadController({
      happyHomeDir,
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
      }),
    });
    const runtime = createPackedTestConnectedAccountsRuntime({
      happyHomeDir,
      pluginId: consumerPluginId,
      runtimeRegistry: reloadController,
    });
    const signal = new AbortController().signal;

    try {
      const binding = await runtime.owner.requestSelection({
        purpose: { consumer: { pluginId: consumerPluginId, localId: 'verify' }, purpose: 'fixed' },
        serviceRefs: [producerService],
        assertGenerationCurrent: () => undefined,
        reason: 'Select the packed account',
        signal,
      });
      expect(JSON.stringify(binding)).not.toContain('packed-test-token');

      await expect(runtime.owner.materialize({
        purpose: { consumer: { pluginId: consumerPluginId, localId: 'verify' }, purpose: 'fixed' },
        serviceRefs: [producerService],
        expectedAccount: binding.account,
        request: { kind: 'environment', keys: ['FIXED_TOKEN'] },
        signal,
      })).resolves.toEqual({
        kind: 'environment',
        env: { FIXED_TOKEN: 'producer:fixed:packed-test-token' },
      });
      expect(globalThis.__HAPPIER_PACKED_CONNECTED_ACCOUNT_PUBLIC_PRODUCER__).toMatchObject({
        authentication: [{ service: 'vault', token: 'packed-test-token' }],
        refresh: [{ accountId: 'fixed', token: 'packed-test-token' }],
        materialize: [{ accountId: 'fixed', token: 'packed-test-token' }],
      });
      const observation = globalThis.__HAPPIER_PACKED_CONNECTED_ACCOUNT_PUBLIC_PRODUCER__;
      if (!observation) throw new Error('Expected public producer observation');
      let notifyMaterializeStarted!: () => void;
      const materializeStarted = new Promise<void>((resolve) => {
        notifyMaterializeStarted = resolve;
      });
      observation.blockNextMaterialize = true;
      observation.onMaterializeStarted = notifyMaterializeStarted;
      const cancellation = new AbortController();
      const cancelledMaterialization = runtime.owner.materialize({
        purpose: { consumer: { pluginId: consumerPluginId, localId: 'verify' }, purpose: 'fixed' },
        serviceRefs: [producerService],
        expectedAccount: binding.account,
        request: { kind: 'environment', keys: ['FIXED_TOKEN'] },
        signal: cancellation.signal,
      });
      await materializeStarted;
      cancellation.abort(new Error('packed materialization cancelled'));
      await expect(cancelledMaterialization).rejects.toThrow('packed materialization cancelled');
      expect(observation.abortObserved).toBe(true);
    } finally {
      delete globalThis.__HAPPIER_PACKED_CONNECTED_ACCOUNT_PUBLIC_PRODUCER__;
      await reloadController.shutdown({ timeoutMs: 5_000 });
    }
  });

  it('does not advance a group selection when its registered producer is unavailable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-packed-connected-accounts-'));
    temporaryRoots.push(happyHomeDir);
    const consumerPluginId = 'acme.packed-connected-consumer';
    const missingService = { pluginId: 'acme.missing-connected-producer', localId: 'vault' } as const;
    const purpose = {
      consumer: { pluginId: consumerPluginId, localId: 'verify' },
      purpose: 'group',
    } as const;
    const reloadController = createPluginReloadController({
      happyHomeDir,
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
      }),
    });
    const runtime = createPackedTestConnectedAccountsRuntime({
      happyHomeDir,
      pluginId: consumerPluginId,
      runtimeRegistry: reloadController,
    });
    const signal = new AbortController().signal;

    try {
      await runtime.owner.requestSelection({
        purpose,
        serviceRefs: [missingService],
        assertGenerationCurrent: () => undefined,
        reason: 'Select the unavailable packed group',
        signal,
      });
      await expect(runtime.owner.getBinding({
        purpose,
        serviceRefs: [missingService],
        signal,
      })).resolves.toMatchObject({ account: { accountId: 'alpha' } });

      await expect(runtime.owner.materialize({
        purpose,
        serviceRefs: [missingService],
        request: { kind: 'environment', keys: ['GROUP_TOKEN'] },
        signal,
      })).rejects.toMatchObject({
        code: 'plugin_host_access_resource_not_selected',
      });
      await expect(runtime.owner.getBinding({
        purpose,
        serviceRefs: [missingService],
        signal,
      })).resolves.toMatchObject({ account: { accountId: 'alpha' } });
    } finally {
      await reloadController.shutdown({ timeoutMs: 5_000 });
    }
  });

  it('contracts removed purposes through the real binding owner and does not resurrect them when re-added', async () => {
    expect(ConnectedServiceIdSchema.safeParse(service.localId).success).toBe(false);
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-packed-connected-accounts-'));
    temporaryRoots.push(happyHomeDir);
    const runtime = createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId });
    const signal = new AbortController().signal;

    await runtime.owner.requestSelection({
      purpose,
      serviceRefs: [service],
      assertGenerationCurrent: () => undefined,
      reason: 'Select the fixed account',
      signal,
    });
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [service],
      signal,
    })).resolves.not.toBeNull();

    let removedPublished = false;
    await runtime.reconcileRegistryPublication({
      previous: registryWithFixedPurpose(),
      candidate: emptyRegistry(),
      resolveOptionalAccess: () => [],
      publish: () => {
        removedPublished = true;
      },
    });
    expect(removedPublished).toBe(true);
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [service],
      signal,
    })).resolves.toBeNull();

    await runtime.reconcileRegistryPublication({
      previous: emptyRegistry(),
      candidate: registryWithFixedPurpose(),
      resolveOptionalAccess: () => [],
      publish: () => undefined,
    });
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [service],
      signal,
    })).resolves.toBeNull();
  });
});
