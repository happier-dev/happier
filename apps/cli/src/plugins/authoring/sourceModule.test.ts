import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createJiti } from 'jiti';
import { readWorkspacePackages, workspaceSourceCompilerPaths } from '@happier-dev/cli-common/sourceRuntimeEntries';
import { defineComposerReference, definePlugin, type JsonValue } from '@happier-dev/plugin-sdk';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';
import { classifyPluginAuthorDaemonBuild } from './toolchain';
import { resolvePluginAuthorWorkspaceAliases } from './hostSdkResolution';
import { evaluatePluginDevelopmentCandidate, evaluatePluginAuthorStagingSource, evaluatePluginAuthorSource, projectEvaluatedPluginDevelopmentSource, projectPluginAuthorModule, resolvePluginAuthorStagingModule, resolvePluginAuthoringSource, resolvePluginAuthorSourceEntrypoint } from './sourceModule';

function projectDefinedPlugin(defined: ReturnType<typeof definePlugin>) {
  return projectPluginAuthorModule({
    manifest: defined.manifest,
    activate: defined.activate,
    daemonDatabases: defined.daemonDatabases,
    collectionMigrations: defined.collectionMigrations,
  });
}

describe('plugin author source module owner', () => {
  it('keeps canonical workspace candidates on source exports across edits without loading stale dist', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'happier-devplug-source-workspace-'));
    const root = join(repo, 'packages/plugins/devplug');
    const dependency = join(repo, 'packages/devplug-protocol');
    const unrelated = join(repo, 'packages/devplug-unrelated');
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true });
      await mkdir(join(dependency, 'src'), { recursive: true });
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(repo, 'package.json'), '{"private":true}');
      await writeFile(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - packages/plugins/*\n');
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-devplug',
        dependencies: { '@happier-dev/devplug-protocol': '0.0.0' },
        devDependencies: { '@happier-dev/devplug-unrelated': '0.0.0' },
      }));
      await writeFile(join(unrelated, 'package.json'), JSON.stringify({
        name: '@happier-dev/devplug-unrelated',
        exports: { '.': { 'happier-source': './unused.ts' } },
      }));
      await writeFile(join(dependency, 'package.json'), JSON.stringify({
        name: '@happier-dev/devplug-protocol', type: 'module',
        exports: {
          '.': { 'happier-source': './src/index.ts', default: './stale.cjs' },
          ...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
            `./schema-${index}`, { 'happier-source': './src/index.ts', default: './stale.cjs' },
          ])),
        },
      }));
      await writeFile(join(dependency, 'stale.cjs'), 'throw new Error("stale dist must not load");');
      await symlink(dependency, join(root, 'node_modules/@happier-dev/devplug-protocol'), 'junction');
      const entrySource = [
        "import { marker } from '@happier-dev/devplug-protocol';",
        'export const actionContracts = { marker, revision: REVISION };',
        'export const manifest = { schemaVersion: 2, id: "example.devplug", version: "0.1.0", displayName: "Devplug",',
        'engines: { happier: ">=0.0.0" }, runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, contributes: {} };',
        'export function activate() {}',
      ].join('\n');
      await writeFile(join(dependency, 'src/index.ts'), 'export const marker: string = "source";');
      const aliases = await resolvePluginAuthorWorkspaceAliases(root);
      expect(aliases).not.toHaveProperty('@happier-dev/devplug-unrelated');
      expect(aliases['@happier-dev/devplug-protocol/schema-63']).toBe(join(dependency, 'src/index.ts'));
      let aliasTargetReads = 0;
      // Observe the real compiler boundary: recursively constructing a loader
      // must not re-normalize a terminal source-export table quadratically.
      const observedAliases = new Proxy(aliases, {
        get(target, key, receiver) {
          if (typeof key === 'string') aliasTargetReads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      createJiti(import.meta.url, { alias: observedAliases, fsCache: false });
      expect(aliasTargetReads).toBe(0);
      for (const revision of [1, 2]) {
        await writeFile(join(root, 'src/index.ts'), entrySource.replace('REVISION', String(revision)));
        const candidate = await evaluatePluginDevelopmentCandidate({
          locator: root,
          sourceAuthority: { kind: 'development', registeredRootId: 'workspace', canonicalRoot: root, observedRevision: revision },
        });
        expect(candidate.evaluated.actionContracts).toEqual({ marker: 'source', revision });
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it.each(['channels', 'channel-email'])('evaluates the current %s workspace with its source SDK and protocol', async (name) => {
    const root = fileURLToPath(new URL(`../../../../../packages/plugins/${name}/`, import.meta.url));
    const aliasStart = performance.now();
    const aliases = await resolvePluginAuthorWorkspaceAliases(root);
    console.info('DEVPLUG alias measurement', JSON.stringify({ name, elapsedMs: performance.now() - aliasStart, aliases: Object.keys(aliases).length }));
    if (name === 'channels') {
      const paths = workspaceSourceCompilerPaths(await readWorkspacePackages(fileURLToPath(new URL('../../../../../', import.meta.url))));
      const fullAliases = Object.fromEntries(Object.entries(paths).map(([specifier, targets]) => [specifier, targets[0]]));
      for (const [mode, table] of [['full-unnormalized', fullAliases], ['runtime-closure-normalized', aliases]] as const) {
        const constructions = [];
        for (let index = 0; index < 3; index += 1) {
          const start = performance.now();
          const cpuStart = process.cpuUsage();
          createJiti(import.meta.url, { alias: table, fsCache: false });
          constructions.push({ elapsedMs: performance.now() - start, cpu: process.cpuUsage(cpuStart) });
        }
        console.info('DEVPLUG construction measurement', JSON.stringify({ mode, aliases: Object.keys(table).length, constructions }));
      }
    }
    for (const observedRevision of [1, 2]) {
      const start = performance.now();
      const cpuStart = process.cpuUsage();
      let lastTick = start;
      let maxLagMs = 0;
      const heartbeat = setInterval(() => {
        const now = performance.now();
        maxLagMs = Math.max(maxLagMs, now - lastTick);
        lastTick = now;
      }, 10);
      try {
        const candidate = await evaluatePluginDevelopmentCandidate({
          locator: root,
          sourceAuthority: { kind: 'development', registeredRootId: 'devplug', canonicalRoot: root, observedRevision },
        });
        expect(candidate.evaluated.manifest.id).toBe(name === 'channels' ? 'happier.channels' : 'happier.channel.email');
        expect(typeof candidate.graph.module.activate).toBe('function');
      } finally {
        maxLagMs = Math.max(maxLagMs, performance.now() - lastTick);
        clearInterval(heartbeat);
        console.info('DEVPLUG candidate measurement', JSON.stringify({ name, observedRevision, elapsedMs: performance.now() - start, maxLagMs, cpu: process.cpuUsage(cpuStart) }));
      }
    }
  }, 120_000);

  it('admits the external Composer author manifest to the public daemon build path', async () => {
    const fixtureRoot = fileURLToPath(new URL('../../../../../packages/tests/fixtures/plugin-platform/composer-external-dogfood/', import.meta.url));
    const evaluated = await evaluatePluginAuthorSource({ locator: fixtureRoot });
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-author-manifest-'));
    try {
      await mkdir(join(root, '.happier-plugin'));
      await writeFile(join(root, '.happier-plugin/plugin.json'), evaluated.canonicalManifestJson, 'utf8');
      await expect(classifyPluginAuthorDaemonBuild(root)).resolves.toBe('required');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('diagnoses an executable protocol declaration spread into an Action through real source evaluation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-schema-diagnostic-'));
    const entryPath = join(root, 'plugin.ts');
    const source = (spreadDeclaration: boolean) => [
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      "import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';",
      "import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';",
      'const schema = defineProtocolObject({}, { policy: "closed" });',
      'const protocol = defineContributionProtocol({',
      '  id: "example.plugin/reads", version: 1, operations: { read: {',
      '    required: true, input: { kind: "protocolDefined", schema }, resultSchema: schema,',
      '    action: { surfaces: ["plugin"], dangerLevel: "safe" },',
      '  } },',
      '});',
      'const declaration = protocol.operations.read.declaration;',
      'export const { manifest, activate } = definePlugin({',
      '  id: "example.schema-diagnostic", version: "0.1.0", displayName: "Schema diagnostic",',
      '  actions: { read: { title: "Read",',
      spreadDeclaration
        ? '    ...declaration,'
        : '    surfaces: declaration.surfaces, dangerLevel: declaration.dangerLevel,',
      '    inputSchema: schema, resultSchema: schema, run: async () => ({}),',
      '  } },',
      '});',
    ].join('\n');
    await writeFile(entryPath, source(true), 'utf8');
    await expect(evaluatePluginAuthorSource({ locator: entryPath }))
      .rejects.toThrow(/value\.contributes\.actions\[0\]\.input\.schema\.parse must contain strict JSON data/u);
    const correctedEntryPath = join(root, 'corrected.ts');
    await writeFile(correctedEntryPath, source(false), 'utf8');
    const evaluated = await evaluatePluginAuthorSource({ locator: correctedEntryPath });
    expect(evaluated.manifest.contributes.actions[0]).toMatchObject({
      id: 'read', inputSchema: { type: 'object', additionalProperties: false },
    });
  });

  it('evaluates each source-in-place candidate in a fresh scope without an immutable generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-in-place-'));
    const entryPath = join(root, 'plugin.ts');
    const writeCandidate = async (marker: string) => {
      await writeFile(entryPath, [
        `export const actionContracts = { marker: '${marker}' };`,
        'export const manifest = {',
        "  schemaVersion: 2, id: 'example.in-place', version: '0.1.0', displayName: 'In place',",
        "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        'export function activate() {}',
      ].join('\n'), 'utf8');
    };

    try {
      await writeCandidate('first');
      const first = await evaluatePluginDevelopmentCandidate({
        locator: entryPath,
        sourceAuthority: {
          kind: 'development',
          registeredRootId: 'root-a',
          canonicalRoot: root,
          observedRevision: 1,
        },
      });
      await writeCandidate('second');
      const second = await evaluatePluginDevelopmentCandidate({
        locator: entryPath,
        sourceAuthority: {
          kind: 'development',
          registeredRootId: 'root-a',
          canonicalRoot: root,
          observedRevision: 2,
        },
      });

      expect(first.evaluated.actionContracts).toEqual({ marker: 'first' });
      expect(second.evaluated.actionContracts).toEqual({ marker: 'second' });
      expect(second.graph).toMatchObject({
        sourceAuthority: {
          kind: 'development',
          registeredRootId: 'root-a',
          observedRevision: 2,
        },
        rootPath: root,
        entryPath,
      });
      expect(second.graph).not.toHaveProperty('immutableGenerationId');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([['ts', 'js'], ['ts', 'mjs'], ['js', 'mjs'], ['mjs', 'js']] as const)('refreshes a mutable .%s entry re-exporting a .%s child with top-level await', async (entryExtension, extension) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-transitive-'));
    const entryPath = join(root, `index.${entryExtension}`);
    const childPath = join(root, `definition.${extension}`);
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', main: `./index.${entryExtension}` }));
    await writeFile(entryPath, `await Promise.resolve();\nexport { manifest, activate } from './definition.${extension}';\n`);
    const writeChild = async (title: string) => {
      await writeFile(childPath, [
        'await Promise.resolve();',
        'export const manifest = {',
        "  schemaVersion: 2, id: 'example.transitive', version: '0.1.0',",
        `  displayName: '${title}',`,
        "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        'export function activate() {}',
      ].join('\n'));
    };
    const candidate = (observedRevision: number) => evaluatePluginDevelopmentCandidate({
      locator: root,
      sourceAuthority: { kind: 'development', registeredRootId: root, canonicalRoot: root, observedRevision },
    });
    try {
      await writeChild('Before edit');
      const first = await candidate(1);
      await writeChild('After edit');
      const second = await candidate(2);
      await writeChild('Edited again');
      const third = await candidate(3);
      expect(first.evaluated.manifest.displayName).toBe('Before edit');
      expect(second.evaluated.manifest.displayName).toBe('After edit');
      expect(third.evaluated.manifest.displayName).toBe('Edited again');
      expect(second.graph.rootPath).toBe(await realpath(root));
      expect(second.graph.entryPath).toBe(await realpath(entryPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers a resolvable local SDK copy over the host alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-local-sdk-'));
    const entryPath = join(root, 'lone.ts');
    await writeFile(entryPath, [
      "export { actionContracts } from '@happier-dev/plugin-sdk';",
      'export const manifest = {',
      "  schemaVersion: 2, id: 'example.local-sdk', version: '0.1.0', displayName: 'Local SDK',",
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    const stubPackageRoot = join(root, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(join(stubPackageRoot, 'dist'), { recursive: true });
    await writeFile(join(stubPackageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    }), 'utf8');
    await writeFile(join(stubPackageRoot, 'dist', 'index.js'), 'export const actionContracts = { source: \'local-stub\' };\n', 'utf8');
    try {
      const evaluated = await evaluatePluginAuthorSource({ locator: entryPath });
      expect(evaluated.actionContracts).toEqual({ source: 'local-stub' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('guides non-SDK single-file imports to a declared package root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-lone-foreign-'));
    const entryPath = join(root, 'lone.ts');
    await writeFile(entryPath, [
      "import { nothing } from 'left-path';",
      'export const manifest = {',
      "  schemaVersion: 2, id: 'example.lone-foreign', version: '0.1.0', displayName: 'Lone foreign',",
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate() { void nothing; }',
      '',
    ].join('\n'), 'utf8');
    try {
      await expect(evaluatePluginAuthorSource({ locator: entryPath }))
        .rejects.toThrow(/package root/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not extend host SDK resolution to package-root development', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-pkg-host-'));
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'example.pkg-host',
      version: '0.1.0',
      type: 'module',
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
    }), 'utf8');
    await writeFile(join(packageRoot, 'src', 'index.ts'), [
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      'export const { manifest, activate } = definePlugin({',
      "  id: 'example.pkg-host', version: '0.1.0', displayName: 'Pkg host',",
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '});',
      '',
    ].join('\n'), 'utf8');
    try {
      // The package declares the SDK but nothing prepared it; the host alias
      // must not substitute for the declared dependency closure.
      await expect(evaluatePluginAuthorSource({ locator: packageRoot }))
        .rejects.toThrow(/@happier-dev\/plugin-sdk/);
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('resolves declared package-root dependencies through normal package semantics', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-author-pkg-declared-'));
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'example.pkg-declared',
      version: '0.1.0',
      type: 'module',
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
    }), 'utf8');
    await writeFile(join(packageRoot, 'src', 'index.ts'), [
      "export { actionContracts } from '@happier-dev/plugin-sdk';",
      'export const manifest = {',
      "  schemaVersion: 2, id: 'example.pkg-declared', version: '0.1.0', displayName: 'Pkg declared',",
      "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
      '  hostAccess: { required: [], optional: [] }, contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    const stubPackageRoot = join(packageRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(join(stubPackageRoot, 'dist'), { recursive: true });
    await writeFile(join(stubPackageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    }), 'utf8');
    await writeFile(join(stubPackageRoot, 'dist', 'index.js'), 'export const actionContracts = { source: \'declared-stub\' };\n', 'utf8');
    try {
      const evaluated = await evaluatePluginAuthorSource({ locator: packageRoot });
      expect(evaluated.manifest.id).toBe('example.pkg-declared');
      expect(evaluated.actionContracts).toEqual({ source: 'declared-stub' });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it('resolves every supported one-file extension and preserves directory entry rules without a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-source-'));
    try {
      const physicalRoot = await realpath(root);
      for (const extension of ['ts', 'mts', 'js', 'mjs'] as const) {
        const single = join(root, `single.${extension}`);
        await writeFile(single, 'export const value = true;\n', 'utf8');
        const physicalSingle = await realpath(single);
        await expect(resolvePluginAuthorSourceEntrypoint(single)).resolves.toMatchObject({
          kind: 'singleFile',
          entryPath: physicalSingle,
          packageRoot: physicalRoot,
        });
        await expect(resolvePluginAuthoringSource(single)).resolves.toMatchObject({
          ok: true,
          kind: 'code',
          entry: {
            kind: 'singleFile',
            entryPath: physicalSingle,
            packageRoot: physicalRoot,
          },
        });
      }

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

  it('resolves JavaScript package main at the directory boundary without requiring a development manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-js-package-'));
    try {
      await mkdir(join(root, 'src'));
      await mkdir(join(root, '.happier-plugin'));
      const entryPath = join(root, 'src', 'ledger.mjs');
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', main: './src/ledger.mjs' }));
      await writeFile(entryPath, [
        'export const manifest = {',
        "  schemaVersion: 2, id: 'example.js-package', version: '0.1.0', displayName: 'JS package',",
        "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '};',
        'export function activate() {}',
      ].join('\n'));
      // A generated descriptor must not divert a code author root into static discovery.
      await writeFile(join(root, '.happier-plugin', 'plugin.json'), '{ stale projection');
      await expect(resolvePluginAuthoringSource(root)).resolves.toMatchObject({
        ok: true, kind: 'code', entry: {
          kind: 'packageRoot', locator: await realpath(root),
          packageRoot: await realpath(root), entryPath: await realpath(entryPath),
        },
      });
      await expect(evaluatePluginAuthorSource({ locator: root })).resolves.toMatchObject({
        manifest: { id: 'example.js-package' }, entry: { kind: 'packageRoot' },
      });
      // The scaffold's author source wins over a built package entry.
      await writeFile(join(root, 'src', 'index.ts'), 'export {};');
      await expect(resolvePluginAuthorSourceEntrypoint(root)).resolves.toMatchObject({
        entryPath: await realpath(join(root, 'src', 'index.ts')),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the real external JavaScript fixture as a package-root author source', async () => {
    const root = fileURLToPath(new URL('../../../../../packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/', import.meta.url));
    await expect(resolvePluginAuthoringSource(root)).resolves.toMatchObject({
      ok: true, kind: 'code', entry: {
        kind: 'packageRoot', packageRoot: await realpath(root),
        entryPath: await realpath(join(root, 'src', 'index.mjs')),
      },
    });
  });

  it('rejects ambiguous roots and unsupported daemon source extensions', async () => {
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

      const cjs = join(root, 'plugin.cjs');
      await writeFile(cjs, 'module.exports = {};\n', 'utf8');
      await expect(resolvePluginAuthorSourceEntrypoint(cjs)).rejects.toMatchObject({
        code: 'plugin_author_entry_kind_unsupported',
      });

      const missingEntryRoot = join(root, 'missing-entry');
      await mkdir(missingEntryRoot);
      await expect(resolvePluginAuthorSourceEntrypoint(missingEntryRoot)).rejects.toMatchObject({
        code: 'plugin_author_entry_missing',
      });
      await writeFile(join(missingEntryRoot, 'package.json'), JSON.stringify({ main: './missing.mjs' }));
      await expect(resolvePluginAuthorSourceEntrypoint(missingEntryRoot)).rejects.toMatchObject({
        code: 'plugin_author_entry_missing', message: expect.stringContaining('package.json main'),
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

  it('keeps package author source authoritative beside stale or malformed generated manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-generated-manifest-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, '.happier-plugin'));
      const sourcePath = join(root, 'src', 'index.ts');
      const manifestPath = join(root, '.happier-plugin', 'plugin.json');
      await writeFile(sourcePath, 'export const manifest = {};\nexport function activate() {}\n', 'utf8');
      const generated = projectDefinedPlugin(definePlugin({
        id: 'example.generated-projection', version: '0.1.0',
      })).manifest;
      await writeFile(manifestPath, serializeCanonicalPluginManifest(generated), 'utf8');

      await expect(resolvePluginAuthoringSource(root)).resolves.toMatchObject({
        ok: true, kind: 'code', entry: { entryPath: await realpath(sourcePath) },
      });
      for (const locator of [manifestPath, join(root, '.happier-plugin')]) {
        await expect(resolvePluginAuthoringSource(locator)).resolves.toMatchObject({
          ok: true, kind: 'manifest', source: { manifest: { id: generated.id } },
        });
      }

      await writeFile(manifestPath, '{ malformed', 'utf8');
      await expect(resolvePluginAuthoringSource(root)).resolves.toMatchObject({
        ok: true, kind: 'code', entry: { entryPath: await realpath(sourcePath) },
      });
      await expect(resolvePluginAuthoringSource(manifestPath)).resolves.toMatchObject({ ok: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed canonical JSON in a descriptor-only package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-author-manifest-authority-'));
    try {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await writeFile(join(root, '.happier-plugin', 'plugin.json'), '{ malformed', 'utf8');

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
    expect(() => projectDefinedPlugin(defined)).toThrow(/value\.metadata\.callback must contain strict JSON data/u);
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

  it.each(['js', 'mjs'] as const)(
    'loads and re-evaluates a literal .%s development plugin through the canonical author source loader',
    async (extension) => {
      const root = await mkdtemp(join(tmpdir(), `happier-plugin-author-javascript-${extension}-`));
      const entryPath = join(root, `plugin.${extension}`);
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      const writeCandidate = async (marker: string) => {
        await writeFile(entryPath, [
          `export const actionContracts = { marker: '${marker}' };`,
          'export const manifest = {',
          `  schemaVersion: 2, id: 'example.javascript-${extension}', version: '0.1.0', displayName: 'JavaScript ${extension}',`,
          "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
          '  hostAccess: { required: [], optional: [] }, contributes: {},',
          '};',
          'export function activate() {}',
          '',
        ].join('\n'), 'utf8');
      };

      try {
        await writeCandidate('author-evaluation');
        await expect(evaluatePluginAuthorSource({ locator: entryPath })).resolves.toMatchObject({
          entry: { kind: 'singleFile', entryPath },
          manifest: { id: `example.javascript-${extension}` },
          actionContracts: { marker: 'author-evaluation' },
        });

        await writeCandidate('development-candidate');
        await expect(evaluatePluginDevelopmentCandidate({
          locator: entryPath,
          sourceAuthority: {
            kind: 'development',
            registeredRootId: `javascript-${extension}`,
            canonicalRoot: root,
            observedRevision: 2,
          },
        })).resolves.toMatchObject({
          evaluated: {
            entry: { kind: 'singleFile', entryPath },
            actionContracts: { marker: 'development-candidate' },
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('projects a contained runner leaf from source staging without fabricating generation custody', async () => {
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
      const owned = await evaluatePluginAuthorStagingSource({
        locator: entryPath,
        rootPath: root,
      });

      expect(owned.graph).not.toHaveProperty('immutableGenerationId');
      const runner = await resolvePluginAuthorStagingModule({
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
