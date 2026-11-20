import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

it('unregisters only matching development authority and re-admits it through fresh installation review', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-removal-')));
  const firstEntry = join(root, 'first.ts');
  const secondRoot = join(root, 'second');
  const pluginId = 'acme.development-removal';
  const reloadController = createPluginReloadController({
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: createResolvedContributionRegistry({}),
    }),
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir: root,
    staleCandidateCleanup: 'disabled',
    reloadController,
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir: root, pluginId }).owner,
  });
  const store = createPluginRegistryStateStore({ happyHomeDir: root });
  const control = owner.changeService.controlPluginDevelopment!;
  const source = [
    `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined }))};`,
    'export function activate() {}',
  ].join('\n');
  try {
    const initialRegistry = await reloadController.acquireRuntimeRegistry();
    await initialRegistry.release();
    await writeFile(firstEntry, source);

    // Manifest discovery creates a review and status identity before durable installation.
    await control({ kind: 'registerExplicit', rootPath: firstEntry });
    expect((await owner.changeService.listPendingPluginChanges()).changes).toHaveLength(1);
    expect((await store.read()).plugins[pluginId]).toBeUndefined();
    const uninstalledSnapshot = await store.readSnapshot();
    await expect(control({ kind: 'unregisterExplicit', rootPath: firstEntry }))
      .resolves.toMatchObject({ kind: 'status', status: { roots: [], plugins: [] } });
    expect(await store.readSnapshot()).toEqual(uninstalledSnapshot);
    const persistedPath = join(resolvePluginStorePaths({ happyHomeDir: root }).stateDir, 'development-roots.v1.json');
    expect(JSON.parse(await readFile(persistedPath, 'utf8')).explicitRoots).toEqual([]);
    expect(await readFile(firstEntry, 'utf8')).toBe(source);

    // Manifest roots expose their id even when preparation/review never installs them.
    // A code-only pending review has no status id and skips the removal seam above.
    await mkdir(join(secondRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(secondRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(
      createPluginManifestV2Fixture({ id: pluginId }),
    ));
    await writeFile(join(secondRoot, 'package.json'), JSON.stringify({
      name: 'development-removal-fixture', version: '1.0.0', private: true,
    }));
    await writeFile(join(secondRoot, 'daemon.mjs'), 'export function activate() {}');
    await expect(control({ kind: 'registerExplicit', rootPath: secondRoot }))
      .resolves.toMatchObject({ status: { plugins: [{ pluginId }] } });
    const manifestSnapshot = await store.readSnapshot();
    await expect(control({ kind: 'unregisterExplicit', rootPath: secondRoot }))
      .resolves.toMatchObject({ kind: 'status', status: { roots: [], plugins: [] } });
    expect(await store.readSnapshot()).toEqual(manifestSnapshot);

    // Adopt the first root, then discover another root that declares the same id.
    await control({ kind: 'registerExplicit', rootPath: firstEntry });
    const changes = (await owner.changeService.listPendingPluginChanges()).changes;
    const pending = changes[changes.length - 1]!;
    // An outstanding review still belongs to this exact candidate. Rejoining
    // it must not submit another revision and invalidate its eventual decision.
    await control({ kind: 'registerExplicit', rootPath: firstEntry });
    expect((await owner.changeService.listPendingPluginChanges()).changes).toEqual(changes);
    await expect(owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    expect((await store.read()).plugins[pluginId]!.install.trust).toBeDefined();
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
    // Re-presenting the remembered source after its exact review settled must
    // observe admission, rather than returning the old review diagnostic.
    await expect(control({ kind: 'registerExplicit', rootPath: firstEntry }))
      .resolves.toMatchObject({
        kind: 'status',
        status: { plugins: [{ pluginId, phase: 'active' }] },
      });
    const installed = (await store.read()).plugins[pluginId]!;
    const occurrence = reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    await control({ kind: 'registerExplicit', rootPath: secondRoot });
    const incumbentSnapshot = await store.readSnapshot();
    await expect(control({ kind: 'unregisterExplicit', rootPath: secondRoot }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(await store.readSnapshot()).toEqual(incumbentSnapshot);
    expect((await store.read()).plugins[pluginId]).toEqual(installed);
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBe(occurrence);

    // Exact incumbent removal still revokes durable source trust and its runtime occurrence.
    await expect(control({ kind: 'unregisterExplicit', rootPath: firstEntry }))
      .resolves.toMatchObject({ kind: 'status', status: { roots: [], plugins: [] } });
    expect((await store.read()).plugins[pluginId]).toMatchObject({
      source: { trustPolicy: 'untrusted' },
      state: { enabled: false },
    });
    expect((await store.read()).plugins[pluginId]!.install.trust).toBeUndefined();
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
    await expect(owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
      .resolves.toMatchObject({ kind: 'failed', code: 'plugin_change_failed' });

    const rejoin = await owner.changeService.requestPluginChange({
      kind: 'development', pluginId, sourceRootPath: firstEntry,
    });
    expect(rejoin, JSON.stringify(rejoin)).toMatchObject({ kind: 'reviewRequired', reviewKind: 'installation' });
    if (rejoin.kind !== 'reviewRequired') throw new Error('Expected fresh installation review');
    expect(rejoin.pendingChangeId).not.toBe(pending.pendingChangeId);
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
    const rejoined = await owner.changeService.decidePluginChange({
      pendingChangeId: rejoin.pendingChangeId, decision: 'installAndTrust',
    });
    expect(rejoined, JSON.stringify(rejoined)).toMatchObject({ kind: 'committed', pluginId });
    expect((await store.read()).plugins[pluginId]).toMatchObject({ state: { enabled: true } });
    expect(reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
