import { mkdtemp, readFile, rm, symlink, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffoldLocalPlugin } from '../scaffold/scaffold';
import { packLocalPlugin } from './pack';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';
import { evaluatePluginAuthorSource } from '../authoring/sourceModule';
import { PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH } from '../authoring/daemonOutputManifest';
import { cleanupStagedNpmArtifactCandidate, stageDownloadedNpmArtifactCandidate } from '../distribution/npm/stage';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { writeManagedJavaScriptRuntimeFixture } from '@/testkit/process/managedJavaScriptRuntimeFixture';

async function writeSelectedPackage(root: string, sourcePreamble: readonly string[] = []): Promise<void> {
  const scaffold = await scaffoldLocalPlugin({
    targetDir: root,
    pluginId: 'acme.selected-plugin',
    displayName: 'Selected Plugin',
  });
  if (!scaffold.ok) {
    throw new Error(scaffold.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  await writeFile(scaffold.sourceEntryPath, [
    ...sourcePreamble,
    'export const manifest = {',
    "  schemaVersion: 2, id: 'acme.selected-plugin', version: '0.1.0',",
    "  displayName: 'Selected Plugin', engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },",
    "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
    '  contributes: {},',
    '};',
    'export function activate() {}',
    '',
  ].join('\n'), 'utf8');
  const packageJsonPath = join(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  packageJson.files = ['README.md'];
  // This fixture rewrites the scaffold source to have no SDK imports, but the
  // packed package contract still requires the canonical SDK runtime
  // dependency declaration, so the scaffold-emitted `dependencies` stay.
  delete packageJson.devDependencies;
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
  await writeFile(join(root, 'README.md'), '# Selected plugin\n', 'utf8');
  await writeFile(join(root, 'private-token.txt'), 'must-not-ship\n', 'utf8');
}

const execFileAsync = promisify(execFile);

async function writeSdkRegistryPackFixture(
  root: string,
  options?: Readonly<{ sdkVersion?: string }>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'happier-plugin-sdk-registry-pack-fixture',
    version: '1.0.0',
    type: 'module',
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['index.ts'],
    dependencies: { '@happier-dev/plugin-sdk': options?.sdkVersion ?? '0.0.0' },
  }, null, 2), 'utf8');
  await writeFile(join(root, 'index.ts'), [
    "import { definePlugin } from '@happier-dev/plugin-sdk';",
    'export const { manifest, activate } = definePlugin({',
    "  id: 'acme.sdk-registry-pack', version: '1.0.0',",
    "  displayName: 'SDK registry pack', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
    "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
    `  metadata: JSON.parse(${JSON.stringify('{"__proto__":{"inert":true},"ordinary":"preserved"}')}),`,
    '});',
    '',
  ].join('\n'), 'utf8');
}

describe('packLocalPlugin', () => {

  it('rejects an output path that physically resolves inside the plugin package root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-output-symlink-pack-'));
    const root = join(parent, 'plugin');
    const rootAlias = join(parent, 'plugin-alias');
    await writeSelectedPackage(root);
    await symlink(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(rootAlias, 'invalid.tgz'),
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: 'Plugin pack output must be outside the plugin package root',
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects an output path inside the package when its name begins with two dots', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-dot-prefixed-output-pack-'));
    const root = join(parent, 'plugin');
    await writeSelectedPackage(root);

    try {
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(root, '..build-output.tgz'),
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: 'Plugin pack output must be outside the plugin package root',
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('packLocalPlugin', () => {

  it('does not publish the authoring daemon-output marker from a code-defined whole metadata selection', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-code-defined-pack-marker-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'marker.tgz');
    try {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-marker-filter',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['.happier-plugin', 'index.ts'],
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }, null, 2), 'utf8');
      await writeFile(
        join(root, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        `${JSON.stringify({ version: 1, outputs: ['dist/source-owned.js'] })}\n`,
        'utf8',
      );
      await writeFile(join(root, 'index.ts'), [
        'export const manifest = {',
        "  version: '1.0.0', id: 'acme.marker-filter', schemaVersion: 2,",
        "  displayName: 'Marker Filter', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        '  contributes: {},',
        '};',
        'export function activate() {}',
        '',
      ].join('\n'), 'utf8');

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.marker-filter' });
      const archiveEntries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          archiveEntries.push(entry.path);
        },
      });
      expect(archiveEntries).toContain('package/.happier-plugin/plugin.json');
      expect(archiveEntries).not.toContain(
        `package/${PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH}`,
      );
      await expect(readFile(join(root, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH), 'utf8'))
        .resolves.toMatch(/source-owned\.js/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('statically evaluates, canonicalizes, and bundles a code-defined plugin without mutating its source tree', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-code-defined-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'code-defined.tgz');
    const extractedRoot = join(parent, 'extracted');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-acme-code-defined',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: {
          manifest: '.happier-plugin/plugin.json',
          compatibilityProjection: {
            version: 1,
            manifest: {
              schemaVersion: 2,
              id: 'acme.author-supplied-projection',
              version: '9.9.9',
              displayName: 'Forged projection',
              runtime: { apiVersion: 1 },
              contributes: {},
            },
            uiArtifacts: { version: 1, entries: [] },
            builtWith: { pluginSdk: '9999.0.0' },
          },
          marketplaceDiscovery: {
            version: 1,
            pluginId: 'acme.author-supplied-projection',
            manifestDigest: `sha256:${'a'.repeat(64)}`,
            display: { title: 'Forged projection', description: null },
            summary: {
              contributions: [],
              requiredHostAccess: [],
              optionalHostAccess: [],
              executableRealms: [],
            },
          },
        },
        files: ['a-note.txt', 'Z-note.txt', 'index.ts'],
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }, null, 2), 'utf8');
      await writeFile(join(root, 'a-note.txt'), 'a\n', 'utf8');
      await writeFile(join(root, 'Z-note.txt'), 'z\n', 'utf8');
      await writeFile(join(root, 'index.ts'), [
        "export const manifest = {",
        "  version: '1.0.0', id: 'acme.code-defined', schemaVersion: 2,",
        "  displayName: 'Code Defined', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        "  contributes: {},",
        "};",
        "export function activate() {}",
        '',
      ].join('\n'), 'utf8');

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.code-defined' });
      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      const packagedRoot = join(extractedRoot, 'package');
      const manifestBytes = await readFile(join(packagedRoot, '.happier-plugin', 'plugin.json'), 'utf8');
      const evaluated = await evaluatePluginAuthorSource({ locator: root });
      expect(manifestBytes).toBe(evaluated.canonicalManifestJson);
      expect(JSON.parse(manifestBytes)).toMatchObject({
        id: 'acme.code-defined',
        entrypoints: { daemon: './dist/index.js' },
      });
      const packagedPackageJson = JSON.parse(
        await readFile(join(packagedRoot, 'package.json'), 'utf8'),
      ) as {
        files?: unknown;
        happier?: Readonly<{
          compatibilityProjection?: unknown;
          marketplaceDiscovery?: unknown;
        }>;
      };
      expect(packagedPackageJson.files).toEqual([
        '.happier-plugin/plugin.json',
        'Z-note.txt',
        'a-note.txt',
        'dist/index.js',
        'index.ts',
      ]);
      expect(packagedPackageJson.happier?.compatibilityProjection).toMatchObject({
        version: 1,
        manifest: { id: 'acme.code-defined', version: '1.0.0' },
        uiArtifacts: { version: 2, entries: [] },
      });
      expect(packagedPackageJson.happier?.compatibilityProjection).not.toHaveProperty('builtWith');
      expect(packagedPackageJson.happier?.marketplaceDiscovery).toEqual({
        version: 1,
        pluginId: 'acme.code-defined',
        manifestDigest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
        display: { title: 'Code Defined', description: null },
        summary: {
          contributions: [],
          requiredHostAccess: [],
          optionalHostAccess: [],
          executableRealms: ['daemon'],
        },
      });
      const archiveEntries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          archiveEntries.push(entry.path);
        },
      });
      expect(archiveEntries).toEqual([
        'package/',
        'package/.happier-plugin/',
        'package/.happier-plugin/plugin.json',
        'package/Z-note.txt',
        'package/a-note.txt',
        'package/dist/',
        'package/dist/index.js',
        'package/index.ts',
        'package/package.json',
      ]);
      expect(await readFile(join(packagedRoot, 'dist', 'index.js'), 'utf8')).toContain('activate');
      await expect(readFile(join(root, '.happier-plugin', 'plugin.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(root, 'dist', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('returns the canonical manifest it already evaluated for a code-defined plugin', async () => {
    // `manifestPath` is the author entry for a code-defined plugin, so it is not
    // readable as manifest JSON. Consumers that need the manifest — the packed
    // author test selects its empty-input CLI action from it — must take the
    // canonical manifest from this owner instead of re-reading that path.
    const parent = await mkdtemp(join(tmpdir(), 'happier-code-defined-pack-manifest-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'code-defined.tgz');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-acme-code-defined',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['index.ts'],
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }, null, 2), 'utf8');
      await writeFile(join(root, 'index.ts'), [
        "export const manifest = {",
        "  version: '1.0.0', id: 'acme.code-defined', schemaVersion: 2,",
        "  displayName: 'Code Defined', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        "  contributes: {},",
        "};",
        "export function activate() {}",
        '',
      ].join('\n'), 'utf8');

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.manifestPath.endsWith(`${sep}index.ts`)).toBe(true);
      // The reported path must name the author tree the caller passed in, not
      // the operation-local copy. `tmpdir()` is a symlink on macOS, so a
      // relative mapping computed against the uncanonicalized copy root
      // escapes `packageRootPath` entirely.
      expect(result.manifestPath).toBe(join(result.packageRootPath, 'index.ts'));
      expect(result.manifest).toMatchObject({
        id: 'acme.code-defined',
        version: '1.0.0',
        contributes: expect.anything(),
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('packs every code-defined phase from one isolated source copy after author evaluation mutates the live tree', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-isolated-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'isolated.tgz');
    const extractedRoot = join(parent, 'extracted');
    const notePath = join(root, 'note.txt');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-acme-isolated-pack',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['index.ts', 'note.txt'],
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
      }, null, 2), 'utf8');
      await writeFile(notePath, 'copied-before-evaluation\n', 'utf8');
      await writeFile(join(root, 'index.ts'), [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(notePath)}, 'mutated-after-copy\\n', 'utf8');`,
        'export const manifest = {',
        "  version: '1.0.0', id: 'acme.isolated-pack', schemaVersion: 2,",
        "  displayName: 'Isolated pack', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        '  contributes: {},',
        '};',
        'export function activate() {}',
        '',
      ].join('\n'), 'utf8');

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.isolated-pack' });
      expect(await readFile(notePath, 'utf8')).toBe('mutated-after-copy\n');
      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      await expect(readFile(join(extractedRoot, 'package', 'note.txt'), 'utf8'))
        .resolves.toBe('copied-before-evaluation\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps the operation source outside an author parent whose replica removes remote-created pack directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-replica-managed-pack-source-'));
    const root = join(parent, 'plugin');
    const observationRoot = await mkdtemp(join(tmpdir(), 'happier-replica-managed-pack-observation-'));
    const parentListingsPath = join(observationRoot, 'parent-listings.jsonl');
    try {
      // Author evaluation runs inside the pack operation, after the operation
      // copy exists, so the author module itself records the author parent's
      // entries while that copy is live.
      await writeSelectedPackage(root, [
        "import { appendFileSync, readdirSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(parentListingsPath)}, JSON.stringify(readdirSync(${JSON.stringify(parent)}).sort()) + '\\n', 'utf8');`,
      ]);

      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'replica-managed.tgz'),
      });

      expect(result, result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.selected-plugin' });
      const parentListings = (await readFile(parentListingsPath, 'utf8')).trimEnd().split('\n');
      expect(parentListings.length).toBeGreaterThan(0);
      for (const listing of parentListings) {
        expect(JSON.parse(listing)).toEqual(['plugin']);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(observationRoot, { recursive: true, force: true });
    }
  });

  it('packs only the selected files into one npm-compatible artifact with its sha256 sidecar', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-selected-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'selected-plugin.tgz');
    await writeSelectedPackage(root);

    try {
      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          entries.push(entry.path);
        },
      });
      expect(entries).toContain('package/package.json');
      expect(entries).toContain('package/.happier-plugin/plugin.json');
      expect(entries).toContain('package/dist/index.js');
      expect(entries).not.toContain('package/src/index.ts');
      expect(entries).not.toContain('package/private-token.txt');
      expect(await readFile(`${archivePath}.sha256`, 'utf8')).toMatch(/^sha256:[a-f0-9]{64}  selected-plugin\.tgz\n$/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('stages without lifecycle scripts and runs the self-contained artifact through the binary-safe runtime with an empty PATH', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-self-contained-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'selected-plugin.tgz');
    const lifecycleMarker = 'lifecycle-script-ran.txt';
    let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;

    try {
      await writeSelectedPackage(root);
      const dependencyRoot = join(root, 'fixture-runtime-dependency');
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
        name: 'fixture-runtime-dependency',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }), 'utf8');
      await writeFile(join(dependencyRoot, 'index.js'), "export const suffix = 'bundled-runtime-dependency';\n", 'utf8');
      await writeFile(join(root, 'src', 'index.ts'), [
        "import { suffix } from 'fixture-runtime-dependency';",
        '',
        'export const manifest = {',
        "  schemaVersion: 2, id: 'acme.selected-plugin', version: '0.1.0',",
        "  displayName: 'Selected Plugin', engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        "  contributes: { actions: [{ id: 'save-note', title: 'Save note', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }] },",
        '};',
        'export async function saveNote(input) {',
        '  return { note: `${input.note}:${suffix}` };',
        '}',
        'export function activate(api) {',
        "  api.actions.register('save-note', saveNote);",
        '}',
        '',
      ].join('\n'), 'utf8');
      const packageJsonPath = join(root, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
      packageJson.scripts = {
        ...(packageJson.scripts as Record<string, string>),
        postinstall: `node -e "require('node:fs').writeFileSync('${lifecycleMarker}', 'ran')"`,
      };
      packageJson.dependencies = {
        ...(packageJson.dependencies as Record<string, string>),
        'fixture-runtime-dependency': 'file:./fixture-runtime-dependency',
      };
      await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
      const packed = await packLocalPlugin({ locator: root, outPath: archivePath });
      expect(packed, packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true });
      if (!packed.ok) return;
      await expect(readFile(
        join(root, 'node_modules', 'fixture-runtime-dependency', 'index.js'),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(join(root, 'node_modules'), { recursive: true, force: true });
      const archiveBytes = await readFile(archivePath);
      const stagingParentPath = join(parent, 'installed');
      await mkdir(stagingParentPath);
      staged = await stageDownloadedNpmArtifactCandidate({
        candidate: {
          source: {
            kind: 'npm',
            registryOrigin: 'https://qa-008.invalid',
            packageName: 'happier-plugin-acme-selected-plugin',
            version: '0.1.0',
            integrity: sriSha512(archiveBytes),
            tarballUrl: pathToFileURL(archivePath).href,
          },
          artifactPath: archivePath,
          byteLength: archiveBytes.byteLength,
          archiveDigestSha256: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
          registrySignature: { status: 'absent' },
          provenance: { status: 'absent' },
        },
        stagingParentPath,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;

      await rm(root, { recursive: true, force: true });
      expect(await readFile(join(staged.candidate.rootPath, 'package.json'), 'utf8')).toContain('postinstall');
      expect(staged.candidate.inventory.some((file) => file.path.startsWith('node_modules/'))).toBe(false);
      await expect(readFile(join(staged.candidate.rootPath, lifecycleMarker), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(staged.candidate.rootPath, 'node_modules', 'fixture-runtime-dependency', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const managedHome = join(parent, 'managed-home');
      const expectedRuntime = await writeManagedJavaScriptRuntimeFixture(managedHome);
      const runtimeEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPIER_HOME_DIR: managedHome,
        PATH: '',
      };
      delete runtimeEnv.HAPPIER_JS_RUNTIME_PATH;
      delete runtimeEnv.HAPPIER_MANAGED_NODE_BIN;
      delete runtimeEnv.HAPPIER_NODE_PATH;
      const runtime = resolveJavaScriptRuntimeExecutable({
        isBunRuntime: true,
        currentExecPath: join(parent, 'self-contained-happier'),
        processEnv: runtimeEnv,
      });
      expect(runtime).toBe(expectedRuntime);

      const entrypointUrl = pathToFileURL(join(staged.candidate.rootPath, 'dist', 'index.js')).href;
      const probe = [
        `const mod = await import(${JSON.stringify(entrypointUrl)});`,
        'let action;',
        "await mod.activate({ actions: { register(id, handler) { if (id === 'save-note') action = handler; } } });",
        "if (typeof action !== 'function') throw new Error('packed action was not registered');",
        "const result = await action({ note: 'qa-008' });",
        "if (result?.note !== 'qa-008:bundled-runtime-dependency') throw new Error('runtime dependency closure was not bundled');",
      ].join('\n');
      const execution = await execFileAsync(runtime!, ['--input-type=module', '--eval', probe], {
        cwd: staged.candidate.rootPath,
        env: runtimeEnv,
      });
      expect(execution.stderr).toBe('');
    } finally {
      if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects package metadata that cannot describe the canonical npm artifact contract', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-invalid-pack-'));
    const root = join(parent, 'plugin');
    await writeSelectedPackage(root);
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    delete packageJson.files;
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');

    try {
      const result = await packLocalPlugin({ locator: root, outPath: join(parent, 'invalid.tgz') });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('files') })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects a directly selected file reached through a symbolic-link ancestor', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-symlink-pack-'));
    const root = join(parent, 'plugin');
    const outside = join(parent, 'outside');
    await writeSelectedPackage(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.js'), 'export const secret = true;\n', 'utf8');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    packageJson.files = ['linked/secret.js'];
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');

    try {
      const result = await packLocalPlugin({ locator: root, outPath: join(parent, 'invalid.tgz') });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('symbolic link') })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('packLocalPlugin', () => {

  it('packs an unpublished-SDK author project through bundled prepublication materialization without a registry override', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-sdk-prepublication-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'prepublication-sdk.tgz');
    const extractedRoot = join(parent, 'extracted');
    try {
      await writeSdkRegistryPackFixture(root);
      const result = await packLocalPlugin({
        locator: root,
        outPath: archivePath,
      });

      // The author declares the prepublication SDK version, so the toolchain
      // materializes the bundled SDK instead of failing the install. That makes
      // this the one pack case evaluated against the real `definePlugin`.
      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.sdk-registry-pack' });
      if (!result.ok) return;
      expect(Object.getPrototypeOf(result.manifest.metadata)).toBe(Object.prototype);
      expect(Object.hasOwn(result.manifest.metadata!, '__proto__')).toBe(true);
      expect(result.manifest.metadata?.__proto__).toEqual({ inert: true });
      expect((Object.getPrototypeOf(result.manifest.metadata) as { inert?: unknown }).inert).toBeUndefined();
      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      const packedManifest = JSON.parse(
        await readFile(join(extractedRoot, 'package', '.happier-plugin', 'plugin.json'), 'utf8'),
      ) as { metadata?: Record<string, unknown> };
      expect(Object.getPrototypeOf(packedManifest.metadata)).toBe(Object.prototype);
      expect(Object.hasOwn(packedManifest.metadata!, '__proto__')).toBe(true);
      expect(packedManifest.metadata?.__proto__).toEqual({ inert: true });
      expect((Object.getPrototypeOf(packedManifest.metadata) as { inert?: unknown }).inert).toBeUndefined();
      await expect(readFile(join(root, 'node_modules', '@happier-dev', 'plugin-sdk', 'package.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it('packs the maintained public Session Agent example with its distinct named runner leaf', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-code-defined-session-agent-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'session-agent.tgz');
    const extractedRoot = join(parent, 'extracted');
    try {
      const maintainedExampleRoot = fileURLToPath(new URL(
        '../../../../../packages/plugin-sdk/examples/session-agent/',
        import.meta.url,
      ));
      await cp(maintainedExampleRoot, root, { recursive: true });

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'examples.session-agent' });
      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      const packagedRoot = join(extractedRoot, 'package');
      const activationModule = await import(pathToFileURL(join(packagedRoot, 'dist', 'index.js')).href) as Readonly<{
        activate(api: Readonly<{ agents: Readonly<{ register(id: string, factory: unknown): void }> }>): void;
      }>;
      const runnerModule = await import(pathToFileURL(
        join(packagedRoot, 'dist', 'agent', 'deterministicSessionAgent.js'),
      ).href) as Readonly<{
        createDeterministicSessionAgentRuntime: unknown;
      }>;
      let registeredFactory: unknown;
      activationModule.activate({
        agents: {
          register(_id, factory) {
            registeredFactory = factory;
          },
        },
      });
      expect(registeredFactory).toBe(runnerModule.createDeterministicSessionAgentRuntime);
      const packagedPackageJson = JSON.parse(
        await readFile(join(packagedRoot, 'package.json'), 'utf8'),
      ) as { files?: unknown };
      expect(packagedPackageJson.files).toContain('dist/agent/deterministicSessionAgent.js');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects the maintained Session Agent when addressed as a one-file plugin', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-single-file-session-agent-pack-'));
    const root = join(parent, 'plugin');
    try {
      await cp(fileURLToPath(new URL(
        '../../../../../packages/plugin-sdk/examples/session-agent/',
        import.meta.url,
      )), root, { recursive: true });

      const result = await packLocalPlugin({
        locator: join(root, 'index.ts'),
        outPath: join(parent, 'single-file-session-agent.tgz'),
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: expect.stringMatching(/distinct named runner leaf/u),
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a maintained Session Agent whose runner export no longer corresponds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-wrong-export-session-agent-pack-'));
    const root = join(parent, 'plugin');
    try {
      await cp(fileURLToPath(new URL(
        '../../../../../packages/plugin-sdk/examples/session-agent/',
        import.meta.url,
      )), root, { recursive: true });
      const activationPath = join(root, 'index.ts');
      const activationSource = await readFile(activationPath, 'utf8');
      await writeFile(
        activationPath,
        activationSource.replace(
          "export: 'createDeterministicSessionAgentRuntime'",
          "export: 'missingSessionAgentRuntime'",
        ),
        'utf8',
      );

      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'wrong-export-session-agent.tgz'),
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: expect.stringMatching(/runner factory export.*does not match/u),
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
