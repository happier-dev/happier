import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';

import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../resolvePluginContributions';
import { resolveDeclarativeProjectionModels } from '../ui/declarativeModels';

import { buildPluginContributionRegistry } from './package';

const examplesRoot = fileURLToPath(new URL('../../../../../../../packages/plugin-sdk/examples', import.meta.url));

function listInstallableExampleRoots(): readonly string[] {
  return readdirSync(examplesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(examplesRoot, entry.name))
    .filter((exampleRoot) => {
      try {
        readFileSync(join(exampleRoot, '.happier-plugin', 'plugin.json'), 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function readLoadedExamplePlugin(exampleRoot: string): LoadedPlugin {
  const manifestPath = join(exampleRoot, '.happier-plugin', 'plugin.json');
  const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const manifest = readCanonicalPluginManifest(rawManifest);
  expect(manifest, `${manifestPath} must normalize through the CLI plugin manifest projection`).not.toBeNull();
  if (!manifest) {
    throw new Error(`Failed to normalize ${manifestPath}`);
  }

  return {
    pluginId: manifest.id,
    pluginRootPath: exampleRoot,
    manifestPath,
    daemonEntryPath: null,
    devDaemonEntryPath: null,
    manifest,
    sourceSpec: {
      kind: 'path',
      locator: exampleRoot,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: manifest.version,
    },
  };
}

describe('plugin SDK public installable examples', () => {
  it('projects the public Projects and Tasks direct-Data app page through the canonical manifest owner', () => {
    const projectsTasksRoot = join(examplesRoot, 'projects-tasks');

    expect(listInstallableExampleRoots()).toContain(projectsTasksRoot);

    const projectsTasks = readLoadedExamplePlugin(projectsTasksRoot);
    expect(projectsTasks.pluginId).toBe('examples.projects-tasks');
    expect(projectsTasks.manifest.contributes.accountCollections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'projects',
        serverReadable: ['title'],
      }),
      expect.objectContaining({
        id: 'tasks',
        serverReadable: ['title', 'status', 'dueAt', 'projectId'],
        indexes: [expect.objectContaining({
          id: 'byProjectAndStatus',
          fields: [
            { field: 'projectId', direction: 'asc' },
            { field: 'status', direction: 'asc' },
            { field: 'dueAt', direction: 'asc' },
          ],
        })],
        uiQueries: [expect.objectContaining({
          id: 'openByProject',
          indexId: 'byProjectAndStatus',
          parameters: { projectId: { kind: 'string', maxUtf8Bytes: 256 } },
          prefix: [
            { kind: 'parameter', parameterId: 'projectId' },
            { kind: 'literal', value: 'open' },
          ],
          order: 'asc',
          pageSize: 50,
          projectedFields: ['title', 'status', 'dueAt'],
        })],
      }),
    ]));

    expect(projectsTasks.manifest.contributes.ui.views).toContainEqual(expect.objectContaining({
      id: 'projects-and-tasks',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'projects-tasks-native',
      fallbackRenderers: ['projects-tasks-declarative'],
    }));
    expect(projectsTasks.manifest.contributes.ui.renderers).toContainEqual(expect.objectContaining({
      id: 'projects-tasks-native',
      kind: 'reactNative',
      artifact: 'projects-tasks-native',
      requiredHostMethods: ['context'],
    }));
    expect(projectsTasks.manifest.contributes.ui.renderers).toContainEqual({
      id: 'projects-tasks-declarative',
      kind: 'declarative',
      root: {
        kind: 'collectionList',
        source: {
          collectionId: 'tasks',
          uiQueryId: 'openByProject',
          parameters: { projectId: 'project-a' },
        },
        projection: {
          titleField: { field: 'title', kind: 'string' },
          detailField: { field: 'dueAt', kind: 'instant' },
          statusField: { field: 'status', kind: 'string' },
        },
      },
    });
  });

  it('normalizes the public Projects and Tasks declarative fallback through the admitted Account query', () => {
    const projectsTasks = readLoadedExamplePlugin(join(examplesRoot, 'projects-tasks'));
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [projectsTasks], diagnosticsByPluginId: {} },
      provenance: 'external',
    }));

    const model = resolveDeclarativeProjectionModels({ registry, generation: 11 })[
      'examples.projects-tasks\0projects-tasks-declarative'
    ];
    expect(model).toBeDefined();

    // The public example binds the exact normalized Data descriptor. The
    // declarative renderer receives no index/query grammar of its own and no
    // daemon-derived input: it consumes the already-admitted Account query.
    expect(model!.root).toMatchObject({
      kind: 'collectionList',
      source: {
        collectionId: 'tasks',
        uiQueryId: 'openByProject',
        parameters: { projectId: 'project-a' },
      },
      query: {
        collection: { pluginId: 'examples.projects-tasks', collectionId: 'tasks' },
        id: 'openByProject',
        indexId: 'byProjectAndStatus',
        parameters: { projectId: { kind: 'string', maxUtf8Bytes: 256 } },
        prefix: [
          { kind: 'parameter', parameterId: 'projectId' },
          { kind: 'literal', value: 'open' },
        ],
        order: 'asc',
        pageSize: 50,
        projectedFields: [
          { field: 'dueAt', kind: 'instant' },
          { field: 'status', kind: 'string' },
          { field: 'title', kind: 'string' },
        ],
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
        detailField: { field: 'dueAt', kind: 'instant' },
        statusField: { field: 'status', kind: 'string' },
      },
    });
  });

  it('normalizes through the CLI contribution registry projection', () => {
    const loadedPlugins = listInstallableExampleRoots().map(readLoadedExamplePlugin);
    expect(loadedPlugins.map((plugin) => plugin.pluginId).sort()).toEqual([
      'examples.background-indexer',
      'examples.descriptor-only',
      'examples.hosted-web',
      'examples.multi-mode-fallback',
      'examples.production-hosted-reference',
      'examples.projects-tasks',
      'examples.react-native-dev-hot-reload',
      'examples.react-native-installed',
    ]);

    const registry = buildPluginContributionRegistry({ loadedPlugins });

    // Not every installable example is a UI example — `examples.background-indexer`
    // authors a daemon background service and declares no views or renderers — so
    // the contract is that the projection carries exactly the UI-declaring examples,
    // dropping none and inventing none.
    const uiExamplePluginIds = loadedPlugins
      .filter((plugin) => (plugin.manifest.contributes.ui?.views?.length ?? 0) > 0)
      .map((plugin) => plugin.pluginId)
      .sort();
    expect(uiExamplePluginIds.length).toBeGreaterThan(0);
    expect(uiExamplePluginIds).not.toContain('examples.background-indexer');

    expect([...new Set(registry.uiViewsV2.map((entry) => entry.pluginId))].sort()).toEqual(uiExamplePluginIds);
    expect([...new Set(registry.uiRenderersV2.map((entry) => entry.pluginId))].sort()).toEqual(uiExamplePluginIds);
    // Retired V1 surface-placement declarations must not survive as an empty
    // compatibility field: V2 views are the only UI destination owner.
    expect(registry).not.toHaveProperty('surfacePlacements');
    expect(registry.hostedWeb).toEqual([]);
  });

  /**
   * EU-9 gate: the external declarative example is projected through the real
   * manifest normalizer, the real contribution registry and the real declarative
   * model evaluator — no hand-built model — so the approved §3.11 vocabulary is
   * proven end to end from an author-shaped package.
   */
  it('evaluates the external declarative example into app and session declarative models', () => {
    const loadedPlugins = listInstallableExampleRoots().map(readLoadedExamplePlugin);
    // The declarative evaluator consumes RESOLVED contributions (provenance and
    // source are load-bearing on a renderer), so the example walks the real
    // candidate-projection and resolution owners rather than the plugin-owned
    // half alone.
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: { loadedPlugins, diagnosticsByPluginId: {} },
      provenance: 'external',
    }));

    expect(registry.uiSettingsPagesV2?.filter((page) => page.pluginId === 'examples.descriptor-only')).toEqual([
      expect.objectContaining({
        identity: { pluginId: 'examples.descriptor-only', localId: 'settings' },
        definition: {
          id: 'settings',
          group: { kind: 'plugin', localId: 'descriptor-preferences' },
          title: 'Descriptor-only settings',
          renderer: 'settings-form',
        },
      }),
    ]);

    const declarativeViews = (registry.uiViewsV2 ?? []).filter((view) => view.pluginId === 'examples.descriptor-only');
    expect(declarativeViews.map((view) => ({
      container: view.definition.container,
      target: view.definition.target,
    }))).toEqual([{
      container: 'appPage',
      target: { kind: 'app' },
    }]);

    const models = resolveDeclarativeProjectionModels({ registry, generation: 11 });
    const settingsModel = models['examples.descriptor-only\0settings-form'];
    const listModel = models['examples.descriptor-only\0preview-list'];
    expect(settingsModel).toBeDefined();
    expect(listModel).toBeDefined();

    // Settings context: host-rendered controls plus markdown and a toned status.
    expect(settingsModel!.nodes.filter((node) => node.kind === 'field')).toHaveLength(2);
    expect(settingsModel!.nodes.some((node) => node.kind === 'markdown')).toBe(true);
    expect(settingsModel!.nodes.some((node) => node.kind === 'status' && node.tone === 'success')).toBe(true);

    // Session context: the whole approved list vocabulary evaluates, including
    // the empty/loading/error states.
    const kinds = new Set(listModel!.nodes.map((node) => node.kind));
    for (const kind of ['list', 'section', 'item', 'metadata', 'state', 'actionPanel', 'markdown', 'action']) {
      expect(kinds.has(kind as never), `declarative example must exercise '${kind}'`).toBe(true);
    }
    expect(listModel!.nodes.flatMap((node) => (node.kind === 'state' ? [node.state] : [])).sort())
      .toEqual(['empty', 'error', 'loading']);

    // A row action is qualified by the same owner as a standalone action, and
    // the destructive affordance keeps its declared variant so the renderer can
    // present it accessibly rather than by colour alone.
    const rowAction = listModel!.nodes.find((node) => node.kind === 'item' && node.action !== undefined);
    expect(rowAction).toMatchObject({
      kind: 'item',
      action: { qualifiedId: 'examples.descriptor-only/open-preview', generation: '11' },
    });
    expect(listModel!.nodes.some((node) => node.kind === 'action' && node.variant === 'destructive')).toBe(true);

    // The example stays far inside the node budget (plan §EU-9 bounds disposition).
    expect(listModel!.nodes.length).toBeLessThan(64);
  });
});
