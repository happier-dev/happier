import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { persistInstallationStateRevision, type PluginInstallationStateRecord } from '@/plugins/store/registry/generationStore';
import { readPluginRegistryCommitRecord, replacePluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import type { PluginStateFileV1, PluginStateRecord } from '@/plugins/store/state';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPluginRegistryUpdateTracker } from './pluginUpdateTracker';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('resolves N installed channels once per check and projects changed and current versions for Store review', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'plugin-tracker-')); roots.push(happyHomeDir);
  const store = createPluginRegistryStateStore({ happyHomeDir });
  const ids = ['acme.one', 'acme.two', 'acme.three'];
  await store.initialize();
  const catalog: PluginStateFileV1 = { t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: Object.fromEntries(ids.map((pluginId): [string, PluginStateRecord] => [pluginId, {
    source: { kind: 'package', locator: pluginId, trustPolicy: 'prompt', installPolicy: 'managed_install', resolvedPath: '/installed', manifestPath: '/installed/plugin.json' },
    install: { mode: 'managed_install', manifestVersion: pluginId === ids[0] ? '1.1.0' : '1.0.0', updatePolicy: 'allowed',
      trust: { pluginId, state: 'trusted', approvedAtMs: 1, distribution: { kind: 'npm', packageName: pluginId, registryOrigin: 'https://registry.npmjs.org' } } },
    state: { enabled: true }, compatibility: { status: 'compatible', diagnostics: [] },
  }])) };
  const current = (await readPluginRegistryCommitRecord(store.paths))!;
  const installationState = await persistInstallationStateRevision({ paths: store.paths, state: {
    t: 'happier_plugin_installations_v1', schemaVersion: 1, revisionId: 'tracker-fixture', createdAtMs: 1, rollbackRetention: [],
    runtimeCatalog: catalog, plugins: Object.fromEntries(Object.entries(catalog.plugins).map(([id, entry]) => [id, {
      enabled: true, trust: entry.install.trust, source: { distribution: entry.install.trust!.distribution }, updatePolicy: 'allowed', optionalAccess: [],
    } satisfies PluginInstallationStateRecord])),
  } });
  await replacePluginRegistryCommitRecord({ paths: store.paths, expectedCurrent: current, next: { ...current,
    revision: current.revision + 1, baseRevision: current.revision, installationState,
  } });
  let requests = 0;
  const tracker = createPluginRegistryUpdateTracker({ happyHomeDir, createNpmClient: () => ({ getJson: async ({ url }) => {
    requests++;
    const pluginId = decodeURIComponent(new URL(url).pathname.slice(1));
    return { name: pluginId, versions: { '1.1.0': { name: pluginId, version: '1.1.0',
      happier: { compatibilityProjection: { version: 1, manifest: { schemaVersion: 2, id: pluginId, version: '1.1.0', displayName: pluginId,
        engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 }, contributes: {} }, uiArtifacts: { version: 2, entries: [] } } },
      dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, tarball: 'https://registry.npmjs.org/plugin.tgz' } } } };
  } }) });
  const before = await store.read();
  const listed = await tracker.list();
  expect(requests).toBe(0);
  const checked = await tracker.check!(listed);
  expect(requests).toBe(ids.length);
  expect(checked.get(ids[0])).toEqual({ state: 'current', latest: { kind: 'version', version: '1.1.0' } });
  expect(checked.get(ids[1])).toEqual({ state: 'update_available', latest: { kind: 'version', version: '1.1.0' } });
  await tracker.record([]);
  expect(await store.read()).toEqual(before);
  await tracker.check!(await tracker.list([ids[1]]));
  expect(requests).toBe(ids.length + 1);
});
