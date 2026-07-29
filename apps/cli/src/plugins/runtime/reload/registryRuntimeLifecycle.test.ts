import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import {
  createPluginRegistryStateStore,
  type PluginRegistryRuntimeCandidate,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import {
  PluginRegistryCommitRecordSchema,
  readPluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import {
  PluginInstallationStateRevisionSchema,
  persistInstallationStateRevision,
  readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import { createPluginRegistryCommitCoordinator } from '@/plugins/store/registry/commitCoordinator';
import { createPluginRegistryTransactionService } from '@/plugins/store/registry/service';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';

import { createPluginReloadController } from './controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from './registryRuntimeLifecycle';
import type { SupervisedPluginActivationAttempt } from '../lifecycle/manager';

vi.mock('@/plugins/projection/registry/resolveBuiltInContributions', () => ({
  resolveBuiltInContributions: () => Object.freeze({
    agents: Object.freeze([]),
        providers: Object.freeze([]),
  }),
}));

async function createExecutableInstallFixture(
  happyHomeDir: string,
  pluginId: string,
  options?: Readonly<{ externalSessionHooks?: boolean; descriptorOnly?: boolean }>,
) {
  const pluginRoot = join(happyHomeDir, `${pluginId}-source`);
  const counterPath = join(happyHomeDir, `${pluginId}-executions.log`);
  const agentId = `${pluginId.replaceAll('.', '-')}-agent`;
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
    schemaVersion: 2,
    id: pluginId,
    version: '1.0.0',
    displayName: pluginId,
    description: 'Install activation fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    entrypoints: options?.descriptorOnly ? {} : { daemon: './daemon.mjs' },
    ...(options?.descriptorOnly ? {} : { activation: { events: [{ kind: 'startup' as const }] } }),
    hostAccess: { required: [], optional: [] },
    contributes: options?.descriptorOnly ? {} : {
      actions: [{
        id: 'identity',
        title: 'Identity',
        scopes: ['global'],
        surfaces: ['cli'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
      }],
      ...(options?.externalSessionHooks ? {
        agents: [{
          id: agentId,
          title: `${pluginId} Agent`,
          capabilities: { surfaces: ['externalSessions'] },
          surfaces: {
            externalSession: {
              sources: [{
                sourceKind: 'fixture',
                schema: {
                  passthrough: false,
                  fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }],
                },
                key: { segments: [{ kind: 'literal', value: 'fixture' }] },
                instances: [{ kind: 'default', constants: {} }],
              }],
            },
          },
        }],
      } : {}),
    },
  })), 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(counterPath)}, 'module\\n');
    export function activate(api) {
      appendFileSync(${JSON.stringify(counterPath)}, 'activate\\n');
      api.actions.register('identity', async (_input, context) => {
        await context.services.storage.local.set('retained-owner', ${JSON.stringify(pluginId)});
        return {
          pluginId: ${JSON.stringify(pluginId)},
          retainedOwner: await context.services.storage.local.get('retained-owner'),
        };
      });
      ${options?.externalSessionHooks ? `
      api.agents.registerExternalSessions(${JSON.stringify(agentId)}, {
        async resolveSource(request) {
          return { ok: true, value: { source: request.source } };
        },
        async listCandidates() {
          return { ok: true, value: { candidates: [], nextCursor: null } };
        },
        async resolveLinkIdentity(request) {
          return {
            ok: true,
            value: {
              remoteSessionId: request.remoteSessionId,
              source: request.source,
              linkData: request.linkData ?? {},
            },
          };
        },
        async resolveLinkedIdentity(request) {
          return {
            ok: true,
            value: {
              remoteSessionId: request.remoteSessionId,
              source: request.source,
              linkData: request.linkData,
            },
          };
        },
        async pageTranscript() {
          return { ok: true, value: { items: [], nextCursor: null } };
        },
        async readAfterTranscript() {
          return { ok: true, value: { outcome: 'already_current' } };
        },
      });
      api.agents.registerExternalSessionHooks(${JSON.stringify(agentId)}, {
        installationVariants: [{
          variantId: 'fixture-variant',
          targets: [{
            targetId: 'settings',
            format: 'hook_event_json_arrays_v1',
            collectionId: 'hooks',
          }],
          events: [{
            eventId: 'session-start',
            targetId: 'settings',
            nativeEventName: 'SessionStart',
            command: {
              kind: 'happier_observation_v1',
              shellDialect: 'posix',
            },
          }],
        }],
        async resolveInstallation(_request, context) {
          await context.services.storage.local.set('retained-hook-owner', ${JSON.stringify(pluginId)});
          const owner = await context.services.storage.local.get('retained-hook-owner');
          return {
            ok: true,
            value: {
              kind: 'supported',
              variantId: 'fixture-variant',
              targets: [{
                targetId: 'settings',
                absolutePath: '/tmp/' + owner + '/settings.json',
              }],
              readiness: { kind: 'ready' },
            },
          };
        },
        async mapHookEvent() {
          if (arguments.length !== 1) throw new Error('mapHookEvent received host context');
          return { ok: true, value: { kind: 'ignored' } };
        },
      });
      ` : ''}
      return async () => appendFileSync(${JSON.stringify(counterPath)}, 'cleanup\\n');
    }
  `, 'utf8');
  const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
  const trust = createPluginTrustRecord({
    pluginId,
    distribution,
    approvedAtMs: 1,
  });
  const catalogRecord = PluginStateFileV1Schema.parse({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [pluginId]: {
        source: {
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'prompt',
          installPolicy: 'link',
          resolvedPath: pluginRoot,
          manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
        },
        compatibility: { status: 'compatible', diagnostics: [] },
        install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
        state: { enabled: true },
      },
    },
  }).plugins[pluginId]!;
  return {
    pluginRoot,
    counterPath,
    agentId,
    input: {
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'manual' as const,
      optionalAccess: Object.freeze([]),
    },
  };
}

async function invokeIdentity(
  registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>,
  pluginId: string,
) {
  return await registry.targetActionInvocations?.invoke({
    pluginId,
    localId: 'identity',
    input: {},
    surface: 'cli',
  });
}

describe('daemon plugin registry runtime lifecycle owner', () => {
  it('keeps a retained Agent hook lease current while a peer plugin is adopted', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-retained-agent-hook-'));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const retained = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.retained.hooks',
      { externalSessionHooks: true },
    );
    const peer = await createExecutableInstallFixture(happyHomeDir, 'acme.retained.peer');
    const resolveRequest = () => ({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 15_000,
      maxSerializedBytes: 65_536,
      installation: {
        installationIdentity: 'installation-1',
        executableIdentity: 'sha256:fixture',
        installedVersion: '1.0.0',
        platform: 'darwin' as const,
        architecture: 'arm64',
      },
    });

    await store.initialize();
    await expect(store.install(retained.input)).resolves.toMatchObject({ status: 'committed' });
    const beforeReload = await reloadController.acquireRuntimeRegistry();
    const oldHooks = beforeReload.registry.agentRuntimesByAgentId
      .get(retained.agentId)?.externalSessionHooks;
    const oldExternalSessions = beforeReload.registry.agentRuntimesByAgentId
      .get(retained.agentId)?.externalSessions;
    if (!oldHooks) throw new Error('Expected retained Agent hook lease');
    if (!oldExternalSessions) throw new Error('Expected retained Agent External Sessions lease');
    const listRequest = () => ({
      source: { kind: 'fixture' as const },
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 15_000,
      maxSerializedBytes: 65_536,
      maxItems: 10,
    });
    await expect(oldExternalSessions.listCandidates(listRequest())).resolves.toMatchObject({
      value: { candidates: [], nextCursor: null },
    });
    await expect(oldHooks.resolveInstallation(resolveRequest())).resolves.toMatchObject({
      value: {
        targets: [{
          absolutePath: '/tmp/acme.retained.hooks/settings.json',
        }],
      },
    });
    await expect(store.install(peer.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(oldHooks.resolveInstallation(resolveRequest()))
      .resolves.toMatchObject({
        value: {
          targets: [{
            absolutePath: '/tmp/acme.retained.hooks/settings.json',
          }],
        },
      });
    await expect(oldExternalSessions.listCandidates(listRequest())).resolves.toMatchObject({
      value: { candidates: [], nextCursor: null },
    });

    const afterReload = await reloadController.acquireRuntimeRegistry();
    try {
      const currentHooks = afterReload.registry.agentRuntimesByAgentId
        .get(retained.agentId)?.externalSessionHooks;
      if (!currentHooks) throw new Error('Expected rebound Agent hook lease');
      await expect(currentHooks.resolveInstallation(resolveRequest())).resolves.toMatchObject({
        value: {
          targets: [{
            absolutePath: '/tmp/acme.retained.hooks/settings.json',
          }],
        },
      });
      await expect(currentHooks.mapHookEvent({
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 500,
        maxSerializedBytes: 65_536,
        installationIdentity: 'installation-1',
        variantId: 'fixture-variant',
        eventId: 'session-start',
        observedAtMs: Date.now(),
        nativePayload: {},
      })).resolves.toMatchObject({
        value: { kind: 'ignored' },
      });
    } finally {
      await afterReload.release();
      await beforeReload.release();
    }

    const retainedLines = (await readFile(retained.counterPath, 'utf8')).trim().split('\n');
    expect(retainedLines.filter((line) => line === 'module')).toHaveLength(1);
    expect(retainedLines.filter((line) => line === 'activate')).toHaveLength(1);
    await reloadController.shutdown();
  });

  it('reuses each prepared activation when different-plugin installs rebase after a global commit conflict', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-concurrent-install-'));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const [first, second] = await Promise.all([
      createExecutableInstallFixture(happyHomeDir, 'acme.concurrent.first'),
      createExecutableInstallFixture(happyHomeDir, 'acme.concurrent.second'),
    ]);
    const actualLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    let initialPreparationCount = 0;
    let releaseInitialPreparations!: () => void;
    const initialPreparationsReady = new Promise<void>((resolve) => {
      releaseInitialPreparations = resolve;
    });
    let firstAdoptionSettled = false;
    let markFirstAdoptionSettled!: () => void;
    const firstAdoption = new Promise<void>((resolve) => {
      markFirstAdoptionSettled = resolve;
    });
    const abortedPluginIds: string[] = [];
    const rebasedPluginIds: string[] = [];
    const wrapPrepared = (
      candidate: PluginRegistryRuntimeCandidate,
      prepared: Awaited<ReturnType<PluginRegistryRuntimeLifecycle['prepare']>>,
    ): Awaited<ReturnType<PluginRegistryRuntimeLifecycle['prepare']>> => ({
      async abort() {
        abortedPluginIds.push(...candidate.changedPluginIds);
        await prepared.abort();
        if (!firstAdoptionSettled) await firstAdoption;
      },
      async adopt(record) {
        try {
          await prepared.adopt(record);
        } finally {
          if (!firstAdoptionSettled) {
            firstAdoptionSettled = true;
            markFirstAdoptionSettled();
          }
        }
      },
      ...(prepared.rebase ? {
        async rebase(nextCandidate) {
          rebasedPluginIds.push(...candidate.changedPluginIds);
          return wrapPrepared(nextCandidate, await prepared.rebase!(nextCandidate));
        },
      } : {}),
    });
    const runtimeLifecycle: PluginRegistryRuntimeLifecycle = {
      async prepare(candidate) {
        const prepared = await actualLifecycle.prepare(candidate);
        initialPreparationCount += 1;
        if (initialPreparationCount <= 2) {
          if (initialPreparationCount === 2) releaseInitialPreparations();
          await initialPreparationsReady;
        }
        return wrapPrepared(candidate, prepared);
      },
    };
    const firstStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const secondStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await firstStore.initialize();

    await expect(Promise.all([
      firstStore.install(first.input),
      secondStore.install(second.input),
    ])).resolves.toEqual([
      expect.objectContaining({ status: 'committed' }),
      expect.objectContaining({ status: 'committed' }),
    ]);

    const executionCounts = await Promise.all([first, second].map(async ({ counterPath }) => {
      const lines = (await readFile(counterPath, 'utf8')).trim().split('\n');
      return {
        modules: lines.filter((line) => line === 'module').length,
        activations: lines.filter((line) => line === 'activate').length,
      };
    }));
    expect(executionCounts).toEqual([
      { modules: 1, activations: 1 },
      { modules: 1, activations: 1 },
    ]);
    expect(abortedPluginIds).toEqual([]);
    expect(rebasedPluginIds).toHaveLength(1);

    const committed = await readPluginRegistryCommitRecord(firstStore.paths);
    expect(Object.keys(committed?.pluginGenerations ?? {}).sort()).toEqual([
      'acme.concurrent.first',
      'acme.concurrent.second',
    ]);
    const lease = await reloadController.acquireRuntimeRegistry();
    try {
      for (const pluginId of ['acme.concurrent.first', 'acme.concurrent.second']) {
        await expect(lease.registry.targetActionInvocations?.invoke({
          pluginId,
          localId: 'identity',
          input: {},
          surface: 'cli',
        })).resolves.toEqual({
          status: 'executed',
          value: { pluginId, retainedOwner: pluginId },
        });
      }
    } finally {
      await lease.release();
    }
    await reloadController.shutdown();
    for (const { counterPath } of [first, second]) {
      const lines = (await readFile(counterPath, 'utf8')).trim().split('\n');
      expect(lines.filter((line) => line === 'cleanup')).toHaveLength(1);
    }
  });

  it('composes a committed peer prepared activation when a newer plugin publishes first', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-out-of-order-adopt-'));
    let releaseFirstPublication!: () => void;
    const firstPublicationReleased = new Promise<void>((resolve) => {
      releaseFirstPublication = resolve;
    });
    let releaseSecondPublication!: () => void;
    const secondPublicationReleased = new Promise<void>((resolve) => {
      releaseSecondPublication = resolve;
    });
    let markFirstPublicationEntered!: () => void;
    const firstPublicationEntered = new Promise<void>((resolve) => {
      markFirstPublicationEntered = resolve;
    });
    let markSecondPublicationEntered!: () => void;
    const secondPublicationEntered = new Promise<void>((resolve) => {
      markSecondPublicationEntered = resolve;
    });
    const firstPluginId = 'acme.out-of-order.first';
    const secondPluginId = 'acme.out-of-order.second';
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      beforePublish: async (registry, publish) => {
        const actionPluginIds = new Set(
          registry.contributes.actions.flatMap((action) => (
            action.pluginId ? [action.pluginId] : []
          )),
        );
        if (actionPluginIds.has(secondPluginId)) {
          markSecondPublicationEntered();
          await secondPublicationReleased;
        } else {
          markFirstPublicationEntered();
          await firstPublicationReleased;
        }
        publish();
      },
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const [first, second] = await Promise.all([
      createExecutableInstallFixture(happyHomeDir, firstPluginId),
      createExecutableInstallFixture(happyHomeDir, secondPluginId),
    ]);
    await store.initialize();

    const firstInstall = store.install(first.input);
    await firstPublicationEntered;
    const secondInstall = store.install(second.input);
    await secondPublicationEntered;

    releaseSecondPublication();
    await expect(secondInstall).resolves.toMatchObject({
      status: 'committed',
      applied: true,
    });
    releaseFirstPublication();
    await expect(firstInstall).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'adoption',
    });

    const lease = await reloadController.acquireRuntimeRegistry();
    try {
      for (const pluginId of [firstPluginId, secondPluginId]) {
        await expect(lease.registry.targetActionInvocations?.invoke({
          pluginId,
          localId: 'identity',
          input: {},
          surface: 'cli',
        })).resolves.toEqual({
          status: 'executed',
          value: { pluginId, retainedOwner: pluginId },
        });
      }
    } finally {
      await lease.release();
    }
    for (const fixture of [first, second]) {
      const lines = (await readFile(fixture.counterPath, 'utf8')).trim().split('\n');
      expect(lines.filter((line) => line === 'module')).toHaveLength(1);
      expect(lines.filter((line) => line === 'activate')).toHaveLength(1);
    }

    await reloadController.shutdown();
    for (const fixture of [first, second]) {
      const lines = (await readFile(fixture.counterPath, 'utf8')).trim().split('\n');
      expect(lines.filter((line) => line === 'cleanup')).toHaveLength(1);
    }
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('releases retained committed peer custody when later candidate construction fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-peer-prepare-failure-'));
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let markPublicationEntered!: () => void;
    const publicationEntered = new Promise<void>((resolve) => {
      markPublicationEntered = resolve;
    });
    const failure = new Error('candidate contribution projection failed');
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      beforePublish: async (_registry, publish) => {
        markPublicationEntered();
        await publicationReleased;
        publish();
      },
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const retained = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.peer-prepare-failure.retained',
    );
    await store.initialize();

    const retainedInstall = store.install(retained.input);
    await publicationEntered;
    const committed = await readPluginRegistryCommitRecord(store.paths);
    if (!committed) throw new Error('Expected retained fixture commit');
    const installationState = await readInstallationStateRevision({
      paths: store.paths,
      reference: committed.installationState,
    });
    const runtimeCatalog = installationState.runtimeCatalog;
    if (!runtimeCatalog) throw new Error('Expected retained fixture runtime catalog');
    const failingRuntimeCatalog = {
      ...runtimeCatalog,
      plugins: new Proxy(runtimeCatalog.plugins, {
        ownKeys() {
          throw failure;
        },
      }),
    };

    await expect(runtimeLifecycle.prepare({
      mutationKind: 'install',
      changedPluginIds: Object.freeze(['acme.peer-prepare-failure.later']),
      runtimeCatalog: failingRuntimeCatalog,
      installationState,
      pluginGenerations: committed.pluginGenerations,
    })).rejects.toBe(failure);

    await reloadController.shutdown({ timeoutMs: 50 });
    releasePublication();
    await expect(retainedInstall).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'adoption',
    });
    const lines = (await readFile(retained.counterPath, 'utf8')).trim().split('\n');
    expect(lines.filter((line) => line === 'module')).toHaveLength(1);
    expect(lines.filter((line) => line === 'activate')).toHaveLength(1);
    expect(lines.filter((line) => line === 'cleanup')).toHaveLength(1);
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('keeps unchanged plugin activation and services live across sequential install and peer disable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-sequential-install-'));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const first = await createExecutableInstallFixture(happyHomeDir, 'acme.sequential.first');
    const second = await createExecutableInstallFixture(happyHomeDir, 'acme.sequential.second');
    await store.initialize();

    await expect(store.install(first.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(store.install(second.input)).resolves.toMatchObject({ status: 'committed' });
    for (const { counterPath } of [first, second]) {
      const lines = (await readFile(counterPath, 'utf8')).trim().split('\n');
      expect(lines.filter((line) => line === 'module')).toHaveLength(1);
      expect(lines.filter((line) => line === 'activate')).toHaveLength(1);
    }
    const predecessorLease = await reloadController.acquireRuntimeRegistry();
    await expect(predecessorLease.registry.targetActionInvocations?.invoke({
      pluginId: 'acme.sequential.second',
      localId: 'identity',
      input: {},
      surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed' });

    await writeFile(join(first.pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.sequential.first',
      version: '2.0.0',
      displayName: 'acme.sequential.first',
      description: 'Updated install activation fixture',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      activation: { events: [{ kind: 'startup' }] },
      hostAccess: { required: [], optional: [] },
      contributes: {
        actions: [{
          id: 'identity',
          title: 'Identity',
          scopes: ['global'],
          surfaces: ['cli'],
          placement: 'commandPalette',
          dangerLevel: 'safe',
        }],
      },
    })), 'utf8');
    const updatedCatalogRecord = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.sequential.first': {
          ...first.input.catalogRecord,
          install: {
            ...first.input.catalogRecord.install,
            manifestVersion: '2.0.0',
          },
        },
      },
    }).plugins['acme.sequential.first']!;
    await expect(store.install({
      ...first.input,
      catalogRecord: updatedCatalogRecord,
    })).resolves.toMatchObject({ status: 'committed' });
    const firstAfterUpdate = (await readFile(first.counterPath, 'utf8')).trim().split('\n');
    expect(firstAfterUpdate.filter((line) => line === 'module')).toHaveLength(2);
    expect(firstAfterUpdate.filter((line) => line === 'activate')).toHaveLength(2);
    const secondAfterPeerUpdate = (await readFile(second.counterPath, 'utf8')).trim().split('\n');
    expect(secondAfterPeerUpdate.filter((line) => line === 'module')).toHaveLength(1);
    expect(secondAfterPeerUpdate.filter((line) => line === 'activate')).toHaveLength(1);
    await expect(predecessorLease.registry.targetActionInvocations?.invoke({
      pluginId: 'acme.sequential.second',
      localId: 'identity',
      input: {},
      surface: 'cli',
    })).resolves.toEqual({
      status: 'executed',
      value: {
        pluginId: 'acme.sequential.second',
        retainedOwner: 'acme.sequential.second',
      },
    });
    await expect(predecessorLease.registry.targetActionInvocations?.invoke({
      pluginId: 'acme.sequential.first',
      localId: 'identity',
      input: {},
      surface: 'cli',
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_generation_retired',
    });
    await predecessorLease.release();

    await expect(store.setEnabledWithResult('acme.sequential.first', false)).resolves.toMatchObject({
      transaction: { status: 'committed' },
    });
    const lease = await reloadController.acquireRuntimeRegistry();
    try {
      await expect(lease.registry.targetActionInvocations?.invoke({
        pluginId: 'acme.sequential.second',
        localId: 'identity',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({
        status: 'executed',
        value: {
          pluginId: 'acme.sequential.second',
          retainedOwner: 'acme.sequential.second',
        },
      });
    } finally {
      await lease.release();
    }
    const secondLines = (await readFile(second.counterPath, 'utf8')).trim().split('\n');
    expect(secondLines.filter((line) => line === 'module')).toHaveLength(1);
    expect(secondLines.filter((line) => line === 'activate')).toHaveLength(1);
    await expect(store.uninstallWithResult('acme.sequential.first')).resolves.toMatchObject({
      transaction: { status: 'committed' },
    });
    const secondAfterPeerUninstall = (await readFile(second.counterPath, 'utf8')).trim().split('\n');
    expect(secondAfterPeerUninstall.filter((line) => line === 'module')).toHaveLength(1);
    expect(secondAfterPeerUninstall.filter((line) => line === 'activate')).toHaveLength(1);

    await reloadController.shutdown();
    const firstFinalLines = (await readFile(first.counterPath, 'utf8')).trim().split('\n');
    expect(firstFinalLines.filter((line) => line === 'cleanup')).toHaveLength(2);
    const secondFinalLines = (await readFile(second.counterPath, 'utf8')).trim().split('\n');
    expect(secondFinalLines.filter((line) => line === 'cleanup')).toHaveLength(1);
  });

  it('fences only the changed plugin after commit while pre-publication work is blocked', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-post-commit-fence-'));
    let blockNextPublication = false;
    let markPublicationEntered!: () => void;
    const publicationEntered = new Promise<void>((resolve) => {
      markPublicationEntered = resolve;
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      beforePublish: async (_registry, publish) => {
        if (blockNextPublication) {
          markPublicationEntered();
          await publicationReleased;
        }
        publish();
      },
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const changed = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.post-commit.changed',
    );
    const unrelated = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.post-commit.unrelated',
    );
    await store.initialize();
    await expect(store.install(changed.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(store.install(unrelated.input)).resolves.toMatchObject({ status: 'committed' });
    const predecessorLease = await reloadController.acquireRuntimeRegistry();

    blockNextPublication = true;
    const mutation = store.setEnabledWithResult(changed.input.pluginId, false);
    await publicationEntered;
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 3,
    });

    const lease = reloadController.tryAcquireRuntimeRegistry?.();
    expect(lease).not.toBeNull();
    expect(lease!.registry).toBe(predecessorLease.registry);
    await expect(invokeIdentity(predecessorLease.registry, changed.input.pluginId)).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_generation_retired',
    });
    await expect(invokeIdentity(lease!.registry, unrelated.input.pluginId)).resolves.toEqual({
      status: 'executed',
      value: {
        pluginId: unrelated.input.pluginId,
        retainedOwner: unrelated.input.pluginId,
      },
    });

    releasePublication();
    await expect(mutation).resolves.toMatchObject({
      transaction: { status: 'committed', applied: true },
    });
    await lease!.release();
    await predecessorLease.release();
    await reloadController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('keeps the changed predecessor stale when post-commit pre-publication work fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-post-commit-failure-'));
    let failNextPublication = false;
    const failure = new Error('post-commit projection failed');
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      beforePublish: async (_registry, publish) => {
        if (failNextPublication) throw failure;
        publish();
      },
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const changed = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.post-commit-failure.changed',
    );
    const unrelated = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.post-commit-failure.unrelated',
    );
    await store.initialize();
    await expect(store.install(changed.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(store.install(unrelated.input)).resolves.toMatchObject({ status: 'committed' });

    failNextPublication = true;
    await expect(store.setEnabledWithResult(changed.input.pluginId, false)).resolves.toMatchObject({
      transaction: {
        status: 'outcomeUnknown',
        phase: 'adoption',
        message: failure.message,
      },
    });

    const lease = reloadController.tryAcquireRuntimeRegistry?.();
    expect(lease).not.toBeNull();
    await expect(invokeIdentity(lease!.registry, changed.input.pluginId)).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_generation_retired',
    });
    await expect(invokeIdentity(lease!.registry, unrelated.input.pluginId)).resolves.toEqual({
      status: 'executed',
      value: {
        pluginId: unrelated.input.pluginId,
        retainedOwner: unrelated.input.pluginId,
      },
    });
    await lease!.release();
    await reloadController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('keeps only the changed predecessor fenced while committed durability is pending', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-durability-fence-'));
    let blockNextPublication = false;
    let markPublicationEntered!: () => void;
    const publicationEntered = new Promise<void>((resolve) => {
      markPublicationEntered = resolve;
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      beforePublish: async (_registry, publish) => {
        if (blockNextPublication) {
          markPublicationEntered();
          await publicationReleased;
        }
        publish();
      },
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const changed = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.durability-pending.changed',
    );
    const unrelated = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.durability-pending.unrelated',
    );
    await store.initialize();
    await expect(store.install(changed.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(store.install(unrelated.input)).resolves.toMatchObject({ status: 'committed' });

    const current = await readPluginRegistryCommitRecord(store.paths);
    if (!current) throw new Error('Expected current plugin registry commit');
    const currentState = await readInstallationStateRevision({
      paths: store.paths,
      reference: current.installationState,
    });
    const currentCatalog = currentState.runtimeCatalog;
    if (!currentCatalog) throw new Error('Expected current runtime catalog');
    const runtimeCatalog = PluginStateFileV1Schema.parse({
      ...currentCatalog,
      plugins: {
        ...currentCatalog.plugins,
        [changed.input.pluginId]: {
          ...currentCatalog.plugins[changed.input.pluginId],
          state: { enabled: false },
        },
      },
    });
    const installationState = PluginInstallationStateRevisionSchema.parse({
      ...currentState,
      revisionId: 'state-durability-pending-fence',
      createdAtMs: currentState.createdAtMs + 1,
      plugins: {
        ...currentState.plugins,
        [changed.input.pluginId]: {
          ...currentState.plugins[changed.input.pluginId],
          enabled: false,
        },
      },
      runtimeCatalog,
    });
    const installationStateReference = await persistInstallationStateRevision({
      paths: store.paths,
      state: installationState,
    });
    const coordinator = createPluginRegistryCommitCoordinator({
      paths: store.paths,
      owner: { pid: process.pid, instanceId: 'durability-pending-fence' },
      flushCommit: async () => {
        throw new Error('fsync failed after replace');
      },
    });
    const transactionService = createPluginRegistryTransactionService({ coordinator });
    blockNextPublication = true;
    const execution = transactionService.execute({
      transactionId: 'durability-pending-fence',
      baseRevision: current.revision,
      prepare: async () => undefined,
      validateAndActivate: async () => await runtimeLifecycle.prepare({
        mutationKind: 'state',
        changedPluginIds: Object.freeze([changed.input.pluginId]),
        runtimeCatalog,
        installationState,
        pluginGenerations: current.pluginGenerations,
      }),
      persist: async () => PluginRegistryCommitRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        transactionId: 'durability-pending-fence',
        baseRevision: current.revision,
        installationState: installationStateReference,
        createdAtMs: current.createdAtMs + 1,
        creator: { pid: process.pid, instanceId: 'durability-pending-fence' },
      }),
      abortPrepared: async (_prepared, runtime) => await runtime?.abort(),
      adopt: async (record, runtime) => await runtime.adopt(record),
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    });
    await publicationEntered;

    const lease = reloadController.tryAcquireRuntimeRegistry?.();
    expect(lease).not.toBeNull();
    await expect(invokeIdentity(lease!.registry, changed.input.pluginId)).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_generation_retired',
    });
    await expect(invokeIdentity(lease!.registry, unrelated.input.pluginId)).resolves.toEqual({
      status: 'executed',
      value: {
        pluginId: unrelated.input.pluginId,
        retainedOwner: unrelated.input.pluginId,
      },
    });

    releasePublication();
    await expect(execution).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'durability',
      record: { revision: current.revision + 1 },
      message: 'fsync failed after replace',
    });
    await lease!.release();
    await reloadController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('reports disabled executable and descriptor-only generations as desired but not applied', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-disabled-currentness-'));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const executable = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.disabled.executable',
    );
    const descriptorOnly = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.disabled.descriptor',
      { descriptorOnly: true },
    );
    await store.initialize();
    await expect(store.install(executable.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(store.install(descriptorOnly.input)).resolves.toMatchObject({ status: 'committed' });

    for (const pluginId of ['acme.disabled.executable', 'acme.disabled.descriptor']) {
      await expect(store.setEnabledWithResult(pluginId, false)).resolves.toMatchObject({
        transaction: { status: 'committed' },
      });
      const lease = await reloadController.acquireRuntimeRegistry();
      try {
        const catalog = joinInstalledCatalogRuntimeIntrospection(
          await readInstalledPluginCatalog({ happyHomeDir }),
          lease.registry,
        );
        expect(catalog).toContainEqual(expect.objectContaining({
          pluginId,
          enabled: false,
          desiredGeneration: expect.any(String),
          appliedGeneration: null,
        }));
        expect(lease.registry.targetActionInvocations?.has(pluginId, 'identity')).toBe(false);
      } finally {
        await lease.release();
      }
    }

    await reloadController.shutdown();
  });

  it('disposes a prepared registry when the serving revision fence rejects adoption', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-stale-adopt-'));
    const runtimeCatalog = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {},
    });
    const installationState = PluginInstallationStateRevisionSchema.parse({
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'state-stale-adopt',
      createdAtMs: 1,
      plugins: {},
      health: {},
      rollbackRetention: [],
      healthTombstones: [],
      runtimeCatalog,
      retainedRuntimeCatalog: {},
    });
    const candidate: PluginRegistryRuntimeCandidate = {
      mutationKind: 'state',
      changedPluginIds: Object.freeze([]),
      runtimeCatalog,
      installationState,
      pluginGenerations: {},
    };
    const controller = createPluginReloadController();
    const beforePublish = vi.fn(async () => {});
    let disposePreparedRegistryCallCount = 0;
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      beforePublish,
      reloadController: {
        ...controller,
        adoptPreparedRuntimeRegistry: async (adoption) => {
          const disposePreparedRegistry = adoption.registry.dispose.bind(adoption.registry);
          vi.spyOn(adoption.registry, 'dispose').mockImplementation(async (params) => {
            disposePreparedRegistryCallCount += 1;
            await disposePreparedRegistry(params);
          });
          await adoption.beforePublish?.(adoption.registry, () => undefined);
          throw new Error('Prepared plugin runtime registry durable revision is stale');
        },
      },
    });
    const prepared = await lifecycle.prepare(candidate);
    const record = PluginRegistryCommitRecordSchema.parse({
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision: 1,
      transactionId: 'stale-adopt',
      baseRevision: 0,
      installationState: {
        revisionId: installationState.revisionId,
        digest: `sha256:${'1'.repeat(64)}`,
      },
      pluginGenerations: {},
      createdAtMs: 1,
      creator: { pid: process.pid, instanceId: 'stale-adopt-test' },
    });

    await expect(prepared.adopt(record)).rejects.toThrow(/durable revision is stale/i);
    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(disposePreparedRegistryCallCount).toBe(1);
    expect(controller.getState().activeRegistry).toBeNull();
  });

  it('publishes a successful prepared activation attempt only after durable adoption', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-health-adopt-'));
    const pluginRoot = join(happyHomeDir, 'plugin-source');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'src'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.health.adopted',
      version: '1.0.0',
      displayName: 'Health adoption fixture',
      description: 'Publishes health only after adoption',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
      activation: { events: [{ kind: 'startup' }] },
      hostAccess: { required: [], optional: [] },
      contributes: {
        actions: [{
          id: 'roundtrip',
          title: 'Roundtrip',
          scopes: ['global'],
          surfaces: ['cli'],
          placement: 'commandPalette',
          dangerLevel: 'safe',
        }],
      },
    })), 'utf8');
    await writeFile(join(pluginRoot, 'src', 'index.ts'), [
      'export function activate(api): void {',
      "  api.actions.register('roundtrip', async (_input, context) => {",
      "    await context.services.storage.local.set('value', 'adopted');",
      "    return { value: await context.services.storage.local.get('value') };",
      '  });',
      '}',
      '',
    ].join('\n'), 'utf8');
    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({
      pluginId: 'acme.health.adopted',
      distribution,
      approvedAtMs: 1,
    });
    const record = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.health.adopted': {
          source: {
            kind: 'path', locator: pluginRoot, trustPolicy: 'prompt', installPolicy: 'link', devWatch: true,
            resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins['acme.health.adopted']!;
    const attempts: SupervisedPluginActivationAttempt[] = [];
    const reloadController = createPluginReloadController({ happyHomeDir });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController,
        onActivationAttempt: async (attempt) => { attempts.push(attempt); },
      }),
    });

    await store.install({
      pluginId: 'acme.health.adopted',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const committed = await readPluginRegistryCommitRecord(store.paths);
    expect(attempts).toEqual([expect.objectContaining({
      pluginId: 'acme.health.adopted',
      immutableGenerationId: committed?.pluginGenerations['acme.health.adopted']?.immutableGenerationId,
      phase: 'primaryBootstrap',
      outcome: 'nonfatal',
    })]);
    const lease = await reloadController.acquireRuntimeRegistry();
    try {
      await expect(lease.registry.targetActionInvocations?.invoke({
        pluginId: 'acme.health.adopted',
        localId: 'roundtrip',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({ status: 'executed', value: { value: 'adopted' } });
    } finally {
      await lease.release();
    }
    await reloadController.shutdown();
  });

  it('executes candidate module and activation once and leaves it unpublished when registration validation fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-prepare-reject-'));
    const pluginRoot = join(happyHomeDir, 'plugin-source');
    const counterPath = join(happyHomeDir, 'executions.log');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
      schemaVersion: 2,
      id: 'acme.prepare.reject',
      version: '1.0.0',
      displayName: 'Prepare rejection fixture',
      description: 'Fails complete registration validation',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        actions: [{
          id: 'required-action',
          title: 'Required action',
          scopes: ['global'],
          surfaces: ['cli'],
          placement: 'primary',
          dangerLevel: 'safe',
        }],
      },
    })), 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(counterPath)}, 'module\\n');
      export function activate() {
        appendFileSync(${JSON.stringify(counterPath)}, 'activate\\n');
      }
    `, 'utf8');

    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({
      pluginId: 'acme.prepare.reject',
      distribution,
      approvedAtMs: 1,
    });
    const record = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.prepare.reject': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins['acme.prepare.reject']!;
    const reloadController = createPluginReloadController({
      happyHomeDir,
      resolveRuntimeRegistry: async () => {
        throw new Error('prepared lifecycle must not resolve the committed registry again');
      },
    });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController,
      }),
    });

    await expect(store.install({
      pluginId: 'acme.prepare.reject',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    })).rejects.toThrow(/missing registration/i);

    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 0,
      pluginGenerations: {},
    });
    await expect(readFile(counterPath, 'utf8')).resolves.toBe('module\nactivate\n');
    expect(reloadController.getState().activeRegistry).toBeNull();
  });

  it('isolates corrupt committed bytes to their plugin while a healthy peer keeps serving', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-corrupt-isolation-'));
    const corrupt = await createExecutableInstallFixture(happyHomeDir, 'acme.corrupt.current');
    const healthy = await createExecutableInstallFixture(happyHomeDir, 'acme.healthy.peer');
    const changeService = createDaemonPluginChangeService({
      prepare: async () => {
        throw new Error('User change preparation is outside this recovery fixture');
      },
    });
    const recoveryErrors: unknown[] = [];
    const createDaemonIncarnation = (incarnation: string, observeAttempts = true) => {
      const reloadController = createPluginReloadController({ happyHomeDir });
      let stateStore!: ReturnType<typeof createPluginRegistryStateStore>;
      const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController,
        ...(observeAttempts ? {
          onActivationAttempt: async (attempt) => await stateStore.observeActivationAttempt(attempt),
        } : {}),
      });
      stateStore = createPluginRegistryStateStore({
        happyHomeDir,
        runtimeLifecycle,
        runAutomaticCurrentnessChange: async (pluginId, change) => {
          try {
            await changeService.runAutomaticCurrentnessChange(pluginId, change);
          } catch (error) {
            recoveryErrors.push(error);
            throw error;
          }
        },
        healthSupervisor: {
          daemonInstanceId: incarnation,
          daemonUptimeMs: () => 0,
          schedule: () => undefined,
        },
      });
      return { reloadController, stateStore };
    };
    const readState = async (store: ReturnType<typeof createPluginRegistryStateStore>) => {
      const commit = await readPluginRegistryCommitRecord(store.paths);
      if (!commit) throw new Error('Expected a committed plugin registry');
      const revision = await readInstallationStateRevision({
        paths: store.paths,
        reference: commit.installationState,
      });
      return { commit, revision };
    };

    const initial = createDaemonIncarnation('daemon-initial', false);
    await initial.stateStore.initialize();
    await expect(initial.stateStore.install(corrupt.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(initial.stateStore.install(healthy.input)).resolves.toMatchObject({ status: 'committed' });
    const corruptGenerationId = (await readPluginRegistryCommitRecord(initial.stateStore.paths))
      ?.pluginGenerations['acme.corrupt.current']?.immutableGenerationId;
    if (!corruptGenerationId) throw new Error('Expected corrupt fixture generation');
    await initial.reloadController.shutdown();
    await rm(join(initial.stateStore.paths.generationsDir, corruptGenerationId), { recursive: true });

    for (let failureCount = 1; failureCount <= 3; failureCount += 1) {
      const daemon = createDaemonIncarnation(`daemon-restart-${failureCount}`);
      await expect(daemon.stateStore.initialize()).resolves.toMatchObject({
        plugins: {
          'acme.corrupt.current': expect.any(Object),
          'acme.healthy.peer': expect.any(Object),
        },
      });
      const lease = await daemon.reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir,
          generation: daemon.reloadController.getState().generation + 1,
          onActivationAttempt: daemon.stateStore.observeActivationAttempt,
        }),
      });
      try {
        await expect(lease.registry.targetActionInvocations?.invoke({
          pluginId: 'acme.healthy.peer',
          localId: 'identity',
          input: {},
          surface: 'cli',
        })).resolves.toEqual({
          status: 'executed',
          value: {
            pluginId: 'acme.healthy.peer',
            retainedOwner: 'acme.healthy.peer',
          },
        });
        expect(lease.registry.pluginDiagnosticsByPluginId['acme.corrupt.current'])
          .toContainEqual(expect.objectContaining({
            code: 'plugin_daemon_module_load_failed',
            message: expect.stringContaining(corruptGenerationId),
          }));
      } finally {
        await lease.release();
      }
      await vi.waitFor(async () => {
        if (recoveryErrors.length > 0) throw recoveryErrors[0];
        const state = await readState(daemon.stateStore);
        if (failureCount < 3) {
          expect(state.revision.health[corruptGenerationId]?.eligibleFailures)
            .toHaveLength(failureCount);
        } else {
          expect(state.commit.pluginGenerations).not.toHaveProperty('acme.corrupt.current');
          expect(state.revision.runtimeCatalog?.plugins['acme.corrupt.current']?.state.enabled)
            .toBe(false);
          expect(state.revision.health[corruptGenerationId]).toMatchObject({
            state: 'quarantined',
          });
        }
      }, { timeout: 10_000 });
      await daemon.reloadController.shutdown();
    }
    await changeService.shutdown();
  }, 60_000);

  it('recovers a serving LKG after repeated committed cold-start failures and keeps explicit rollback user-owned', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-cold-recovery-'));
    const pluginId = 'acme.health.cold-recovery';
    const pluginRoot = join(happyHomeDir, 'plugin-source');
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const failFlagPath = join(happyHomeDir, 'fail-current-activation');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });

    const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
    const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
    const writeVersion = async (version: string): Promise<void> => {
      await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version,
        displayName: 'Cold recovery fixture',
        description: 'Exercises committed bootstrap health recovery',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: { required: [], optional: [] },
        contributes: {
          actions: [{
            id: 'version',
            title: 'Version',
            scopes: ['global'],
            surfaces: ['cli'],
            placement: 'commandPalette',
            dangerLevel: 'safe',
          }],
        },
      })), 'utf8');
      await writeFile(join(pluginRoot, 'daemon.mjs'), `
        import { existsSync } from 'node:fs';
        export function activate(api) {
          if (${JSON.stringify(version)} === '2.0.0' && existsSync(${JSON.stringify(failFlagPath)})) {
            throw new Error(${JSON.stringify(`fixture ${version} committed bootstrap failure`)});
          }
          api.actions.register('version', async () => ({ version: ${JSON.stringify(version)} }));
        }
      `, 'utf8');
    };
    const catalogRecord = (version: string) => PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'prompt',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: version, trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[pluginId]!;
    let storePaths!: ReturnType<typeof createPluginRegistryStateStore>['paths'];
    const readState = async () => {
      const commit = await readPluginRegistryCommitRecord(storePaths);
      if (!commit) throw new Error('Expected a committed plugin registry');
      const revision = await readInstallationStateRevision({
        paths: storePaths,
        reference: commit.installationState,
      });
      return { commit, revision };
    };

    const changeService = createDaemonPluginChangeService({
      prepare: async () => {
        throw new Error('User change preparation is outside this recovery fixture');
      },
    });
    const recoveryErrors: unknown[] = [];
    let daemonUptimeMs = 0;
    const scheduled: Array<() => Promise<void>> = [];
    const createDaemonIncarnation = (incarnation: string) => {
      const reloadController = createPluginReloadController({ happyHomeDir });
      let stateStore!: ReturnType<typeof createPluginRegistryStateStore>;
      const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController,
        onActivationAttempt: async (attempt) => await stateStore.observeActivationAttempt(attempt),
      });
      stateStore = createPluginRegistryStateStore({
        happyHomeDir,
        runtimeLifecycle,
        runAutomaticCurrentnessChange: async (pluginId, change) => {
          try {
            await changeService.runAutomaticCurrentnessChange(pluginId, change);
          } catch (error) {
            recoveryErrors.push(error);
            throw error;
          }
        },
        healthSupervisor: {
          daemonInstanceId: incarnation,
          daemonUptimeMs: () => daemonUptimeMs,
          schedule: (_delayMs, task) => { scheduled.push(task); },
        },
      });
      return { reloadController, runtimeLifecycle, stateStore };
    };

    await writeVersion('1.0.0');
    const initial = createDaemonIncarnation('daemon-initial');
    storePaths = initial.stateStore.paths;
    await initial.stateStore.install({
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: catalogRecord('1.0.0'),
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const firstGenerationId = (await readPluginRegistryCommitRecord(initial.stateStore.paths))
      ?.pluginGenerations[pluginId]?.immutableGenerationId;
    if (!firstGenerationId) throw new Error('Expected the initial generation');
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    daemonUptimeMs = 10 * 60_000;
    await scheduled.shift()?.();

    await writeVersion('2.0.0');
    await initial.stateStore.install({
      pluginId,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: catalogRecord('2.0.0'),
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const secondGenerationId = (await readPluginRegistryCommitRecord(initial.stateStore.paths))
      ?.pluginGenerations[pluginId]?.immutableGenerationId;
    if (!secondGenerationId) throw new Error('Expected the candidate generation');
    expect(secondGenerationId).not.toBe(firstGenerationId);
    await vi.waitFor(async () => {
      const state = await readState();
      expect(state.revision.health[secondGenerationId]?.observation).toMatchObject({
        daemonInstanceId: 'daemon-initial',
      });
    });
    await initial.reloadController.shutdown();
    await writeFile(failFlagPath, 'fail\n', 'utf8');

    let servingIncarnation: ReturnType<typeof createDaemonIncarnation> | null = null;
    for (let failureCount = 1; failureCount <= 3; failureCount += 1) {
      const daemon = createDaemonIncarnation(`daemon-restart-${failureCount}`);
      await daemon.stateStore.initialize();
      const coldLease = await daemon.reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir,
          generation: daemon.reloadController.getState().generation + 1,
          onActivationAttempt: daemon.stateStore.observeActivationAttempt,
        }),
      });
      await coldLease.release();
      await vi.waitFor(async () => {
        if (recoveryErrors.length > 0) throw recoveryErrors[0];
        const state = await readState();
        if (failureCount < 3) {
          expect(state.revision.health[secondGenerationId]?.eligibleFailures).toHaveLength(failureCount);
        } else {
          expect(state.commit.pluginGenerations[pluginId]?.immutableGenerationId).toBe(firstGenerationId);
          expect(state.revision.health[secondGenerationId]).toMatchObject({
            state: 'quarantined',
            tryOnce: 'available',
          });
        }
      }, { timeout: 10_000 });
      if (failureCount < 3) {
        await daemon.reloadController.shutdown();
      } else {
        servingIncarnation = daemon;
      }
    }

    if (!servingIncarnation) throw new Error('Expected a serving recovery incarnation');
    await vi.waitFor(async () => {
      const recoveredLease = await servingIncarnation.reloadController.acquireRuntimeRegistry();
      try {
        await expect(recoveredLease.registry.targetActionInvocations?.invoke({
          pluginId,
          localId: 'version',
          input: {},
          surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { version: '1.0.0' } });
      } finally {
        await recoveredLease.release();
      }
    }, { timeout: 10_000 });

    await rm(failFlagPath);
    await servingIncarnation.stateStore.rollback(pluginId);
    expect((await readState()).commit.pluginGenerations[pluginId]?.immutableGenerationId).toBe(secondGenerationId);
    const explicitRollbackLease = await servingIncarnation.reloadController.acquireRuntimeRegistry();
    try {
      await expect(explicitRollbackLease.registry.targetActionInvocations?.invoke({
        pluginId,
        localId: 'version',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({ status: 'executed', value: { version: '2.0.0' } });
    } finally {
      await explicitRollbackLease.release();
    }
    expect((await readState()).revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId,
      state: 'consumed',
    }));

    await servingIncarnation.reloadController.shutdown();
    await changeService.shutdown();
  }, 90_000);
});
