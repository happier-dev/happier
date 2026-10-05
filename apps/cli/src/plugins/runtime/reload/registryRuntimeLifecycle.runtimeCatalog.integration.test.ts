import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildQualifiedPluginContributionKey, PluginManifestV2Schema } from '@happier-dev/protocol';

import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import {
  createPluginRegistryStateStore,
  type CommitPluginRegistryInstallationInput,
  type PluginRegistryRuntimeCandidate,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import {
  PluginRegistryCommitRecordSchema,
  readPluginRegistryCommitRecord,
  replacePluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import {
  PluginInstallationStateRevisionSchema,
  prepareOwnedImmutablePluginGeneration,
  persistInstallationStateRevision,
  readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createPluginRegistryCommitCoordinator } from '@/plugins/store/registry/commitCoordinator';
import { createPluginRegistryTransactionService } from '@/plugins/store/registry/service';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';
import {
  evaluatePluginDevelopmentCandidate,
  projectEvaluatedPluginDevelopmentSource,
} from '@/plugins/authoring/sourceModule';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';

import { createPluginReloadController } from './controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from './registryRuntimeLifecycle';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } = await import('@happier-dev/cli-common/bundledPluginPublicationPolicy');
  return {
    ...fs,
    // This source-level external-plugin fixture has no failed bundled publication.
    // Substitute only that installed filesystem record; manifest/catalog projection stays real.
    readFileSync: vi.fn((path: Parameters<typeof fs.readFileSync>[0], options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof path === 'string'
        && path.replaceAll('\\', '/').endsWith(`/${BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH}`)
        && options === 'utf8') return '[]';
      return fs.readFileSync(path, options);
    }),
  };
});

type FixtureInstallInput = Omit<CommitPluginRegistryInstallationInput, 'preparedGeneration' | 'approvedAuthorityManifest'> & Readonly<{
  sourceRootPath: string;
  manifestRelativePath: string;
}>;

function createUnusedConnectedAccountsOwner(): StablePluginConnectedAccountsOwner {
  return Object.freeze({
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(async () => {
      throw new Error('unexpected connected-account selection');
    }),
    materialize: vi.fn(async () => {
      throw new Error('unexpected connected-account materialization');
    }),
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch: vi.fn(() => Object.freeze({ dispose() {} })),
  });
}

async function installFixtureCandidate(
  store: ReturnType<typeof createPluginRegistryStateStore>,
  input: FixtureInstallInput,
) {
  const { sourceRootPath, manifestRelativePath, ...installation } = input;
  const preparedGeneration = await prepareOwnedImmutablePluginGeneration({
    paths: store.paths,
    pluginId: input.pluginId,
    sourceRootPath,
    manifestRelativePath,
    distribution: input.trust.distribution,
    updatePolicy: input.updatePolicy,
    createdAtMs: Date.now(),
  });
  try {
    return await store.install({
      ...installation,
      approvedAuthorityManifest: PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
        id: input.pluginId,
        version: input.catalogRecord.install.manifestVersion,
      })),
      preparedGeneration,
    });
  } finally {
    await preparedGeneration.cleanup();
  }
}

async function seedLegacyAvailabilityInstallationState(
  store: ReturnType<typeof createPluginRegistryStateStore>,
  pluginId: string,
): Promise<void> {
  const current = await readPluginRegistryCommitRecord(store.paths);
  if (!current) throw new Error('Expected an installed plugin registry commit');
  const currentState = await readInstallationStateRevision({
    paths: store.paths,
    reference: current.installationState,
  });
  const installation = currentState.plugins[pluginId];
  if (!installation) throw new Error(`Expected installation state for '${pluginId}'`);
  const legacyInstallation = { ...installation };
  delete legacyInstallation.materializationId;
  delete legacyInstallation.availability;
  const createdAtMs = Math.max(Date.now(), current.createdAtMs + 1);
  const legacyState = PluginInstallationStateRevisionSchema.parse({
    ...currentState,
    revisionId: `legacy-availability-${current.revision + 1}`,
    createdAtMs,
    plugins: {
      ...currentState.plugins,
      [pluginId]: legacyInstallation,
    },
  });
  const installationState = await persistInstallationStateRevision({
    paths: store.paths,
    state: legacyState,
  });
  const next = PluginRegistryCommitRecordSchema.parse({
    ...current,
    revision: current.revision + 1,
    transactionId: `legacy-availability-${current.revision + 1}`,
    baseRevision: current.revision,
    installationState,
    createdAtMs,
  });
  await replacePluginRegistryCommitRecord({
    paths: store.paths,
    expectedCurrent: current,
    next,
  });
}

async function seedUnapprovedInstallationState(
  store: ReturnType<typeof createPluginRegistryStateStore>,
  pluginId: string,
): Promise<void> {
  const current = await readPluginRegistryCommitRecord(store.paths);
  if (!current) throw new Error('Expected an installed plugin registry commit');
  const currentState = await readInstallationStateRevision({
    paths: store.paths,
    reference: current.installationState,
  });
  const installation = currentState.plugins[pluginId];
  if (!installation?.trust) throw new Error(`Expected trusted installation for '${pluginId}'`);
  const createdAtMs = Math.max(Date.now(), current.createdAtMs + 1);
  const unapprovedInstallation = { ...installation };
  delete unapprovedInstallation.trust;
  const state = PluginInstallationStateRevisionSchema.parse({
    ...currentState,
    revisionId: `unapproved-${pluginId}-${current.revision + 1}`,
    createdAtMs,
    plugins: {
      ...currentState.plugins,
      [pluginId]: unapprovedInstallation,
    },
  });
  const installationState = await persistInstallationStateRevision({
    paths: store.paths,
    state,
  });
  const next = PluginRegistryCommitRecordSchema.parse({
    ...current,
    revision: current.revision + 1,
    transactionId: `unapproved-${pluginId}-${current.revision + 1}`,
    baseRevision: current.revision,
    installationState,
    createdAtMs,
  });
  await replacePluginRegistryCommitRecord({
    paths: store.paths,
    expectedCurrent: current,
    next,
  });
}

async function createExecutableInstallFixture(
  happyHomeDir: string,
  pluginId: string,
  options?: Readonly<{
    externalSessionHooks?: boolean;
    daemonDatabase?: boolean;
    descriptorOnly?: boolean;
    /** Declares a daemon entry but no startup activation: activated only on demand. */
    lazy?: boolean;
    primaryRuntimeBootstrapFailure?: boolean;
    managedServiceAttach?: boolean;
    startupCrash?: boolean;
  }>,
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
    ...(options?.descriptorOnly || options?.lazy ? {} : { activation: { events: [{ kind: 'startup' as const }] } }),
    hostAccess: { required: [], optional: [] },
    contributes: options?.descriptorOnly ? {} : {
      actions: [{
        id: 'identity',
        title: 'Identity',
        scopes: ['global'],
        surfaces: ['cli'],
        execution: { target: 'daemon' },
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
      }],
      ...(options?.daemonDatabase ? {
        daemonDatabases: [{
          id: 'state',
          migrations: [{ version: 1, id: 'create-state' }],
          incumbentQueryFixtureId: 'state-readable',
        }],
      } : {}),
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
                  fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }],
                },
                key: { segments: [{ kind: 'literal', value: 'fixture' }] },
                instances: [{ kind: 'default', constants: {} }],
              }],
            },
          },
        }],
      } : {}),
      ...(options?.primaryRuntimeBootstrapFailure || options?.managedServiceAttach ? {
        agents: [{
          id: agentId,
          title: `${pluginId} Agent`,
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
      } : {}),
    },
  })), 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `
    import { appendFileSync } from 'node:fs';
    ${options?.primaryRuntimeBootstrapFailure ? `
    import { createBootstrapFailureRuntime } from './agent-runtime.mjs';
    ` : ''}
    ${options?.managedServiceAttach ? `
    import { createAttachRuntime } from './agent-runtime.mjs';
    ` : ''}
    ${options?.startupCrash ? `
    throw new Error('external plugin startup crash');
    ` : ''}
    appendFileSync(${JSON.stringify(counterPath)}, 'module\\n');
    export function activate(api) {
      appendFileSync(${JSON.stringify(counterPath)}, 'activate\\n');
      api.actions.register('identity', async (_input, context) => {
        await context.services.storage.daemon.set('retained-owner', ${JSON.stringify(pluginId)});
        return {
          pluginId: ${JSON.stringify(pluginId)},
          retainedOwner: await context.services.storage.daemon.get('retained-owner'),
        };
      });
      ${options?.managedServiceAttach ? `
      api.agents.register(${JSON.stringify(agentId)}, createAttachRuntime, {
        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createAttachRuntime', runtimeApiVersion: 1 },
        providerCliAttach: {
          resolveTarget() { return { ok: true, value: { baseUrl: 'https://managed.example.test' } }; },
          createArgs() { return []; },
          resolveReachability(target) { return { kind: 'http', url: target.baseUrl + '/health' }; },
          managedServiceAccess: {
            resolveTargetBaseUrl(target) { return target.baseUrl; },
            credentialEnvironmentKey: 'FIXTURE_SERVICE_TOKEN',
          },
        },
      });
      ` : ''}
      ${options?.primaryRuntimeBootstrapFailure ? `
      api.agents.register(${JSON.stringify(agentId)}, createBootstrapFailureRuntime, {
        sessionRunnerFactory: {
          module: './agent-runtime.mjs',
          export: 'createBootstrapFailureRuntime',
          runtimeApiVersion: 1,
        },
      });
      ` : ''}
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
          await context.services.storage.daemon.set('retained-hook-owner', ${JSON.stringify(pluginId)});
          const owner = await context.services.storage.daemon.get('retained-hook-owner');
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
    ${options?.managedServiceAttach ? `export const manifest = ${await readFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), 'utf8')};` : ''}
  `, 'utf8');
  if (options?.managedServiceAttach) {
    await writeFile(join(pluginRoot, 'agent-runtime.mjs'), `
      export async function createAttachRuntime() {
        return { sessions: {
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
          async open() { throw new Error('Attach does not open an Agent Session'); },
        } };
      }
    `, 'utf8');
  }
  if (options?.primaryRuntimeBootstrapFailure) {
    await writeFile(join(pluginRoot, 'agent-runtime.mjs'), `
      import { appendFileSync } from 'node:fs';
      export async function createBootstrapFailureRuntime({ signal }) {
        appendFileSync(${JSON.stringify(counterPath)}, 'bootstrap\\n');
        if (signal.aborted) throw new Error('candidate bootstrap was already aborted');
        signal.addEventListener('abort', () => {
          appendFileSync(${JSON.stringify(counterPath)}, 'bootstrap-aborted\\n');
        }, { once: true });
        throw new Error('candidate primary bootstrap rejected');
      }
    `, 'utf8');
  }
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
        install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'allowed' },
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
      updatePolicy: 'allowed' as const,
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
  it('rejects development preparation when its saved plugin is disabled', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-development-disabled-runtime-'));
    const pluginId = 'acme.development.disabled';
    const fixture = await createExecutableInstallFixture(happyHomeDir, pluginId, { descriptorOnly: true });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
    });
    await installFixtureCandidate(store, fixture.input);
    await store.setEnabled(pluginId, false);
    const sourcePath = join(fixture.pluginRoot, 'plugin.ts');
    await writeFile(sourcePath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, version: '1.0.0' }))};`,
      "export function activate() { throw new Error('disabled plugin was activated'); }",
    ].join('\n'), 'utf8');
    const authority = bindPluginRuntimeSourceAuthority({
      custody: { kind: 'development', registeredRootId: sourcePath },
      resolvedRoot: fixture.pluginRoot,
      observedRevision: 1,
    });
    if (authority.kind !== 'development') throw new Error('Expected development authority');
    const evaluated = await evaluatePluginDevelopmentCandidate({ locator: sourcePath, sourceAuthority: authority });
    const reloadController = createPluginReloadController({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
    });
    (await reloadController.acquireRuntimeRegistry()).release();
    const incumbent = reloadController.getState().activeRegistry;
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController });
    try {
      await expect(lifecycle.prepareDevelopment!({
        pluginId,
        manifest: projectEvaluatedPluginDevelopmentSource(evaluated.evaluated).manifest,
        sourceAuthority: authority,
        preparedActivationGraph: evaluated.graph,
      })).rejects.toThrow(/plugin.*disabled/i);
      expect(reloadController.getState().activeRegistry).toBe(incumbent);
    } finally {
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it.each(['preparation', 'publication'] as const)('does not publish a development candidate disabled during %s', async (phase) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-development-disable-before-adopt-'));
    const pluginId = 'acme.development.disabled';
    const fixture = await createExecutableInstallFixture(happyHomeDir, pluginId, { descriptorOnly: true });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
    });
    await installFixtureCandidate(store, fixture.input);
    const sourcePath = join(fixture.pluginRoot, 'plugin.ts');
    await writeFile(sourcePath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, version: '1.0.0' }))};`,
      'export function activate() {}',
    ].join('\n'), 'utf8');
    const authority = bindPluginRuntimeSourceAuthority({
      custody: { kind: 'development', registeredRootId: sourcePath },
      resolvedRoot: fixture.pluginRoot, observedRevision: 1,
    });
    if (authority.kind !== 'development') throw new Error('Expected development authority');
    const evaluated = await evaluatePluginDevelopmentCandidate({ locator: sourcePath, sourceAuthority: authority });
    const reloadController = createPluginReloadController({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
    });
    (await reloadController.acquireRuntimeRegistry()).release();
    const incumbent = reloadController.getState().activeRegistry;
    let disabledRegistry = incumbent;
    let disableAtPublication = false;
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir, reloadController, resolveDevelopmentSourceAuthority: () => authority,
      beforePublish: async (_registry, publish) => {
        if (disableAtPublication) {
          disableAtPublication = false;
          // Exercise the same durable Disable owner that a daemon mutation uses.
          await createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle: lifecycle }).setEnabled(pluginId, false);
          disabledRegistry = reloadController.getState().activeRegistry;
        }
        publish();
      },
    });
    const prepared = await lifecycle.prepareDevelopment!({
      pluginId, manifest: projectEvaluatedPluginDevelopmentSource(evaluated.evaluated).manifest,
      sourceAuthority: authority, preparedActivationGraph: evaluated.graph,
    });
    try {
      if (phase === 'preparation') await store.setEnabled(pluginId, false);
      else disableAtPublication = true;
      await expect(prepared.adopt()).rejects.toThrow(/plugin.*disabled|superseded/i);
      expect(reloadController.getState().activeRegistry).toBe(disabledRegistry);
    } finally {
      await prepared.abort();
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('retains exact managed-service access for Agent attach after registry replacement', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-reload-managed-access-'));
    const fixture = await createExecutableInstallFixture(happyHomeDir, 'acme.managed.attach', { managedServiceAttach: true });
    const reloadController = createPluginReloadController({
      resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
    });
    (await reloadController.acquireRuntimeRegistry()).release();
    const requests: string[] = [];
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      resolveManagedServiceSessionClientAccess: async (input) => {
        expect(input).toMatchObject({
          pluginId: fixture.input.pluginId, sessionId: 'session-managed',
          contributionId: `${fixture.input.pluginId}/agents/${fixture.agentId}`, targetBaseUrl: 'https://managed.example.test',
          environmentKey: 'FIXTURE_SERVICE_TOKEN',
        });
        return {
          baseUrl: input.targetBaseUrl,
          childEnvironment: {},
          request: async ({ pathAndQuery }) => { requests.push(pathAndQuery); return { ok: true }; },
        };
      },
    });
    try {
      const incumbent = reloadController.getState().activeRegistry;
      const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle: lifecycle });
      await store.initialize();
      await expect(installFixtureCandidate(store, fixture.input)).resolves.toMatchObject({ status: 'committed' });
      expect(reloadController.getState().activeRegistry).not.toBe(incumbent);
      const agent = reloadController.getState().activeRegistry?.contributes.agents
        .find((entry) => entry.pluginId === fixture.input.pluginId);
      const surfaces = await agent?.catalogEntry?.resolveHostAgentRuntimeSurfaces?.();
      await expect(surfaces?.attach?.evaluateAvailability?.({
        operation: 'attach', sessionId: 'session-managed', metadata: {}, depth: 'live', hasLocalAttachmentInfo: true,
      })).resolves.toEqual({ available: true });
      expect(requests).toEqual(['/health']);
    } finally {
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('revalidates a single-file candidate by its registered file identity rather than its load directory', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-development-single-file-currentness-'));
    const sourcePath = join(happyHomeDir, 'plugin.ts');
    await writeFile(sourcePath, [
      'export const manifest = {',
      "  schemaVersion: 2, id: 'acme.development.single-file', version: '1.0.0', displayName: 'single file',",
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    const reloadController = createPluginReloadController({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry(),
    });
    const queriedRoots: string[] = [];
    const authority = bindPluginRuntimeSourceAuthority({
      custody: { kind: 'development', registeredRootId: sourcePath },
      resolvedRoot: happyHomeDir,
      observedRevision: 1,
    });
    if (authority.kind !== 'development') throw new Error('Expected development authority');
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      resolveDevelopmentSourceAuthority: ({ rootPath }) => {
        queriedRoots.push(rootPath);
        return rootPath === sourcePath ? authority : null;
      },
    });
    const evaluated = await evaluatePluginDevelopmentCandidate({ locator: sourcePath, sourceAuthority: authority });
    const prepared = await lifecycle.prepareDevelopment!({
      pluginId: 'acme.development.single-file',
      manifest: projectEvaluatedPluginDevelopmentSource(evaluated.evaluated).manifest,
      sourceAuthority: authority,
      preparedActivationGraph: evaluated.graph,
    });

    await expect(prepared.adopt()).resolves.toBeUndefined();
    expect(queriedRoots).toEqual([sourcePath, sourcePath]);
    await reloadController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('publishes source development candidates, preserves peer occurrences, and keeps the incumbent on activation failure', async () => {
    const slotActivations = (): Record<string, number> => (
      (globalThis as { __ppsSlotActivations?: Record<string, number> }).__ppsSlotActivations ?? {}
    );
    delete (globalThis as { __ppsSlotActivations?: Record<string, number> }).__ppsSlotActivations;
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-development-runtime-'));
    const revisions = new Map<string, number>();
    const reloadController = createPluginReloadController({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry(),
    });
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      resolveDevelopmentSourceAuthority: ({ rootPath }) => {
        const observedRevision = revisions.get(rootPath);
        if (observedRevision === undefined) return null;
        const authority = bindPluginRuntimeSourceAuthority({
          custody: { kind: 'development', registeredRootId: rootPath },
          resolvedRoot: rootPath,
          observedRevision,
        });
        return authority.kind === 'development' ? authority : null;
      },
    });
    const prepare = async (pluginId: string, observedRevision: number, crash = false) => {
      const rootPath = join(happyHomeDir, pluginId);
      await mkdir(rootPath, { recursive: true });
      const entryPath = join(rootPath, 'index.ts');
      await writeFile(entryPath, [
        'export const manifest = {',
        `  schemaVersion: 2, id: '${pluginId}', version: '1.0.0', displayName: '${pluginId}',`,
        "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        crash
          ? "export function activate() { throw new Error('development activation failed'); }"
          : `export function activate() { const counts = (globalThis.__ppsSlotActivations ??= {}); counts['${pluginId}'] = (counts['${pluginId}'] ?? 0) + 1; }`,
        '',
      ].join('\n'), 'utf8');
      const authority = bindPluginRuntimeSourceAuthority({
        custody: { kind: 'development', registeredRootId: rootPath },
        resolvedRoot: rootPath,
        observedRevision,
      });
      if (authority.kind !== 'development') throw new Error('Expected development authority');
      revisions.set(rootPath, observedRevision);
      const evaluated = await evaluatePluginDevelopmentCandidate({ locator: entryPath, sourceAuthority: authority });
      return await lifecycle.prepareDevelopment!({
        pluginId,
        manifest: projectEvaluatedPluginDevelopmentSource(evaluated.evaluated).manifest,
        sourceAuthority: authority,
        preparedActivationGraph: evaluated.graph,
      });
    };

    try {
      const alpha = await prepare('acme.development.alpha', 1);
      await alpha.adopt();
      const alphaBefore = reloadController.readCurrentPluginOccurrenceId?.('acme.development.alpha');
      expect(alphaBefore).toBeTruthy();

      const alphaSlot = reloadController.readPluginSlot?.('acme.development.alpha');
      const alphaServing = alphaSlot?.current;
      expect(alphaServing?.occurrenceId).toBe(alphaBefore);

      const beta = await prepare('acme.development.beta', 1);
      await beta.adopt();
      const betaBefore = reloadController.readCurrentPluginOccurrenceId?.('acme.development.beta');
      expect(betaBefore).toBeTruthy();
      expect(reloadController.readCurrentPluginOccurrenceId?.('acme.development.alpha')).toBe(alphaBefore);
      // Adopting beta swaps only beta's slot: alpha's slot and serving
      // occurrence are the same objects, and alpha was not activated again.
      expect(reloadController.readPluginSlot?.('acme.development.alpha')).toBe(alphaSlot);
      expect(reloadController.readPluginSlot?.('acme.development.alpha')?.current).toBe(alphaServing);
      expect(slotActivations()['acme.development.alpha']).toBe(1);

      const failed = prepare('acme.development.alpha', 2, true);
      await expect(failed).rejects.toThrow('development activation failed');
      expect(reloadController.readCurrentPluginOccurrenceId?.('acme.development.alpha')).toBe(alphaBefore);
      expect(reloadController.readCurrentPluginOccurrenceId?.('acme.development.beta')).toBe(betaBefore);

      const betaSlot = reloadController.readPluginSlot?.('acme.development.beta');
      const alphaEdited = await prepare('acme.development.alpha', 3);
      await alphaEdited.adopt();
      const alphaAfterEdit = reloadController.readCurrentPluginOccurrenceId?.('acme.development.alpha');
      expect(alphaAfterEdit).not.toBe(alphaBefore);
      expect(reloadController.readCurrentPluginOccurrenceId?.('acme.development.beta')).toBe(betaBefore);
      // The edited plugin keeps its one stable slot; only its serving occurrence changed.
      expect(reloadController.readPluginSlot?.('acme.development.alpha')).toBe(alphaSlot);
      expect(reloadController.readPluginSlot?.('acme.development.beta')).toBe(betaSlot);
      expect(slotActivations()).toEqual({
        'acme.development.alpha': 2,
        'acme.development.beta': 1,
      });

      const staleAlpha = await prepare('acme.development.alpha', 4);
      revisions.set(join(happyHomeDir, 'acme.development.alpha'), 5);
      await expect(staleAlpha.adopt()).rejects.toThrow(/superseded before adoption/i);
      expect(reloadController.readCurrentPluginOccurrenceId?.('acme.development.alpha'))
        .toBe(alphaAfterEdit);
    } finally {
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('removes and drains only the current development occurrence while fencing a re-admitted root', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-development-removal-'));
    const pluginId = 'acme.development.removal';
    const rootPath = join(happyHomeDir, pluginId);
    const entryPath = join(rootPath, 'index.ts');
    await mkdir(rootPath, { recursive: true });
    await writeFile(entryPath, [
      'export const manifest = {',
      `  schemaVersion: 2, id: '${pluginId}', version: '1.0.0', displayName: '${pluginId}',`,
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    let registered = true;
    const authority = bindPluginRuntimeSourceAuthority({
      custody: { kind: 'development', registeredRootId: rootPath },
      resolvedRoot: rootPath,
      observedRevision: 1,
    });
    if (authority.kind !== 'development') throw new Error('Expected development authority');
    const reloadController = createPluginReloadController({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry(),
    });
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      resolveDevelopmentSourceAuthority: () => registered ? authority : null,
      isDevelopmentSourceRegistered: (registeredRootId) => (
        registered && registeredRootId === rootPath
      ),
    });

    try {
      const evaluated = await evaluatePluginDevelopmentCandidate({ locator: entryPath, sourceAuthority: authority });
      const candidate = await lifecycle.prepareDevelopment!({
        pluginId,
        manifest: projectEvaluatedPluginDevelopmentSource(evaluated.evaluated).manifest,
        sourceAuthority: authority,
        preparedActivationGraph: evaluated.graph,
      });
      await candidate.adopt();
      const occurrenceId = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
      expect(occurrenceId).toBeTruthy();

      const staleRemoval = await lifecycle.prepareDevelopmentRemoval!({ pluginId, registeredRootId: rootPath });
      expect(staleRemoval).not.toBeNull();
      await expect(staleRemoval!.adopt()).rejects.toThrow(/superseded before adoption/i);
      expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBe(occurrenceId);

      const removal = await lifecycle.prepareDevelopmentRemoval!({ pluginId, registeredRootId: rootPath });
      expect(removal).not.toBeNull();
      registered = false;
      await removal!.adopt();
      expect(reloadController.readPluginSlot?.(pluginId)).toBeNull();
      expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
      expect(reloadController.readCurrentPluginSourceCustody?.(pluginId)).toBeNull();
    } finally {
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('preserves an external installation materialization in the committed runtime registry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-origin-materialization-'));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
      resolveCurrentMachineId: () => 'machine-lifecycle',
      resolveCurrentMachineExecutionOriginContext: async () => ({
        serverIdentityId: 'srv_lifecycle',
        machineId: 'machine-lifecycle',
      }),
    });
    const store = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    const pluginId = 'acme.origin-materialization';
    const fixture = await createExecutableInstallFixture(happyHomeDir, pluginId);

    await store.initialize();
    await expect(installFixtureCandidate(store, fixture.input)).resolves.toMatchObject({ status: 'committed' });
    const snapshot = await store.readSnapshot();
    const materializationId = snapshot.materializationIdsByPluginId[pluginId];
    expect(materializationId).toEqual(expect.any(String));

    const lease = await reloadController.acquireRuntimeRegistry();
    try {
      expect(lease.registry.contributes.materializationIdsByPluginId).toMatchObject({
        [pluginId]: materializationId,
      });
      await expect(lease.registry.activateContributionsOnDemand([{
        pluginId,
        family: 'actions',
        localId: 'identity',
      }])).resolves.toEqual([{
        pluginId,
        diagnostics: [],
      }]);
      expect(lease.registry.activatedPluginIds).toContain(pluginId);
      expect(lease.registry.resolveCurrentPluginMaterializationRef?.(pluginId)).toEqual({
        pluginId,
        machineId: 'machine-lifecycle',
        materializationId,
      });
      await expect(invokeIdentity(lease.registry, pluginId)).resolves.toMatchObject({
        status: 'executed',
      });
      await expect(lease.registry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toEqual({
        serverIdentityId: 'srv_lifecycle',
        materializationRef: {
          pluginId,
          machineId: 'machine-lifecycle',
          materializationId,
        },
      });
    } finally {
      await lease.release();
      await reloadController.shutdown({ timeoutMs: 5_000 });
    }
  });

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
    // Installed (external) plugin Agents are keyed in `agentRuntimesByAgentId`
    // by the qualified `{pluginId}/{localId}` routing id, never the bare
    // manifest local id; registrations inside `activate()` use the local id.
    const retainedAgentRoutingId = buildQualifiedPluginContributionKey({
      pluginId: retained.input.pluginId,
      localId: retained.agentId,
    });
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
    await expect(installFixtureCandidate(store, retained.input)).resolves.toMatchObject({ status: 'committed' });
    const beforeReload = await reloadController.acquireRuntimeRegistry();
    const oldHooks = beforeReload.registry.agentRuntimesByAgentId
      .get(retainedAgentRoutingId)?.externalSessionHooks;
    const oldExternalSessions = beforeReload.registry.agentRuntimesByAgentId
      .get(retainedAgentRoutingId)?.externalSessions;
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
    await expect(installFixtureCandidate(store, peer.input)).resolves.toMatchObject({ status: 'committed' });
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
        .get(retainedAgentRoutingId)?.externalSessionHooks;
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
      installFixtureCandidate(firstStore, first.input),
      installFixtureCandidate(secondStore, second.input),
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
    expect(Object.keys(committed?.pluginOccurrenceIds ?? {}).sort()).toEqual([
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

    const firstInstall = installFixtureCandidate(store, first.input);
    await firstPublicationEntered;
    const secondInstall = installFixtureCandidate(store, second.input);
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

    const retainedInstall = installFixtureCandidate(store, retained.input);
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
      runningSessionDisposition: 'retainRunningSessions',
      changedPluginIds: Object.freeze(['acme.peer-prepare-failure.later']),
      runtimeCatalog: failingRuntimeCatalog,
      installationState,
      pluginOccurrenceIds: committed.pluginOccurrenceIds,
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

    await expect(installFixtureCandidate(store, first.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(store, second.input)).resolves.toMatchObject({ status: 'committed' });
    for (const { counterPath } of [first, second]) {
      const lines = (await readFile(counterPath, 'utf8')).trim().split('\n');
      expect(lines.filter((line) => line === 'module')).toHaveLength(1);
      expect(lines.filter((line) => line === 'activate')).toHaveLength(1);
    }
    const predecessorLease = await reloadController.acquireRuntimeRegistry();
    const firstOccurrenceBefore = reloadController.readCurrentPluginOccurrenceId?.(
      first.input.pluginId,
    );
    const secondOccurrenceBefore = reloadController.readCurrentPluginOccurrenceId?.(
      second.input.pluginId,
    );
    expect(firstOccurrenceBefore).toBeTruthy();
    expect(secondOccurrenceBefore).toBeTruthy();
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
          execution: { target: 'daemon' },
          placementBindings: ['commandPalette'],
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
    await expect(installFixtureCandidate(store, {
      ...first.input,
      catalogRecord: updatedCatalogRecord,
    })).resolves.toMatchObject({ status: 'committed' });
    const firstAfterUpdate = (await readFile(first.counterPath, 'utf8')).trim().split('\n');
    expect(firstAfterUpdate.filter((line) => line === 'module')).toHaveLength(2);
    expect(firstAfterUpdate.filter((line) => line === 'activate')).toHaveLength(2);
    const secondAfterPeerUpdate = (await readFile(second.counterPath, 'utf8')).trim().split('\n');
    expect(secondAfterPeerUpdate.filter((line) => line === 'module')).toHaveLength(1);
    expect(secondAfterPeerUpdate.filter((line) => line === 'activate')).toHaveLength(1);
    const firstOccurrenceAfter = reloadController.readCurrentPluginOccurrenceId?.(
      first.input.pluginId,
    );
    const secondOccurrenceAfter = reloadController.readCurrentPluginOccurrenceId?.(
      second.input.pluginId,
    );
    expect(firstOccurrenceAfter).toBeTruthy();
    expect(firstOccurrenceAfter).not.toBe(firstOccurrenceBefore);
    expect(secondOccurrenceAfter).toBe(secondOccurrenceBefore);
    expect(reloadController.isPluginOccurrenceCurrent?.(
      first.input.pluginId,
      firstOccurrenceBefore!,
    )).toBe(false);
    expect(reloadController.isPluginOccurrenceCurrent?.(
      second.input.pluginId,
      secondOccurrenceBefore!,
    )).toBe(true);
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

  it('keeps a not-yet-activated unchanged plugin in its slot across a peer update', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-lazy-peer-'));
    const lazy = await createExecutableInstallFixture(happyHomeDir, 'acme.lazy-peer.lazy', { lazy: true });
    const changed = await createExecutableInstallFixture(happyHomeDir, 'acme.lazy-peer.changed');
    const installController = createPluginReloadController({ happyHomeDir });
    const installStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: installController }),
    });
    await installStore.initialize();
    await expect(installFixtureCandidate(installStore, lazy.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(installStore, changed.input)).resolves.toMatchObject({ status: 'committed' });
    await installController.shutdown();

    // A daemon restart resolves every plugin cold: the lazy plugin is admitted
    // (it has an occurrence and custody) but not activated.
    const reloadController = createPluginReloadController({ happyHomeDir });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController }),
    });
    try {
      await store.initialize();
      // Production cold start: the runtime owner publishes one full resolve.
      await (await reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir,
          generation: reloadController.getState().generation + 1,
        }),
      })).release();
      const lazySlot = reloadController.readPluginSlot?.(lazy.input.pluginId);
      const lazyServing = lazySlot?.current;
      expect(lazyServing?.occurrenceId).toBeTruthy();
      expect(lazyServing?.sourceCustody).toMatchObject({ kind: 'managed' });
      const activationsBefore = (await readFile(lazy.counterPath, 'utf8')).trim().split('\n')
        .filter((line) => line === 'activate').length;

      await expect(store.setEnabledWithResult(changed.input.pluginId, false)).resolves.toMatchObject({
        transaction: { status: 'committed' },
      });

      // The peer's change rotates only the peer: the lazy plugin keeps its
      // slot, occurrence and custody although it has no activation component,
      // and it still activates on demand.
      expect(reloadController.readPluginSlot?.(lazy.input.pluginId)).toBe(lazySlot);
      expect(reloadController.readPluginSlot?.(lazy.input.pluginId)?.current).toBe(lazyServing);
      expect((await readFile(lazy.counterPath, 'utf8')).trim().split('\n')
        .filter((line) => line === 'activate')).toHaveLength(activationsBefore);
      const lease = await reloadController.acquireRuntimeRegistry();
      try {
        expect(lease.registry.readPluginSourceCustody?.(lazy.input.pluginId)).toEqual(lazyServing?.sourceCustody);
        await lease.registry.activateContributionsOnDemand([{
          pluginId: lazy.input.pluginId,
          family: 'actions',
          localId: 'identity',
        }]);
        await expect(invokeIdentity(lease.registry, lazy.input.pluginId)).resolves.toMatchObject({
          status: 'executed',
        });
        expect(reloadController.readCurrentPluginOccurrenceId?.(lazy.input.pluginId))
          .toBe(lazyServing?.occurrenceId);
      } finally {
        await lease.release();
      }
    } finally {
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
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
    await expect(installFixtureCandidate(store, changed.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(store, unrelated.input)).resolves.toMatchObject({ status: 'committed' });
    const predecessorLease = await reloadController.acquireRuntimeRegistry();

    blockNextPublication = true;
    const mutation = store.setEnabledWithResult(changed.input.pluginId, false);
    await publicationEntered;
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 3,
    });

    const lease = reloadController.tryAcquireRuntimeRegistry();
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
    await expect(installFixtureCandidate(store, changed.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(store, unrelated.input)).resolves.toMatchObject({ status: 'committed' });

    failNextPublication = true;
    await expect(store.setEnabledWithResult(changed.input.pluginId, false)).resolves.toMatchObject({
      transaction: {
        status: 'outcomeUnknown',
        phase: 'adoption',
        message: failure.message,
      },
    });

    const lease = reloadController.tryAcquireRuntimeRegistry();
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

    // A later one-plugin change prepares only that plugin's slot: the stale
    // fenced predecessor does not force every unchanged peer to activate again.
    failNextPublication = false;
    const third = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.post-commit-failure.third',
    );
    await expect(installFixtureCandidate(store, third.input)).resolves.toMatchObject({ status: 'committed' });
    const unrelatedLines = (await readFile(unrelated.counterPath, 'utf8')).trim().split('\n');
    expect(unrelatedLines.filter((line) => line === 'activate')).toHaveLength(1);
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
    await expect(installFixtureCandidate(store, changed.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(store, unrelated.input)).resolves.toMatchObject({ status: 'committed' });

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
      expectedCurrent: current,
      prepare: async () => undefined,
      validateAndActivate: async () => await runtimeLifecycle.prepare({
        mutationKind: 'state',
        runningSessionDisposition: 'revokeRunningSessions',
        changedPluginIds: Object.freeze([changed.input.pluginId]),
        runtimeCatalog,
        installationState,
        pluginOccurrenceIds: current.pluginOccurrenceIds,
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

    const lease = reloadController.tryAcquireRuntimeRegistry();
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
    await expect(installFixtureCandidate(store, executable.input)).resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(store, descriptorOnly.input)).resolves.toMatchObject({ status: 'committed' });

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

  it('quiesces an incumbent daemon database before a changed plugin removes its declaration', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-removed-database-'));
    const baseController = createPluginReloadController({ happyHomeDir });
    const resume = vi.fn(async () => undefined);
    const quiesceDaemonDatabases = vi.fn(async () => Object.freeze({ resume }));
    const readPreparedDaemonDatabaseContracts = vi.fn(() => Object.freeze([Object.freeze({
      id: 'index',
      incumbentQueryFixtureId: 'index-v1',
      incumbentQueryFixture: Object.freeze({
        id: 'index-v1',
        run: async () => undefined,
      }),
    })]));
    // The reload controller is the lifecycle boundary under test. This fixture
    // supplies only the active-registry members that candidate preparation reads.
    const activeRegistry = Object.freeze({
      activatedPluginIds: new Set(['acme.removed.database']),
      quiesceDaemonDatabases,
      readPreparedDaemonDatabaseContracts,
    }) as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const reloadController = Object.freeze({
      ...baseController,
      getState: () => Object.freeze({
        ...baseController.getState(),
        activeRegistry,
      }),
    });
    const lifecycle = createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController,
    });
    const runtimeCatalog = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {},
    });
    const installationState = PluginInstallationStateRevisionSchema.parse({
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'removed-daemon-database',
      createdAtMs: 1,
      plugins: {},
      rollbackRetention: [],
      runtimeCatalog,
      retainedRuntimeCatalog: {},
    });
    const candidate: PluginRegistryRuntimeCandidate = {
      mutationKind: 'state',
      runningSessionDisposition: 'revokeRunningSessions',
      changedPluginIds: Object.freeze(['acme.removed.database']),
      runtimeCatalog,
      installationState,
      pluginOccurrenceIds: {},
    };
    try {
      const prepared = await lifecycle.prepare(candidate);

      expect(readPreparedDaemonDatabaseContracts).toHaveBeenCalledWith('acme.removed.database');
      expect(quiesceDaemonDatabases).toHaveBeenCalledWith(['acme.removed.database']);

      await prepared.abort();
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      await baseController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
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
      rollbackRetention: [],
      runtimeCatalog,
      retainedRuntimeCatalog: {},
    });
    const candidate: PluginRegistryRuntimeCandidate = {
      mutationKind: 'state',
      runningSessionDisposition: 'retainRunningSessions',
      changedPluginIds: Object.freeze([]),
      runtimeCatalog,
      installationState,
      pluginOccurrenceIds: {},
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
      },
      pluginOccurrenceIds: {},
      createdAtMs: 1,
      creator: { pid: process.pid, instanceId: 'stale-adopt-test' },
    });

    await expect(prepared.adopt(record)).rejects.toThrow(/durable revision is stale/i);
    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(disposePreparedRegistryCallCount).toBe(1);
    expect(controller.getState().activeRegistry).toBeNull();
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
          execution: { target: 'daemon' },
          placementBindings: ['primary'],
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
          install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'allowed' },
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

    await expect(installFixtureCandidate(store, {
      pluginId: 'acme.prepare.reject',
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord: record,
      trust,
      updatePolicy: 'allowed',
      optionalAccess: [],
    })).rejects.toThrow(/missing registration/i);

    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 0,
      pluginOccurrenceIds: {},
    });
    await expect(readFile(counterPath, 'utf8')).resolves.toBe('module\nactivate\n');
    expect(reloadController.getState().activeRegistry).toBeNull();
  });

  it('aborts an unpublished candidate when required primary Agent bootstrap fails', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-primary-bootstrap-reject-'));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir,
        reloadController,
      }),
    });
    const fixture = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.primary-bootstrap.reject',
      { primaryRuntimeBootstrapFailure: true },
    );

    await store.initialize();
    await expect(installFixtureCandidate(store, fixture.input))
      .rejects.toThrow(/candidate primary bootstrap rejected/i);
    await expect(readPluginRegistryCommitRecord(store.paths)).resolves.toMatchObject({
      revision: 0,
      pluginOccurrenceIds: {},
    });
    await expect(readFile(fixture.counterPath, 'utf8'))
      .resolves.toBe('module\nactivate\nbootstrap\nbootstrap-aborted\ncleanup\n');
    expect(reloadController.getState().activeRegistry).toBeNull();

    await reloadController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  it('publishes daemon readiness while isolating one trust-rejected external plugin', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-trust-rejected-startup-'));
    const rejected = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.trust-rejected',
      { daemonDatabase: true },
    );
    const healthy = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.healthy',
    );
    const seedStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => Object.freeze({
          abort: async () => undefined,
          adopt: async () => undefined,
        }),
      },
    });
    await seedStore.initialize();
    await expect(installFixtureCandidate(seedStore, rejected.input))
      .resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(seedStore, healthy.input))
      .resolves.toMatchObject({ status: 'committed' });
    await seedUnapprovedInstallationState(seedStore, rejected.input.pluginId);

    const reloadController = createPluginReloadController({ happyHomeDir });
    const onInitialRegistryPublished = vi.fn();
    const awaitInitialRuntimeActivation = vi.fn(async () => undefined);
    const { createDaemonPluginRuntimeOwner } = await import('@/plugins/daemon/runtimeOwner');
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      daemonDatabaseLimits: {
        protocolMaximumDatabaseBytes: 1_024,
        resolvePluginLimits: () => ({
          maximumDatabaseBytes: 1_024,
          maximumInputBytes: 1_024,
          maximumResultBytes: 1_024,
          maximumResultRows: 16,
          maximumAffectedRows: 16,
          maximumElapsedMs: 1_000,
        }),
      },
      onInitialRegistryPublished,
      awaitInitialRuntimeActivation,
    });
    try {
      await owner.initialize();
      const registry = reloadController.getState().activeRegistry;
      expect(registry).not.toBeNull();
      expect(registry?.activatedPluginIds).toEqual(new Set([healthy.input.pluginId]));
      expect(registry?.pluginDiagnosticsByPluginId[rejected.input.pluginId]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'plugin_trust_approval_required' }),
        ]),
      );
      expect(onInitialRegistryPublished).toHaveBeenCalledOnce();
      expect(awaitInitialRuntimeActivation).toHaveBeenCalledOnce();
      await expect(readFile(healthy.counterPath, 'utf8')).resolves.toBe('module\nactivate\n');
      await expect(readFile(rejected.counterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await owner.changeService.shutdown();
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('publishes an inspectable daemon registry when every external plugin is trust-rejected', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-all-trust-rejected-startup-'));
    const first = await createExecutableInstallFixture(happyHomeDir, 'acme.first-trust-rejected');
    const second = await createExecutableInstallFixture(happyHomeDir, 'acme.second-trust-rejected');
    const seedStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => Object.freeze({
          abort: async () => undefined,
          adopt: async () => undefined,
        }),
      },
    });
    await seedStore.initialize();
    await expect(installFixtureCandidate(seedStore, first.input))
      .resolves.toMatchObject({ status: 'committed' });
    await expect(installFixtureCandidate(seedStore, second.input))
      .resolves.toMatchObject({ status: 'committed' });
    await seedUnapprovedInstallationState(seedStore, first.input.pluginId);
    await seedUnapprovedInstallationState(seedStore, second.input.pluginId);

    const reloadController = createPluginReloadController({ happyHomeDir });
    const onInitialRegistryPublished = vi.fn();
    const { createDaemonPluginRuntimeOwner } = await import('@/plugins/daemon/runtimeOwner');
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      onInitialRegistryPublished,
    });
    try {
      await owner.initialize();
      const registry = reloadController.getState().activeRegistry;
      expect(registry).not.toBeNull();
      expect(registry?.activatedPluginIds).toEqual(new Set());
      expect(onInitialRegistryPublished).toHaveBeenCalledOnce();
      for (const pluginId of [first.input.pluginId, second.input.pluginId]) {
        expect(registry?.pluginDiagnosticsByPluginId[pluginId]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'plugin_trust_approval_required' }),
          ]),
        );
      }
    } finally {
      await owner.changeService.shutdown();
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('runs the initial cold-start callbacks once after normalizing a legacy availability row', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-legacy-availability-initial-'));
    const fixture = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.legacy.availability.healthy',
    );
    const seedStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => Object.freeze({
          abort: async () => undefined,
          adopt: async () => undefined,
        }),
      },
    });
    await seedStore.initialize();
    await expect(installFixtureCandidate(seedStore, fixture.input))
      .resolves.toMatchObject({ status: 'committed' });
    await seedLegacyAvailabilityInstallationState(seedStore, fixture.input.pluginId);

    const reloadController = createPluginReloadController({ happyHomeDir });
    const onInitialRegistryPublished = vi.fn();
    const awaitInitialRuntimeActivation = vi.fn(async () => undefined);
    const { createDaemonPluginRuntimeOwner } = await import('@/plugins/daemon/runtimeOwner');
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      onInitialRegistryPublished,
      awaitInitialRuntimeActivation,
    });
    try {
      await owner.initialize();
      await owner.initialize();
      expect(reloadController.getState().activeRegistry).not.toBeNull();
      expect(onInitialRegistryPublished).toHaveBeenCalledOnce();
      expect(awaitInitialRuntimeActivation).toHaveBeenCalledOnce();
      await expect(readFile(fixture.counterPath, 'utf8')).resolves.toBe('module\nactivate\n');
    } finally {
      await owner.changeService.shutdown();
      await reloadController.shutdown();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('retains explicit plugin recovery after normal external activation is isolated', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-plugin-recovery-disable-'));
    const fixture = await createExecutableInstallFixture(
      happyHomeDir,
      'acme.recovery.crashing',
      { startupCrash: true },
    );
    const seedStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => Object.freeze({
          abort: async () => undefined,
          adopt: async () => undefined,
        }),
      },
    });
    await seedStore.initialize();
    await expect(installFixtureCandidate(seedStore, fixture.input))
      .resolves.toMatchObject({ status: 'committed' });

    const normalController = createPluginReloadController({ happyHomeDir });
    const { createDaemonPluginRuntimeOwner } = await import('@/plugins/daemon/runtimeOwner');
    const normalOwner = createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController: normalController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });
    await normalOwner.initialize();
    expect(normalController.getState().activeRegistry?.activatedPluginIds)
      .toEqual(new Set());
    expect(normalController.getState().activeRegistry?.pluginDiagnosticsByPluginId[fixture.input.pluginId])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'plugin_daemon_module_load_failed' }),
      ]));
    await normalOwner.changeService.shutdown();
    await normalController.shutdown();

    const recoveryController = createPluginReloadController({ happyHomeDir });
    const recoveryOwner = createDaemonPluginRuntimeOwner({
      happyHomeDir,
      staleCandidateCleanup: 'disabled',
      reloadController: recoveryController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      startupMode: 'pluginRecovery',
    });
    await recoveryOwner.initialize();

    await expect(recoveryOwner.readCatalog()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: fixture.input.pluginId,
          enabled: true,
          appliedGeneration: null,
        }),
      ]),
    );
    await expect(recoveryOwner.changeService.requestPluginChange({
      kind: 'disable',
      pluginId: fixture.input.pluginId,
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: fixture.input.pluginId,
    });
    const committed = await readPluginRegistryCommitRecord(seedStore.paths);
    if (!committed) throw new Error('Expected recovery disable commit');
    const state = await readInstallationStateRevision({
      paths: seedStore.paths,
      reference: committed.installationState,
    });
    expect(state.plugins[fixture.input.pluginId]?.enabled).toBe(false);
    await expect(readFile(fixture.counterPath, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await expect(recoveryOwner.changeService.requestPluginChange({
      kind: 'uninstall',
      pluginId: fixture.input.pluginId,
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: fixture.input.pluginId,
      desiredGeneration: null,
      appliedGeneration: null,
    });
    expect((await recoveryOwner.readCatalog()).some((entry) => (
      entry.pluginId === fixture.input.pluginId
    ))).toBe(false);
    await expect(readFile(fixture.counterPath, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await recoveryOwner.changeService.shutdown();
    await recoveryController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  });
});
