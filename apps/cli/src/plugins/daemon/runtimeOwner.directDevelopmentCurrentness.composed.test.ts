import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, vi } from 'vitest';
import { normalizePluginAccountCollectionContractV1, PluginAvailabilityCollectionWritersClaimActionInputV1Schema,
  PluginCollectionCandidatePreparationStageRequestV1Schema, type PluginAccountCollectionContributionV1 } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { ResolvedContributionInputs } from '@/plugins/projection/registry/types';
import { createPluginRuntimeOccurrenceId, type PluginRuntimeSlotOccurrence } from '@/plugins/runtime/runtimeSlots';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createTestNpmTarball } from '@/plugins/distribution/testkit/npmTarball';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

function createRuntime(happyHomeDir: string, pluginId: string, contributes: ResolvedContributionInputs = {},
  servingPluginOccurrences?: ReadonlyMap<string, PluginRuntimeSlotOccurrence>,
  accountStorageDependencies?: AccountPluginDataStorageHostDependencies) {
  const reloadController = createPluginReloadController({
    happyHomeDir,
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: createResolvedContributionRegistry(contributes),
      ...(accountStorageDependencies ? { accountStorageDependencies } : {}),
      ...(servingPluginOccurrences ? { servingPluginOccurrences } : {}),
    }),
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir,
    staleCandidateCleanup: 'disabled',
    reloadController,
    ...(accountStorageDependencies ? { accountStorageDependencies } : {}),
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
  });
  return { owner, reloadController };
}

it('adopts bundled development edits without review and settles a restored authority expansion', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-bundled-development-authority-')));
  const entryPath = join(root, 'plugin.ts');
  const incumbentPath = join(root, 'daemon.mjs');
  const pluginId = 'acme.bundled-development-authority';
  const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
    id: pluginId,
    engines: { happier: '>=0.0.0' },
    hostAccess: { required: [{ id: 'session-access', capability: 'sessions', reason: 'Read bound Sessions',
      scope: { access: ['read'] } }], optional: [] },
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  }));
  await writeFile(incumbentPath, "export function activate(api) { api.actions.register('identity', () => ({ edition: 0 })); }");
  const contributes = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: {
    diagnosticsByPluginId: {},
    loadedPlugins: [{ pluginId, pluginRootPath: root, manifestPath: join(root, 'plugin.json'),
      daemonEntryPath: incumbentPath, devDaemonEntryPath: null, manifest,
      sourceSpec: { kind: 'bundled', locator: root } }],
  } });
  // Seed the incumbent's serving identity through the runtime's ordinary
  // retained-slot input. The custom fixture is not a generated bundled package;
  // source custody alone must not create a persisted installation record.
  const { owner, reloadController } = createRuntime(root, pluginId, contributes, new Map([[pluginId, {
    occurrenceId: createPluginRuntimeOccurrenceId(pluginId),
    sourceCustody: { kind: 'bundled_first_party', packagedRuntime: {
      kind: 'pinned_runner_snapshot', snapshotId: 'bundled-authority-fixture',
    } },
  }]]));
  const writeEdition = (edition: number, expanded = false) => writeFile(entryPath, [
    `export const manifest = ${JSON.stringify({ ...manifest, hostAccess: { ...manifest.hostAccess,
      required: manifest.hostAccess.required.map(request => ({ ...request,
        scope: { access: expanded ? ['read', 'write'] : ['read'] } })) } })};`,
    `export function activate(api) { api.actions.register('identity', () => ({ edition: ${edition} })); }`,
  ].join('\n'));
  const invoke = () => reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId, localId: 'identity', input: {}, surface: 'cli',
  });
  try {
    const initial = await reloadController.acquireRuntimeRegistry();
    await initial.release();
    expect(reloadController.readCurrentPluginSourceCustody?.(pluginId)).toMatchObject({ kind: 'bundled_first_party' });
    expect((await createPluginRegistryStateStore({ happyHomeDir: root }).read()).plugins[pluginId]).toBeUndefined();
    await writeEdition(1);
    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 1 } });

    await writeEdition(2);
    await owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 2 } });

    await writeEdition(3, true);
    await owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    const pending = (await owner.changeService.listPendingPluginChanges()).changes[0];
    expect(pending).toMatchObject({ kind: 'reviewRequired', reason: 'authorityExpansion',
      currentVersion: manifest.version, authorityExpansion: ['requiredHostAccess'] });
    if (!pending) throw new Error('Expected real authority expansion review');
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 2 } });

    await writeEdition(4);
    await owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    // A retained review leaves reload to the existing OS source observer.
    await vi.waitFor(async () => {
      expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 4 } });
    }, { timeout: 120_000 });
    expect(owner.changeService.hasPendingDevelopmentSourceChange(entryPath)).toBe(false);
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 4 } });
    await expect(owner.changeService.statusPluginChange({ pendingChangeId: pending.pendingChangeId }))
      .resolves.toMatchObject({ kind: 'terminal', result: { kind: 'cancelled' } });
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it.each([false, true])('converges concurrent development roots (manual reload: %s)', async (manualReload) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-registry-conflict-')));
  const pluginId = 'acme.development-registry-conflict';
  const peerId = 'acme.development-registry-peer';
  const entryPath = join(root, 'author', 'plugin.ts');
  const peerPath = join(root, 'peer', 'plugin.ts');
  await mkdir(join(root, 'author'));
  await mkdir(join(root, 'peer'));
  const { owner, reloadController } = createRuntime(join(root, 'home'), pluginId);
  const writeEdition = (path: string, id: string, edition: number) => writeFile(path, [
    `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id, entrypoints: undefined,
      engines: { happier: '>=0.0.0' },
      contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
        execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
    }))};`,
    `export async function activate(api) { await globalThis[Symbol.for(${JSON.stringify(root)})](${JSON.stringify(id)}, ${edition}); api.actions.register('identity', () => ({ edition: ${edition} })); }`,
  ].join('\n'));
  const invoke = (id: string) => reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId: id, localId: 'identity', input: {}, surface: 'cli',
  });
  let release!: () => void;
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const activations = new Map<string, number[]>([[pluginId, []], [peerId, []]]);
  Reflect.set(globalThis, Symbol.for(root), async (id: string, edition: number) => {
    const editions = activations.get(id)!;
    editions.push(edition);
    if (id === pluginId && edition === 2) {
      // Count real authored activation at the preparation boundary. The
      // incumbent must remain executable during both the refusal and retry.
      if (!manualReload || editions.length === 2) {
        await expect(invoke(pluginId)).resolves.toMatchObject({ status: 'executed', value: { edition: 1 } });
      }
      if (editions.length === 2) { entered(); await resume; }
    }
  });
  try {
    const initial = await reloadController.acquireRuntimeRegistry();
    await initial.release();
    for (const [path, id] of [[entryPath, pluginId], [peerPath, peerId]] as const) {
      await writeEdition(path, id, 1);
      const registration = await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: path });
      const pending = (await owner.changeService.listPendingPluginChanges()).changes[0];
      if (!pending) throw new Error(registration.kind === 'failed'
        ? `Expected initial development review: ${registration.code}: ${registration.message}`
        : 'Expected initial development review');
      await expect(owner.changeService.decidePluginChange({ pendingChangeId: pending.pendingChangeId,
        decision: 'installAndTrust' })).resolves.toMatchObject({ kind: 'committed', pluginId: id });
    }
    const incumbent = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    await writeEdition(entryPath, pluginId, 2);
    await preparing;
    const reload = manualReload
      ? owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath })
      : null;
    await writeEdition(peerPath, peerId, 2);
    await vi.waitFor(async () => {
      await expect(invoke(peerId)).resolves.toMatchObject({ status: 'executed', value: { edition: 2 } });
    }, { timeout: 120_000 });
    const peerOccurrence = reloadController.readCurrentPluginOccurrenceId?.(peerId);
    release();
    if (reload) await expect(reload).resolves.toMatchObject({ kind: 'status' });
    await vi.waitFor(async () => {
      const status = (await owner.changeService.controlPluginDevelopment!({ kind: 'status' })).status.plugins
        .find(plugin => plugin.pluginId === pluginId);
      expect(status?.phase).not.toBe('compiling');
    }, { timeout: 120_000 });
    await expect(invoke(pluginId)).resolves.toMatchObject({ status: 'executed', value: { edition: 2 } });
    await expect(invoke(peerId)).resolves.toMatchObject({ status: 'executed', value: { edition: 2 } });
    if (!manualReload) expect(activations.get(pluginId)).toEqual([1, 2, 2]);
    expect(activations.get(peerId)).toEqual([1, 2]);
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).not.toBe(incumbent);
    expect(reloadController.readCurrentPluginOccurrenceId?.(peerId)).toBe(peerOccurrence);
    expect((await owner.changeService.controlPluginDevelopment!({ kind: 'status' })).status.plugins)
      .toEqual(expect.arrayContaining([expect.objectContaining({ pluginId, phase: 'active' }),
        expect.objectContaining({ pluginId: peerId, phase: 'active', occurrenceId: peerOccurrence })]));
    expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
  } finally {
    release();
    Reflect.deleteProperty(globalThis, Symbol.for(root));
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('settles watched edits and restoration of previously adopted source bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-source-restore-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-source-restore';
  const { owner, reloadController } = createRuntime(root, pluginId);
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  const source = (edition: number) => [
    `export const manifest = ${JSON.stringify(manifest)};`,
    `export async function activate(api) { ${edition === 4 ? `await globalThis[Symbol.for(${JSON.stringify(root)})]();` : ''} api.actions.register('identity', () => ({ edition: ${edition} })); }`,
  ].join('\n');
  const invoke = () => reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId, localId: 'identity', input: {}, surface: 'cli',
  });
  try {
    await writeFile(entryPath, source(1));
    const lease = await reloadController.acquireRuntimeRegistry();
    await lease.release();
    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await owner.changeService.listPendingPluginChanges()).changes[0];
    if (!pending) throw new Error('Expected initial development review');
    await expect(owner.changeService.decidePluginChange({ pendingChangeId: pending.pendingChangeId,
      decision: 'installAndTrust' })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const initialOccurrence = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    let previousOccurrence = initialOccurrence;
    for (const edition of [2, 3, 1]) {
      await writeFile(entryPath, source(edition));
      // Drive real OS observation, preparation, activation, adoption and status.
      await vi.waitFor(async () => {
        await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition } });
        const occurrenceId = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
        expect(occurrenceId).not.toBe(previousOccurrence);
        expect((await owner.changeService.controlPluginDevelopment!({ kind: 'status' })).status.plugins)
          .toEqual(expect.arrayContaining([expect.objectContaining({ pluginId, phase: 'active', occurrenceId })]));
      }, { timeout: 120_000 });
      previousOccurrence = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
      expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
    }
    expect(previousOccurrence).not.toBe(initialOccurrence);

    let entered!: () => void;
    let release!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    // The real plugin's async activate is the external code boundary. Restore
    // while its candidate is in flight, then settle on that actual completion.
    Reflect.set(globalThis, Symbol.for(root), async () => { entered(); await resume; });
    try {
      await writeFile(entryPath, source(4));
      await preparing;
      await writeFile(entryPath, source(1));
    } finally {
      release();
    }
    await vi.waitFor(async () => {
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 1 } });
      const occurrenceId = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
      expect(occurrenceId).not.toBe(previousOccurrence);
      expect((await owner.changeService.controlPluginDevelopment!({ kind: 'status' })).status.plugins)
        .toEqual(expect.arrayContaining([expect.objectContaining({ pluginId, phase: 'active', occurrenceId })]));
      expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
    }, { timeout: 120_000 });
  } finally {
    Reflect.deleteProperty(globalThis, Symbol.for(root));
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it.each(['identity', 'throwing'] as const)('settles a higher-version development Collection with a %s migration', async migration => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-collection-upgrade-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-collection-upgrade';
  const source: PluginAccountCollectionContributionV1 = {
    id: 'rows', schemaVersion: 1,
    schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: ['id', 'title'], additionalProperties: false },
    rowIdField: 'id', serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], identityFields: [], migrations: [],
  };
  const target: PluginAccountCollectionContributionV1 = { ...source, schemaVersion: 2, readableSchemaVersions: [1, 2],
    migrations: [{ id: 'rows-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 }] };
  const ref = (declaration: PluginAccountCollectionContributionV1) => {
    const contract = normalizePluginAccountCollectionContractV1({ pluginId, contribution: declaration });
    return { pluginId, collectionId: declaration.id, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
  };
  const retained = { rowId: 'row-1', revision: 1,
    content: { t: 'plain' as const, v: { title: 'retained' } }, projection: { id: 'row-1' } };
  let staged: ReturnType<typeof PluginCollectionCandidatePreparationStageRequestV1Schema.parse>['items'][number]['target'] | undefined;
  let writerVersion = 1;
  let preparations = 0;
  let retired = false;
  const dependencies: AccountPluginDataStorageHostDependencies = {
    readCredentials: async () => ({ token: 'development-migration-fixture', encryption: null }),
    isCurrentAccount: () => true, resolveAccountScopeKey: () => root,
    resolveBaseUrl: () => 'https://development-migration.example.test',
    resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
    // Only the external Account HTTP boundary is substituted. Source admission,
    // writer-claim joining, callback loading, migration and Resource readiness stay real.
    http: {
      get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
      post: async (url, encoded) => {
        const input: unknown = JSON.parse(encoded);
        const intent = { pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled',
          writableCollections: [ref(writerVersion === 1 ? source : target)], revision: String(writerVersion) };
        if (url.endsWith('/collection-writers/claim')) {
          const request = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(input);
          const declaration = request.manifest.contributes.accountCollections[0]!;
          if (declaration.schemaVersion === 1) return { status: 200, data: { intent } };
          if (request.prepare) {
            preparations += 1;
            return { status: 200, data: { intent, preparation: [{ source, binding: {
              source: ref(source), target: ref(target), candidate: { releaseVersion: request.manifest.version,
                artifactDigest: `sha256:${'a'.repeat(64)}`, releaseLessManifest: request.manifest },
            } }] } };
          }
          if (!staged) return { status: 409, data: { error: 'plugin_intent_writable_collections_not_ready' } };
          writerVersion = 2;
          return { status: 200, data: { intent: { ...intent, writableCollections: [ref(target)], revision: '2' } } };
        }
        if (url.endsWith('/candidate-preparation/source-page')) {
          return { status: 200, data: { rows: [{ ...retained, alreadyStaged: false }] } };
        }
        if (url.endsWith('/candidate-preparation/stage')) {
          const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(input);
          expect(writerVersion).toBe(1);
          staged = request.items[0]!.target;
          return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
        }
        if (url.endsWith('/candidate-preparation/retire')) {
          retired = true;
          return { status: 200, data: { status: 'retired' } };
        }
        if (url.endsWith('/v1/plugins/data/get')) {
          if (preparations > 0 && writerVersion === 1) return { status: 404, data: { error: 'collection_unavailable' } };
          return { status: 200, data: { row: staged ? { ...retained, ...staged } : retained, absenceEpoch: 0 } };
        }
        throw new Error(`Unexpected migration fixture HTTP request: ${url}`);
      },
    },
  };
  const { owner, reloadController } = createRuntime(root, pluginId, {}, undefined, dependencies);
  const writeVersion = async (version: 1 | 2) => {
    const declaration = version === 1 ? source : target;
    const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
      hostAccess: { required: [{ id: 'account-storage', capability: 'storage.account',
        reason: 'Read retained Collection rows', scope: { enabled: true } }], optional: [] },
      contributes: { accountCollections: [declaration],
        actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
          execution: { target: 'daemon' }, dangerLevel: 'safe' }],
        resources: [{ id: 'state', source: 'dynamic', kind: 'config', scope: 'global',
          contentType: 'application/json', hostAccess: ['account-storage'] }] },
    });
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(manifest)};`,
      `export const collectionMigrations = { rows: ${version === 1 ? '[]' : `[{ ...${JSON.stringify(target.migrations[0])}, migrate(value) { ${migration === 'throwing' ? "throw new Error('fixture migration refused');" : 'return value;'} } }]`} };`,
      `const definition = { ...${JSON.stringify(declaration)}, migrations: collectionMigrations.rows };`,
      `export function activate(api) { api.actions.register('identity', () => ({ version: ${version} }));`,
      `api.resources.registerDynamicResource('state', { read: async options => JSON.stringify(await options.accountStorage.collection(definition).get('row-1')), observe: () => ({ dispose() {} }) }); }`,
    ].join('\n'));
  };
  try {
    await writeVersion(1);
    const lease = await reloadController.acquireRuntimeRegistry();
    await lease.release();
    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const review = (await owner.changeService.listPendingPluginChanges()).changes[0];
    if (!review) throw new Error('Expected initial development authority review');
    await expect(owner.changeService.decidePluginChange({ pendingChangeId: review.pendingChangeId,
      decision: 'installAndTrust' })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const incumbentOccurrence = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    await expect(reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
      pluginId, localId: 'identity', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: { version: 1 } });
    await writeVersion(2);
    await vi.waitFor(async () => {
      const status = await owner.changeService.controlPluginDevelopment!({ kind: 'status' });
      expect(status.status.plugins).toContainEqual(expect.objectContaining({ pluginId, phase: 'active' }));
      expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).not.toBe(incumbentOccurrence);
      expect(preparations).toBeGreaterThan(0);
    }, { timeout: 120_000 });
    expect(await owner.changeService.listPendingPluginChanges()).toEqual({ changes: [] });
    const registry = reloadController.getState().activeRegistry!;
    const read = () => registry.readUiResource!({ callerPluginId: pluginId, resourceId: 'state',
      expectedCallerOccurrenceId: reloadController.readCurrentPluginOccurrenceId!(pluginId)! });
    if (migration === 'identity') {
      expect(writerVersion).toBe(2);
      expect(staged?.content).toEqual({ t: 'plain', v: { title: 'retained' } });
      const resource = await read();
      expect(JSON.parse(new TextDecoder().decode(resource!.bytes))).toMatchObject({ value: { id: 'row-1', title: 'retained' } });
    } else {
      expect(writerVersion).toBe(1);
      expect(staged).toBeUndefined();
      expect(retired).toBe(true);
      await expect(read()).rejects.toMatchObject({ code: 'collection_unavailable' });
    }
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it('binds a direct development review to the registered source observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-direct-review-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-direct-review';
  const { owner, reloadController } = createRuntime(root, pluginId);
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const lease = await reloadController.acquireRuntimeRegistry();
    await lease.release();

    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const initial = (await owner.changeService.listPendingPluginChanges()).changes[0];
    if (!initial) throw new Error('Expected initial development review');
    await expect(owner.changeService.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });

    const direct = await owner.changeService.requestPluginChange(
      { kind: 'development', sourceRootPath: entryPath },
      { retainReview: true },
    );
    expect(direct.kind).toBe('reviewRequired');
    if (direct.kind !== 'reviewRequired') throw new Error('Expected direct development review');
    await expect(owner.changeService.decidePluginChange({
      pendingChangeId: direct.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it('prepares a new review when a normal request rejoins an already superseded source observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-stale-rejoin-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-direct-review';
  const { owner, reloadController } = createRuntime(root, pluginId);
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  const writeEdition = (edition: number) => writeFile(entryPath, [
    `export const manifest = ${JSON.stringify(manifest)};`,
    `export function activate(api) { api.actions.register('identity', () => ({ edition: ${edition} })); }`,
  ].join('\n'));
  try {
    await writeEdition(1);
    const initial = await reloadController.acquireRuntimeRegistry();
    await initial.release();
    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const first = (await owner.changeService.listPendingPluginChanges()).changes[0];
    if (!first) throw new Error('Expected the first retained development review');

    await writeEdition(2);
    // Exercise the real OS watcher and observation owner before request B.
    // Its busy diagnostic proves the newer observation reached the retained-change owner.
    await vi.waitFor(async () => {
      const status = await owner.changeService.controlPluginDevelopment!({ kind: 'status' });
      expect(status.status.plugins).toEqual(expect.arrayContaining([expect.objectContaining({
        pluginId, diagnostic: expect.objectContaining({ code: 'plugin_dev_busy' }),
      })]));
    }, { timeout: 120_000 });
    const next = await owner.changeService.requestPluginChange({ kind: 'development', sourceRootPath: entryPath });
    if (next.kind !== 'reviewRequired') throw new Error(`Expected fresh reviewed source: ${JSON.stringify(next)}`);
    expect(next.pendingChangeId).not.toBe(first.pendingChangeId);
    await expect(owner.changeService.decidePluginChange({ pendingChangeId: first.pendingChangeId, decision: 'installAndTrust' }))
      .resolves.toMatchObject({ kind: 'expired' });
    await expect(owner.changeService.decidePluginChange({ pendingChangeId: next.pendingChangeId, decision: 'installAndTrust' }))
      .resolves.toMatchObject({ kind: 'committed', pluginId });
    await expect(reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
      pluginId, localId: 'identity', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: { edition: 2 } });
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

it.each([
  { source: 'path', reviewKind: 'unchanged' },
  { source: 'archive', reviewKind: 'unchanged' },
  { source: 'path', reviewKind: 'rejoined' },
  { source: 'archive', reviewKind: 'rejoined' },
  { source: 'archive', reviewKind: 'fresh' },
] as const)('replaces a managed $source installation through its $reviewKind same-root development review', async ({ source, reviewKind }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-managed-to-development-')));
  const happyHomeDir = join(root, 'home');
  const pluginRoot = join(root, 'author');
  const pluginId = 'acme.development-direct-review';
  await mkdir(happyHomeDir);
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, 'src'));
  let { owner, reloadController } = createRuntime(happyHomeDir, pluginId);
  const manifest = createPluginManifestV2Fixture({ id: pluginId,
    entrypoints: { daemon: './daemon.mjs', development: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  const developmentManifest = reviewKind === 'unchanged' ? manifest : {
    ...manifest,
    hostAccess: { required: [{ id: 'session-access', capability: 'sessions',
      reason: 'Read Sessions', scope: { access: ['read'] } }], optional: [] },
  };
  const writeDevelopment = async (edition: string) => writeFile(join(pluginRoot, 'src', 'index.mjs'), [
    `export const manifest = ${JSON.stringify(developmentManifest)};`,
    `export function activate(api) { api.actions.register('identity', () => ({ edition: ${JSON.stringify(edition)} })); }`,
  ].join('\n'));
  const invoke = () => reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId, localId: 'identity', input: {}, surface: 'cli',
  });
  try {
    const manifestJson = JSON.stringify(manifest);
    const packageMetadata = {
      name: 'development-direct-review-fixture', version: '1.0.0', private: true, main: './src/index.mjs',
      keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' },
      files: ['.happier-plugin', 'daemon.mjs', 'src'],
    };
    const packageJson = JSON.stringify(packageMetadata);
    const daemonSource = "export function activate(api) { api.actions.register('identity', () => ({ edition: 'managed' })); }";
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), manifestJson);
    await writeFile(join(pluginRoot, 'package.json'), packageJson);
    await writeFile(join(pluginRoot, 'daemon.mjs'), daemonSource);
    await writeDevelopment('development');
    const initial = await reloadController.acquireRuntimeRegistry();
    await initial.release();
    const archivePath = join(root, 'candidate.tgz');
    if (source === 'archive') {
      await writeFile(archivePath, await createTestNpmTarball([
        { name: 'package/package.json', body: packageJson },
        { name: 'package/.happier-plugin/plugin.json', body: manifestJson },
        { name: 'package/daemon.mjs', body: daemonSource },
        { name: 'package/src/index.mjs', body: `export const manifest = ${manifestJson}; export function activate() {}` },
      ]));
    }
    const installation = await owner.changeService.requestPluginChange(source === 'archive'
      ? { kind: 'installArchive', locator: archivePath }
      : { kind: 'installPath', locator: pluginRoot });
    if (installation.kind !== 'reviewRequired') throw new Error(`Expected managed installation review: ${JSON.stringify(installation)}`);
    await expect(owner.changeService.decidePluginChange({
      pendingChangeId: installation.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const store = createPluginRegistryStateStore({ happyHomeDir });
    if (source === 'archive' && reviewKind === 'fresh') {
      await writeFile(archivePath, await createTestNpmTarball([
        { name: 'package/package.json', body: JSON.stringify({ ...packageMetadata, description: 'A newer archive' }) },
        { name: 'package/.happier-plugin/plugin.json', body: manifestJson },
        { name: 'package/daemon.mjs', body: daemonSource },
        { name: 'package/src/index.mjs', body: `export const manifest = ${manifestJson}; export function activate() {}` },
      ]));
      const update = await owner.changeService.requestPluginChange({ kind: 'update', pluginId });
      const updated = update.kind === 'reviewRequired'
        ? await owner.changeService.decidePluginChange({ pendingChangeId: update.pendingChangeId, decision: 'installAndTrust' })
        : update;
      expect(updated, JSON.stringify(updated)).toMatchObject({ kind: 'committed', pluginId });
      expect((await store.readSnapshot()).rollbackAvailabilityByPluginId[pluginId]).toBe('available');
    }
    // One real managed peer discriminates a selected-pointer transition from
    // incorrectly dropping every immutable generation in the registry.
    const peerPluginId = 'acme.development-direct-review-peer';
    if (source === 'archive' && reviewKind === 'fresh') {
      const peerRoot = join(root, 'peer');
      await mkdir(join(peerRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(peerRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({ ...manifest, id: peerPluginId }));
      await writeFile(join(peerRoot, 'package.json'), packageJson);
      await writeFile(join(peerRoot, 'daemon.mjs'), daemonSource);
      const peer = await owner.changeService.requestPluginChange({ kind: 'installPath', locator: peerRoot });
      if (peer.kind !== 'reviewRequired') throw new Error(`Expected peer review: ${JSON.stringify(peer)}`);
      await expect(owner.changeService.decidePluginChange({ pendingChangeId: peer.pendingChangeId, decision: 'installAndTrust' }))
        .resolves.toMatchObject({ kind: 'committed', pluginId: peerPluginId });
      await writeFile(join(peerRoot, 'daemon.mjs'), `${daemonSource}\n// New managed peer generation\n`);
      const peerUpdate = await owner.changeService.requestPluginChange({ kind: 'update', pluginId: peerPluginId });
      const peerUpdated = peerUpdate.kind === 'reviewRequired'
        ? await owner.changeService.decidePluginChange({ pendingChangeId: peerUpdate.pendingChangeId, decision: 'installAndTrust' })
        : peerUpdate;
      expect(peerUpdated, JSON.stringify(peerUpdated)).toMatchObject({ kind: 'committed', pluginId: peerPluginId });
      expect((await store.readSnapshot()).rollbackAvailabilityByPluginId[peerPluginId]).toBe('available');
    }
    const managedPointers = (await store.readSnapshot()).pluginOccurrenceIds;
    expect(managedPointers[pluginId]).toBeTruthy();
    const incumbent = reloadController.getState().activeRegistry!;
    const managedOccurrence = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    expect(incumbent.readPluginSourceCustody(pluginId)).toMatchObject({
      kind: 'managed', installSource: source === 'archive' ? 'archive' : 'localPath',
    });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'managed' } });

    // Reuse the real installed SDK dependency tree at the filesystem boundary;
    // this scenario does not exercise package-manager installation or the UI builder.
    await symlink(fileURLToPath(new URL('../../../../../node_modules', import.meta.url)),
      join(pluginRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: pluginRoot });
    const pending = (await owner.changeService.listPendingPluginChanges()).changes[0];
    if (reviewKind === 'unchanged') {
      expect(pending).toBeUndefined();
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'development' } });
      expect((await store.readSnapshot()).pluginOccurrenceIds[pluginId]).toBeUndefined();
      return;
    }
    if (!pending) throw new Error('Expected same-root development review');
    expect(pending).toMatchObject({ kind: 'reviewRequired', reason: 'authorityExpansion',
      authorityExpansion: ['requiredHostAccess'] });
    if (reviewKind === 'fresh') {
      await expect(owner.changeService.decidePluginChange({ pendingChangeId: pending.pendingChangeId, decision: 'cancel' }))
        .resolves.toMatchObject({ kind: 'cancelled' });
    }
    const development = await owner.changeService.requestPluginChange(
      { kind: 'development', sourceRootPath: pluginRoot }, { retainReview: true },
    );
    if (development.kind !== 'reviewRequired') throw new Error(`Expected development review: ${JSON.stringify(development)}`);
    if (reviewKind === 'rejoined') expect(development.pendingChangeId).toBe(pending.pendingChangeId);
    expect(reloadController.getState().activeRegistry).toBe(incumbent);
    expect((await store.readSnapshot()).pluginOccurrenceIds).toEqual(managedPointers);
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'managed' } });
    const result = await owner.changeService.decidePluginChange({
      pendingChangeId: development.pendingChangeId, decision: 'installAndTrust',
    });
    if (result.kind !== 'committed') {
      expect(reloadController.getState().activeRegistry).toBe(incumbent);
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'managed' } });
    }
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'committed', pluginId });
    expect((await store.readSnapshot()).pluginOccurrenceIds).toEqual(Object.fromEntries(
      Object.entries(managedPointers).filter(([id]) => id !== pluginId),
    ));
    if (source === 'archive' && reviewKind === 'fresh') {
      expect((await store.readSnapshot()).rollbackAvailabilityByPluginId).toMatchObject({
        [pluginId]: 'unavailable', [peerPluginId]: 'available',
      });
    }
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).not.toBe(managedOccurrence);
    expect(reloadController.getState().activeRegistry!.readPluginSourceCustody(pluginId)).toMatchObject({
      kind: 'development', registeredRootId: pluginRoot,
    });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'development' } });
    await writeDevelopment('development-updated');
    const reload = await owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: pluginRoot });
    expect(reload, JSON.stringify(reload)).toMatchObject({ kind: 'status', status: { plugins: expect.arrayContaining([
      expect.objectContaining({ pluginId, phase: 'active' }),
    ]) } });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'development-updated' } });
    if (source === 'archive' && reviewKind === 'fresh') {
      await expect(reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
        pluginId: peerPluginId, localId: 'identity', input: {}, surface: 'cli',
      })).resolves.toMatchObject({ status: 'executed', value: { edition: 'managed' } });
      await owner.changeService.shutdown();
      await reloadController.shutdown();
      await writeDevelopment('development-after-restart');
      ({ owner, reloadController } = createRuntime(happyHomeDir, pluginId));
      // This daemon has only durable authority and current author source, not
      // the previous daemon's accepted development activation graph.
      await owner.initialize();
      expect((await store.readSnapshot()).rollbackAvailabilityByPluginId).toMatchObject({
        [pluginId]: 'unavailable', [peerPluginId]: 'available',
      });
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { edition: 'development-after-restart' } });
      expect(reloadController.getState().activeRegistry!.readPluginSourceCustody(pluginId)).toMatchObject({
        kind: 'development', registeredRootId: pluginRoot,
      });
      await expect(reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
        pluginId: peerPluginId, localId: 'identity', input: {}, surface: 'cli',
      })).resolves.toMatchObject({ status: 'executed', value: { edition: 'managed' } });
    }
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
