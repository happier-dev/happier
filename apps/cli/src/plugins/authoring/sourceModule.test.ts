import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import {
  defineComposerReference,
  definePlugin,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';

import {
  evaluateOwnedPluginAuthorGeneration,
  evaluatePluginAuthorSource,
  projectEvaluatedPluginDevelopmentSource,
  projectPluginAuthorModule,
  resolveOwnedPluginAuthorGenerationModule,
  resolvePluginAuthoringSource,
  resolvePluginAuthorSourceEntrypoint,
} from './sourceModule';

function projectDefinedPlugin(defined: ReturnType<typeof definePlugin>) {
  return projectPluginAuthorModule({
    manifest: defined.manifest,
    activate: defined.activate,
    daemonDatabases: defined.daemonDatabases,
    collectionMigrations: defined.collectionMigrations,
  });
}

describe('plugin author source module owner', () => {
  it('resolves exact one-file and directory entry rules without a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-source-'));
    try {
      const single = join(root, 'single.ts');
      await writeFile(single, 'export const value = true;\n', 'utf8');
      const physicalRoot = await realpath(root);
      const physicalSingle = await realpath(single);
      await expect(resolvePluginAuthorSourceEntrypoint(single)).resolves.toMatchObject({
        kind: 'singleFile',
        entryPath: physicalSingle,
        packageRoot: physicalRoot,
      });

      const packageRoot = join(root, 'package');
      await mkdir(join(packageRoot, 'src'), { recursive: true });
      await writeFile(join(packageRoot, 'src', 'index.ts'), 'export const value = true;\n', 'utf8');
      const physicalPackageRoot = await realpath(packageRoot);
      const physicalPackageEntry = await realpath(join(packageRoot, 'src', 'index.ts'));
      await expect(resolvePluginAuthorSourceEntrypoint(packageRoot)).resolves.toMatchObject({
        kind: 'packageRoot',
        entryPath: physicalPackageEntry,
        packageRoot: physicalPackageRoot,
      });

      const rootEntryPackage = join(root, 'root-entry-package');
      await mkdir(rootEntryPackage);
      await writeFile(join(rootEntryPackage, 'index.ts'), 'export const value = true;\n', 'utf8');
      await expect(resolvePluginAuthorSourceEntrypoint(rootEntryPackage)).resolves.toMatchObject({
        kind: 'packageRoot',
        entryPath: await realpath(join(rootEntryPackage, 'index.ts')),
        packageRoot: await realpath(rootEntryPackage),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous roots and daemon TSX entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-ambiguous-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
      await writeFile(join(root, 'index.ts'), 'export {};\n', 'utf8');
      await expect(resolvePluginAuthorSourceEntrypoint(root)).rejects.toMatchObject({
        code: 'plugin_author_entry_ambiguous',
      });

      const tsx = join(root, 'plugin.tsx');
      await writeFile(tsx, 'export {};\n', 'utf8');
      await expect(resolvePluginAuthorSourceEntrypoint(tsx)).rejects.toMatchObject({
        code: 'plugin_author_entry_kind_unsupported',
      });

      const missingEntryRoot = join(root, 'missing-entry');
      await mkdir(missingEntryRoot);
      await expect(resolvePluginAuthorSourceEntrypoint(missingEntryRoot)).rejects.toMatchObject({
        code: 'plugin_author_entry_missing',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns the canonical missing-manifest diagnostic when a directory has no author entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-empty-'));
    try {
      await expect(resolvePluginAuthoringSource(root)).resolves.toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_manifest_missing' })],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never falls back to code-defined evaluation when canonical author JSON exists but is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-manifest-authority-'));
    try {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await writeFile(join(root, '.happier-plugin', 'plugin.json'), '{ malformed', 'utf8');
      await writeFile(join(root, 'index.ts'), 'export const manifest = {};\nexport function activate() {}\n', 'utf8');

      const resolved = await resolvePluginAuthoringSource(root);

      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'plugin_manifest_invalid' }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects only the named manifest/activate ABI into deterministic canonical JSON', () => {
    const activate = vi.fn();
    const projected = projectPluginAuthorModule({
      manifest: {
        version: '0.1.0',
        id: 'example.source',
        schemaVersion: 2,
        displayName: 'Source',
        engines: { happier: '>=0.0.0' },
        runtime: { apiVersion: 1 },
        hostAccess: { optional: [], required: [] },
        contributes: {},
      },
      activate,
      extra: 'inert',
      default: { ignored: true },
    });

    expect(projected.module.activate).toBe(activate);
    expect(projected.manifest.id).toBe('example.source');
    expect(projected.canonicalManifestJson).toBe(serializeCanonicalPluginManifest(projected.manifest));
    const reordered = projectPluginAuthorModule({
      activate,
      manifest: {
        contributes: {},
        hostAccess: { required: [], optional: [] },
        runtime: { apiVersion: 1 },
        engines: { happier: '>=0.0.0' },
        displayName: 'Source',
        schemaVersion: 2,
        version: '0.1.0',
        id: 'example.source',
      },
    });
    expect(reordered.canonicalManifestJson).toBe(projected.canonicalManifestJson);
    expect(() => projectPluginAuthorModule({
      default: { manifest: projected.manifest, activate },
    })).toThrow(/named manifest and activate exports/i);
  });

  it('normalizes raw and definePlugin-emitted manifest facts through the same canonical owner', () => {
    const activate = vi.fn();
    const defined = definePlugin({
      id: 'example.define-plugin-projection',
      version: '0.1.0',
      secrets: [{ id: 'api-token' }],
      actions: {
        inspect: {
          title: 'Inspect',
          execution: { target: 'daemon' },
          scopes: ['global'],
          surfaces: ['plugin'],
          dangerLevel: 'safe',
          run: async () => undefined,
        },
      },
    });
    const raw = {
      schemaVersion: 2,
      id: 'example.define-plugin-projection',
      version: '0.1.0',
      displayName: 'example.define-plugin-projection',
      runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      secrets: [{ id: 'api-token' }],
      contributes: {
        actions: [{
          id: 'inspect',
          title: 'Inspect',
          execution: { target: 'daemon' },
          scopes: ['global'],
          surfaces: ['plugin'],
          dangerLevel: 'safe',
        }],
      },
    };

    const rawProjection = projectPluginAuthorModule({ manifest: raw, activate });
    const definedProjection = projectPluginAuthorModule({
      manifest: defined.manifest,
      activate: defined.activate,
      daemonDatabases: defined.daemonDatabases,
      collectionMigrations: defined.collectionMigrations,
    });

    expect(definedProjection.manifest).toEqual(rawProjection.manifest);
    expect(definedProjection.canonicalManifestJson).toBe(rawProjection.canonicalManifestJson);
  });

  it('applies contribution defaults only when the source module ingests cold definePlugin facts', () => {
    const tasks = defineAccountCollection({
      id: 'tasks',
      schemaVersion: 1,
      schema: defineProtocolObject({
        id: defineProtocolString(),
      }, { policy: 'closed' }),
      identityFields: [],
      serverReadable: ['id'],
      indexes: [],
    });
    const defined = definePlugin({
      id: 'example.cold-contribution-defaults',
      version: '0.1.0',
      browserTargets: {
        docs: {
          title: 'Docs',
          url: 'https://example.com/docs',
          profile: 'session',
        },
      },
      composer: {
        references: {
          issues: defineComposerReference({
            title: 'Issues',
            icon: 'error',
            search: async () => [],
            resolve: async (candidateId) => ({
              id: candidateId,
              label: 'Issue',
              context: 'Issue reference',
            }),
          }),
        },
      },
      accountCollections: { tasks },
    });

    expect(defined.manifest.contributes.browserTargets).toEqual([{
      id: 'docs',
      title: 'Docs',
      url: 'https://example.com/docs',
      profile: 'session',
    }]);
    expect(defined.manifest.contributes.composerReferences).toEqual([{
      id: 'issues',
      title: 'Issues',
      icon: 'error',
    }]);
    const [coldAccountCollection] = defined.manifest.contributes.accountCollections ?? [];
    expect(coldAccountCollection).toBeDefined();
    expect(coldAccountCollection).not.toHaveProperty('rowIdField');
    expect(coldAccountCollection).not.toHaveProperty('uiQueries');
    expect(coldAccountCollection).not.toHaveProperty('relations');

    const projected = projectDefinedPlugin(defined);

    expect(projected.manifest.contributes.browserTargets).toEqual([{
      id: 'docs',
      title: 'Docs',
      url: 'https://example.com/docs',
      launch: 'newView',
      profile: 'session',
    }]);
    expect(projected.manifest.contributes.composerReferences).toEqual([{
      id: 'issues',
      title: 'Issues',
      icon: 'error',
      triggers: ['@'],
    }]);
    expect(projected.manifest.contributes.accountCollections[0]).toMatchObject({
      rowIdField: 'id',
      uiQueries: [],
      relations: [],
    });
  });

  it('leaves semantic manifest rejection to canonical source-module ingestion', () => {
    const defined = definePlugin({
      id: 'example.define-plugin-cold-validation',
      version: '0.1.0',
      resources: {
        progress: {
          source: 'dynamic',
          kind: 'config',
          contentType: 'application/vnd.happier.transcript-activity+json;v=1',
          maxBytes: 65_536,
          scope: 'global',
          runtime: {
            read: async () => new Uint8Array(),
            observe: () => ({ dispose: () => undefined }),
          },
        },
      },
      transcriptActivities: {
        progress: { resourceId: 'progress', actions: [] },
      },
    });

    expect((defined.manifest.contributes.resources ?? [])[0]).toMatchObject({ scope: 'global' });
    expect(() => projectDefinedPlugin(defined))
      .toThrow(/must reference a session-scoped dynamic Resource/u);
  });

  it('rejects cold HostAccess facts only when the source module reaches canonical manifest ingestion', () => {
    const defined = definePlugin({
      id: 'example.cold-host-access',
      version: '0.1.0',
      hostAccess: {
        required: [{
          id: 'intercept',
          capability: 'network.intercept',
          reason: 'Intercept requests',
          scope: { origins: ['https://example.com'] },
        }],
        optional: [],
      },
    } as unknown as Parameters<typeof definePlugin>[0]);

    expect(defined.manifest.hostAccess?.required?.[0]).toMatchObject({
      capability: 'network.intercept',
    });
    expect(() => projectDefinedPlugin(defined))
      .toThrow(/hostAccess\.required\.0\.capability/u);
  });

  it('rejects non-JSON cold facts only when the source module reaches canonical manifest ingestion', () => {
    const callback = () => undefined;
    const defined = definePlugin({
      id: 'example.cold-non-json',
      version: '0.1.0',
      metadata: { callback },
    } as unknown as Parameters<typeof definePlugin>[0]);

    expect(defined.manifest.metadata).toMatchObject({ callback });
    expect(() => projectDefinedPlugin(defined)).toThrow(/manifest is invalid/u);
  });

  it('rejects cold Brand Resource facts only when the source module reaches canonical manifest ingestion', () => {
    const defined = definePlugin({
      id: 'example.cold-brand-resource',
      version: '0.1.0',
      brand: { iconResourceId: 'brand-icon' },
      resources: {
        'brand-icon': {
          source: 'dynamic',
          kind: 'asset',
          contentType: 'image/png',
          scope: 'global',
          runtime: {
            read: async () => new Uint8Array(),
            observe: () => ({ dispose: () => undefined }),
          },
        },
      },
    });

    expect((defined.manifest.contributes.resources ?? [])[0]).toMatchObject({
      id: 'brand-icon',
      source: 'dynamic',
    });
    expect(() => projectDefinedPlugin(defined)).toThrow(/packaged image\/png asset/u);
  });

  it('admits and rejects targeted Surface facts only through canonical source-module ingestion', () => {
    const detailInput = defineProtocolObject({
      reviewId: defineProtocolString(),
    }, { policy: 'closed' });
    const protocol = defineContributionProtocol({
      id: 'review-detail',
      version: 1,
      operations: {},
      surfaces: {
        detail: {
          required: true,
          inputSchema: detailInput,
          presentation: 'content',
        },
      },
    });
    const node = protocol.surfaces.detail.node({
      pointId: 'details',
      contributor: { pluginId: 'com.acme.review', contributionId: 'detail' },
      input: { reviewId: 'review-42' },
      instanceKey: 'review-42',
    });
    const defineRendererPlugin = (root: unknown) => definePlugin({
      id: 'com.acme.review.surface',
      version: '0.1.0',
      ui: {
        renderers: [{
          id: 'review-detail',
          kind: 'declarative',
          root,
        }],
      },
    } as unknown as Parameters<typeof definePlugin>[0]);

    const admitted = defineRendererPlugin(node);
    const malformed = defineRendererPlugin({
      ...node,
      surface: {
        ...node.surface,
        point: {
          id: 'details',
          protocol: node.surface.point.protocol,
        },
      },
    });

    expect(() => projectDefinedPlugin(admitted)).not.toThrow();
    expect(() => projectDefinedPlugin(malformed)).toThrow(/Plugin author manifest is invalid/u);
  });

  it('projects an exact daemon-database callback map only when it matches the static manifest declaration', () => {
    const activate = vi.fn();
    const daemonDatabases = {
      index: {
        migrations: [{
          version: 1,
          id: 'create-index',
          up: async () => undefined,
        }],
        incumbentQueryFixture: {
          id: 'current-index-readable',
          run: async () => undefined,
        },
      },
    };
    const manifest = {
      version: '0.1.0',
      id: 'example.daemon-database',
      schemaVersion: 2,
      displayName: 'Daemon database',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      hostAccess: { optional: [], required: [] },
      contributes: {
        daemonDatabases: [{
          id: 'index',
          migrations: [{ version: 1, id: 'create-index' }],
          incumbentQueryFixtureId: 'current-index-readable',
        }],
      },
    };

    const projected = projectPluginAuthorModule({ manifest, activate, daemonDatabases });

    expect(projected.module.daemonDatabases).toEqual(daemonDatabases);
    expect(() => projectPluginAuthorModule({
      manifest,
      activate,
      daemonDatabases: {
        index: {
          ...daemonDatabases.index,
          migrations: [{ ...daemonDatabases.index.migrations[0], id: 'renamed-migration' }],
        },
      },
    })).toThrow(/daemon database.*migration/i);
  });

  it('carries the public Collection migration projection from an external author module only when its identities match', () => {
    const activate = vi.fn();
    const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
      ...value,
      status: 'open',
    }));
    const defined = definePlugin({
      id: 'example.collection-migrations',
      version: '0.1.0',
      accountCollections: {
        tasks: {
          id: 'tasks',
          schemaVersion: 2,
          readableSchemaVersions: [1],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 256 },
              status: { type: 'string', maxLength: 256 },
            },
            required: ['id', 'status'],
            additionalProperties: false,
          },
          serverReadable: ['id', 'status'],
          indexes: [],
          identityFields: [],
          migrations: [{
            id: 'upgrade-v1-to-v2',
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
            migrate,
          }],
        },
      },
    });

    const projected = projectPluginAuthorModule({
      manifest: defined.manifest,
      activate,
      collectionMigrations: defined.collectionMigrations,
    });

    expect(projected.module.collectionMigrations).toEqual(defined.collectionMigrations);
    expect(() => projectPluginAuthorModule({
      manifest: defined.manifest,
      activate,
      collectionMigrations: {
        tasks: [{
          ...defined.collectionMigrations.tasks![0],
          id: 'wrong-migration-id',
        }],
      },
    })).toThrow(/collection.*migration/i);
  });

  it('evaluates one resolved namespace once and returns that same activation identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-evaluate-'));
    try {
      const entryPath = join(root, 'plugin.mts');
      await writeFile(entryPath, 'export {};\n', 'utf8');
      const physicalEntryPath = await realpath(entryPath);
      const activate = vi.fn();
      const loadModule = vi.fn(async () => ({
        manifest: {
          schemaVersion: 2,
          id: 'example.once',
          version: '0.1.0',
          displayName: 'Once',
          engines: { happier: '>=0.0.0' },
          runtime: { apiVersion: 1 },
          hostAccess: { required: [], optional: [] },
          contributes: {},
        },
        activate,
      }));

      const evaluated = await evaluatePluginAuthorSource({ locator: entryPath, loadModule });

      expect(loadModule).toHaveBeenCalledOnce();
      expect(loadModule).toHaveBeenCalledWith(physicalEntryPath);
      expect(evaluated.module.activate).toBe(activate);
      expect(evaluated.entry.entryPath).toBe(physicalEntryPath);
      expect(evaluated.actionContracts).toBeUndefined();
      expect(projectEvaluatedPluginDevelopmentSource(evaluated).manifest.entrypoints?.development)
        .toBe('./plugin.mts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an escaping effective TypeScript config before loading author source', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-config-boundary-'));
    const packageRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(packageRoot, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(outsideRoot, 'marker.ts'), 'export const marker = true;\n', 'utf8');
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'escape/*': ['../outside/*'] },
      },
    }), 'utf8');
    const loadModule = vi.fn(async () => ({
      manifest: {
        schemaVersion: 2,
        id: 'example.config-boundary',
        version: '0.1.0',
        displayName: 'Config Boundary',
        engines: { happier: '>=0.0.0' },
        runtime: { apiVersion: 1 },
        hostAccess: { required: [], optional: [] },
        contributes: {},
      },
      activate: vi.fn(),
    }));

    try {
      await expect(evaluatePluginAuthorSource({ locator: packageRoot, loadModule }))
        .rejects.toThrow(/TypeScript config.*outside.*package root/u);
      expect(loadModule).not.toHaveBeenCalled();
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('loads the selected TypeScript module through the canonical loader owner', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/codeDefined.ts', import.meta.url));
    const evaluated = await evaluatePluginAuthorSource({ locator: fixturePath });

    expect(evaluated.manifest.id).toBe('example.source-loader');
    expect(evaluated.entry.entryPath).toBe(fixturePath);
    expect(typeof evaluated.module.activate).toBe('function');
  });

  it('projects a contained runner leaf structurally from its owned author generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-runner-leaf-'));
    const entryPath = join(root, 'index.ts');
    const runnerPath = join(root, 'runner.ts');
    await writeFile(entryPath, [
      'export const manifest = {',
      '  schemaVersion: 2,',
      "  id: 'example.runner-leaf',",
      "  version: '0.1.0',",
      "  displayName: 'Runner leaf',",
      "  engines: { happier: '>=0.0.0' },",
      '  runtime: { apiVersion: 1 },',
      '  hostAccess: { required: [], optional: [] },',
      '  contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(runnerPath, 'export function createRuntime() { return {}; }\n', 'utf8');

    try {
      const owned = await evaluateOwnedPluginAuthorGeneration({
        locator: entryPath,
        immutableGenerationId: 'gen-time-fixture',
        rootPath: root,
      });

      const runner = await resolveOwnedPluginAuthorGenerationModule({
        graph: owned.graph,
        module: './runner',
      });
      expect(runner).toMatchObject({
        normalizedModulePath: 'runner.ts',
        loadMode: 'source-ts',
      });
      expect(runner).not.toHaveProperty('moduleDigest');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('evaluates a contained TypeScript paths alias through the canonical loader', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-source-alias-'));
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'local/*': ['src/*'] },
      },
    }), 'utf8');
    await writeFile(join(packageRoot, 'src', 'metadata.ts'), "export const displayName = 'Aliased Source';\n", 'utf8');
    await writeFile(join(packageRoot, 'src', 'index.ts'), [
      "import { displayName } from 'local/metadata';",
      'export const manifest = {',
      '  schemaVersion: 2,',
      "  id: 'example.aliased-source',",
      "  version: '0.1.0',",
      '  displayName,',
      "  engines: { happier: '>=0.0.0' },",
      '  runtime: { apiVersion: 1 },',
      '  hostAccess: { required: [], optional: [] },',
      '  contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');

    try {
      await expect(evaluatePluginAuthorSource({ locator: packageRoot })).resolves.toMatchObject({
        manifest: {
          id: 'example.aliased-source',
          displayName: 'Aliased Source',
        },
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });
});
