import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';

import { evaluatePluginAuthorSource } from '../authoring/sourceModule';
import { PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH } from '../authoring/daemonOutputManifest';
import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { createTestNpmTarball, sriSha512 } from '../distribution/testkit/npmTarball';
import { createTestPluginSdkTarball } from '../distribution/testkit/pluginSdkTarball';
import { scaffoldLocalPlugin } from '../scaffold/scaffold';
import { createPluginManifestV2Fixture } from '../testkit/manifestV2Fixture';
import {
  startCandidateRegistry,
} from '../../../../../packages/tests/scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { packLocalPlugin } from './pack';

const execFileAsync = promisify(execFile);

async function writeSelectedPackage(root: string): Promise<void> {
  const scaffold = await scaffoldLocalPlugin({
    targetDir: root,
    pluginId: 'acme.selected-plugin',
    displayName: 'Selected Plugin',
  });
  if (!scaffold.ok) {
    throw new Error(scaffold.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  await writeFile(scaffold.sourceEntryPath, [
    'export const manifest = {',
    "  schemaVersion: 2, id: 'acme.selected-plugin', version: '0.1.0',",
    "  displayName: 'Selected Plugin', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },",
    "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
    '  contributes: {},',
    '};',
    'export function activate() {}',
    '',
  ].join('\n'), 'utf8');
  const packageJsonPath = join(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  packageJson.files = ['README.md'];
  // This fixture rewrites the scaffold source to have no SDK imports. Its
  // package contract therefore needs no registry dependency when pack prepares
  // the operation-local author copy.
  delete packageJson.dependencies;
  delete packageJson.devDependencies;
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
  await writeFile(join(root, 'README.md'), '# Selected plugin\n', 'utf8');
  await writeFile(join(root, 'private-token.txt'), 'must-not-ship\n', 'utf8');
}

async function writeManagedRuntimeFixture(homeDir: string): Promise<string> {
  const binDir = join(homeDir, 'tools', 'js-runtime', 'current', 'bin');
  const runtimeDir = join(homeDir, 'tools', 'js-runtime', 'current', 'runtime');
  const wrapperPath = join(binDir, process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
  const runtimePath = process.platform === 'win32'
    ? join(runtimeDir, 'node.exe')
    : join(runtimeDir, 'bin', 'node');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(runtimePath, '..'), { recursive: true });
  if (process.platform === 'win32') {
    await copyFile(process.execPath, runtimePath);
    await writeFile(wrapperPath, '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n', 'utf8');
  } else {
    await symlink(process.execPath, runtimePath);
    await writeFile(wrapperPath, '#!/bin/sh\nexec "${0%/*}/../runtime/bin/node" "$@"\n', 'utf8');
    await chmod(wrapperPath, 0o755);
  }
  return wrapperPath;
}

async function startCandidateSdkRegistry(params: Readonly<{
  sdkTarball: Buffer;
}>): Promise<Readonly<{
  origin: string;
  close(): Promise<void>;
}>> {
  const registry = await startCandidateRegistry({
    packages: [{
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: sriSha512(params.sdkTarball),
      bytes: params.sdkTarball,
    }],
  });
  return Object.freeze({
    origin: registry.origin,
    close: async () => await registry.close(),
  });
}

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
    '});',
    '',
  ].join('\n'), 'utf8');
}

async function createCandidateChannelsProtocolTarball(): Promise<Buffer> {
  return await createTestNpmTarball([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: '@happier-dev/channels-protocol',
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './v1': './v1/index.js',
          './testing/v1': './testing/v1/index.js',
        },
      }),
    },
    {
      name: 'package/index.js',
      body: "export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';\n",
    },
    {
      name: 'package/v1/index.js',
      body: "export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';\n",
    },
    {
      name: 'package/testing/v1/index.js',
      body: 'export function createConversationProviderSetupResultV1Fixture() { return {}; }\n',
    },
  ]);
}

async function writeBundledFirstPartyPackFixture(repoRoot: string): Promise<Readonly<{
  packageRoot: string;
  packageJsonPath: string;
}>> {
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'channel-telegram');
  const packageJsonPath = join(packageRoot, 'package.json');
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'plugin-sdk'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'channels-protocol'), { recursive: true });
  await mkdir(join(packageRoot, 'src'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(join(repoRoot, 'package.json'), JSON.stringify({ private: true }), 'utf8'),
    writeFile(join(repoRoot, 'yarn.lock'), '', 'utf8'),
    writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0',
      bundledDependencies: [
        '@happier-dev/channels-protocol',
        '@happier-dev/plugin-sdk',
        '@happier-dev/plugins-channel-telegram',
      ],
    }, null, 2), 'utf8'),
    writeFile(join(repoRoot, 'packages', 'plugin-sdk', 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    }), 'utf8'),
    writeFile(join(repoRoot, 'packages', 'channels-protocol', 'package.json'), JSON.stringify({
      name: '@happier-dev/channels-protocol',
      version: '0.0.0',
    }), 'utf8'),
    writeFile(packageJsonPath, JSON.stringify({
      name: '@happier-dev/plugins-channel-telegram',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      files: ['dist', 'package.json'],
      dependencies: {
        '@happier-dev/channels-protocol': '0.0.0',
        '@happier-dev/plugin-sdk': '0.0.0',
      },
    }, null, 2), 'utf8'),
    writeFile(join(packageRoot, 'dist', 'index.js'), 'export const stale = true;\n', 'utf8'),
    writeFile(join(packageRoot, 'dist', 'index.d.ts'), 'export declare const stale: true;\n', 'utf8'),
    writeFile(join(packageRoot, 'src', 'index.ts'), [
      "import { CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 } from '@happier-dev/channels-protocol';",
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      '',
      'export const { manifest, activate } = definePlugin({',
      "  id: 'happier.channel.telegram', version: '0.0.0',",
      '  displayName: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1, engines: { happier: \'>=0.0.0\' }, runtime: { apiVersion: 1 },',
      "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
      '});',
      '',
    ].join('\n'), 'utf8'),
  ]);
  return Object.freeze({ packageRoot, packageJsonPath });
}

async function writeBundledFirstPartyDescriptorPackFixture(repoRoot: string): Promise<Readonly<{
  packageRoot: string;
}>> {
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'channels');
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await Promise.all([
    writeFile(join(repoRoot, 'package.json'), JSON.stringify({ private: true }), 'utf8'),
    writeFile(join(repoRoot, 'yarn.lock'), '', 'utf8'),
    writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0',
      bundledDependencies: ['@happier-dev/plugins-channels'],
    }, null, 2), 'utf8'),
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-channels',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      files: ['dist', '.happier-plugin', 'package.json'],
    }, null, 2), 'utf8'),
    writeFile(join(packageRoot, 'dist', 'index.js'), 'export const bundled = true;\n', 'utf8'),
    writeFile(join(packageRoot, '.happier-plugin', 'daemon.js'), 'export function activate() {}\n', 'utf8'),
    writeFile(
      join(packageRoot, '.happier-plugin', 'plugin.json'),
      `${JSON.stringify(createPluginManifestV2Fixture({
        id: 'happier.channels',
        version: '0.0.0',
        displayName: 'Channels',
        // The bundled release stamp, exactly as the shipped descriptor carries
        // it: a range the running development CLI never satisfies.
        engines: { happier: '^0.0.0' },
        entrypoints: { daemon: './.happier-plugin/daemon.js' },
      }))}\n`,
      'utf8',
    ),
  ]);
  return Object.freeze({ packageRoot });
}

describe('packLocalPlugin', () => {
  it('removes only manifest-owned outputs from a descriptor-only pack copy before archive traversal', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-descriptor-transition-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'descriptor-transition.tgz');
    try {
      await mkdir(join(root, '.happier-plugin'), { recursive: true });
      await mkdir(join(root, 'dist', '.happier-chunks'), { recursive: true });
      await mkdir(join(root, 'dist', 'actions'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-descriptor-transition',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['.happier-plugin/plugin.json', 'dist'],
      }, null, 2), 'utf8');
      await writeFile(
        join(root, '.happier-plugin', 'plugin.json'),
        `${JSON.stringify(createPluginManifestV2Fixture({
          id: 'acme.descriptor-transition',
          entrypoints: undefined,
        }))}\n`,
        'utf8',
      );
      await writeFile(join(root, 'dist', 'daemon.js'), 'stale daemon output\n', 'utf8');
      await writeFile(join(root, 'dist', 'source-owned.js'), 'stale custom daemon output\n', 'utf8');
      await writeFile(join(root, 'dist', 'index.js'), 'fresh descriptor output\n', 'utf8');
      await writeFile(join(root, 'dist', '.happier-chunks', 'chunk-stale.js'), 'stale chunk output\n', 'utf8');
      await writeFile(
        join(root, 'dist', 'actions', 'index.js'),
        'export const authorOwned = true;\n',
        'utf8',
      );
      await writeFile(
        join(root, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        `${JSON.stringify({ version: 1, outputs: ['dist/source-owned.js'] })}\n`,
        'utf8',
      );

      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.descriptor-transition' });
      const archiveEntries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          archiveEntries.push(entry.path);
        },
      });
      expect(archiveEntries).toContain('package/dist/daemon.js');
      expect(archiveEntries).not.toContain('package/dist/source-owned.js');
      expect(archiveEntries).toContain('package/dist/index.js');
      expect(archiveEntries).toContain('package/dist/.happier-chunks/chunk-stale.js');
      expect(archiveEntries).toContain('package/dist/actions/index.js');
      await expect(readFile(join(root, 'dist', 'index.js'), 'utf8'))
        .resolves.toBe('fresh descriptor output\n');
      await expect(readFile(join(root, 'dist', 'source-owned.js'), 'utf8'))
        .resolves.toBe('stale custom daemon output\n');
      await expect(readFile(join(root, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH), 'utf8'))
        .resolves.toMatch(/source-owned\.js/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

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

  it('rejects and redacts a credential-bearing SDK registry override before author preparation', async () => {
    const secret = 'sdk-registry-secret';
    const result = await packLocalPlugin({
      locator: '/fixture/plugin',
      sdkRegistryOrigin: `https://author:${secret}@registry.example.test`,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        message: 'Plugin SDK registry must be a credential-free HTTPS origin or loopback HTTP origin',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
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
        uiArtifacts: { version: 1, entries: [] },
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

      expect(result.ok).toBe(true);
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

  it('packs an unpublished-SDK author project through bundled prepublication materialization without a registry override', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-sdk-prepublication-pack-'));
    const root = join(parent, 'plugin');
    try {
      await writeSdkRegistryPackFixture(root);
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'prepublication-sdk.tgz'),
      });

      // The author declares the prepublication SDK version, so the toolchain
      // materializes the bundled SDK instead of failing the install. That makes
      // this the one pack case evaluated against the real `definePlugin`.
      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.sdk-registry-pack' });
      await expect(readFile(join(root, 'node_modules', '@happier-dev', 'plugin-sdk', 'package.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it('returns the managed author-install failure when the supplied SDK registry cannot serve the declared version', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-sdk-registry-pack-missing-'));
    const root = join(parent, 'plugin');
    const registry = await startCandidateSdkRegistry({ sdkTarball: await createTestPluginSdkTarball() });
    try {
      await writeSdkRegistryPackFixture(root, { sdkVersion: '9999.0.0' });
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'missing-sdk.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('Plugin author install failed') })],
      });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('packs a bundled first-party provider through the canonical candidate registry without changing its source metadata', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-bundled-first-party-pack-'));
    const fixture = await writeBundledFirstPartyPackFixture(parent);
    const [sdkTarball, channelsProtocolTarball] = await Promise.all([
      createTestPluginSdkTarball(),
      createCandidateChannelsProtocolTarball(),
    ]);
    const registry = await startCandidateRegistry({
      packages: [
        {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: sriSha512(sdkTarball),
          bytes: sdkTarball,
        },
        {
          packageName: '@happier-dev/channels-protocol',
          version: '0.0.0',
          integrity: sriSha512(channelsProtocolTarball),
          bytes: channelsProtocolTarball,
        },
      ],
    });
    try {
      const result = await packLocalPlugin({
        locator: fixture.packageRoot,
        outPath: join(parent, 'bundled-first-party.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'happier.channel.telegram' });
      const sourcePackageJson = JSON.parse(await readFile(fixture.packageJsonPath, 'utf8')) as Record<string, unknown>;
      expect(sourcePackageJson).not.toHaveProperty('keywords');
      expect(sourcePackageJson).not.toHaveProperty('happier');

      const extractedRoot = join(parent, 'bundled-first-party-extracted');
      await mkdir(extractedRoot);
      await tar.x({ file: join(parent, 'bundled-first-party.tgz'), cwd: extractedRoot });
      const packedPackageJson = JSON.parse(
        await readFile(join(extractedRoot, 'package', 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(packedPackageJson).toMatchObject({
        name: '@happier-dev/plugins-channel-telegram',
        version: '0.0.0',
      });
      expect(packedPackageJson).not.toHaveProperty('keywords');
      expect(packedPackageJson).not.toHaveProperty('happier');
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not infer bundled first-party authority from a package name outside the canonical workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-noncanonical-first-party-pack-'));
    const fixture = await writeBundledFirstPartyPackFixture(parent);
    const outsidePackageRoot = join(parent, 'outside-package');
    await cp(fixture.packageRoot, outsidePackageRoot, { recursive: true });
    const [sdkTarball, channelsProtocolTarball] = await Promise.all([
      createTestPluginSdkTarball(),
      createCandidateChannelsProtocolTarball(),
    ]);
    const registry = await startCandidateRegistry({
      packages: [
        {
          packageName: '@happier-dev/plugin-sdk',
          version: '0.0.0',
          integrity: sriSha512(sdkTarball),
          bytes: sdkTarball,
        },
        {
          packageName: '@happier-dev/channels-protocol',
          version: '0.0.0',
          integrity: sriSha512(channelsProtocolTarball),
          bytes: channelsProtocolTarball,
        },
      ],
    });
    try {
      const result = await packLocalPlugin({
        locator: outsidePackageRoot,
        outPath: join(parent, 'noncanonical-first-party.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('happier-plugin keyword') })],
      });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('packs a bundled first-party descriptor package whose canonical manifest is read before staging', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-bundled-first-party-descriptor-pack-'));
    const fixture = await writeBundledFirstPartyDescriptorPackFixture(parent);
    try {
      const result = await packLocalPlugin({
        locator: fixture.packageRoot,
        outPath: join(parent, 'bundled-first-party-descriptor.tgz'),
      });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'happier.channels', version: '0.0.0' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('still rejects a reserved-namespace descriptor package outside the canonical bundled workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-noncanonical-descriptor-pack-'));
    const fixture = await writeBundledFirstPartyDescriptorPackFixture(parent);
    const outsidePackageRoot = join(parent, 'outside-package');
    await cp(fixture.packageRoot, outsidePackageRoot, { recursive: true });
    try {
      const result = await packLocalPlugin({
        locator: outsidePackageRoot,
        outPath: join(parent, 'noncanonical-descriptor.tgz'),
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [
          expect.objectContaining({ message: expect.stringContaining("reserved happier.* namespace") }),
          expect.objectContaining({ message: expect.stringContaining('compatible Happier CLI version') }),
        ],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('packs an isolated package-root author project through its supplied SDK registry', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-sdk-registry-pack-success-'));
    const root = join(parent, 'plugin');
    const registry = await startCandidateSdkRegistry({ sdkTarball: await createTestPluginSdkTarball() });
    try {
      await writeSdkRegistryPackFixture(root);
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'candidate-sdk.tgz'),
        sdkRegistryOrigin: registry.origin,
      });

      expect(result, result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.sdk-registry-pack' });
      await expect(readFile(join(root, 'node_modules', '@happier-dev', 'plugin-sdk', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps the operation source outside an author parent whose replica removes remote-created pack directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-replica-managed-pack-source-'));
    const root = join(parent, 'plugin');
    const sourceTreeOperationEntries: string[] = [];
    const watcher = watch(parent, (_event, entryName) => {
      const entry = entryName?.toString();
      if (entry?.startsWith('.happier-plugin-pack-source-')) {
        sourceTreeOperationEntries.push(entry);
      }
    });
    try {
      await writeSelectedPackage(root);

      const result = await packLocalPlugin({
        locator: root,
        outPath: join(parent, 'replica-managed.tgz'),
      });

      expect(result, result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.selected-plugin' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sourceTreeOperationEntries).toEqual([]);
    } finally {
      watcher.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps one-file authoring simple and packs a package-root Session Agent with a distinct named runner leaf', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-code-defined-session-agent-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'session-agent.tgz');
    const extractedRoot = join(parent, 'extracted');
    try {
      await mkdir(join(root, 'agent'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'happier-plugin-acme-session-agent',
        version: '1.0.0',
        type: 'module',
        keywords: ['happier-plugin'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        files: ['index.ts', 'agent/runtime.ts'],
      }, null, 2), 'utf8');
      await writeFile(join(root, 'agent', 'runtime.ts'), [
        'export const createSessionAgentRuntime = () => ({',
        '  sessions: { open() { throw new Error("unused"); } },',
        '});',
        '',
      ].join('\n'), 'utf8');
      const activationSource = [
        "import { createSessionAgentRuntime } from './agent/runtime.js';",
        'export const manifest = {',
        "  version: '1.0.0', id: 'acme.session-agent', schemaVersion: 2,",
        "  displayName: 'Session Agent', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
        '  contributes: { agents: [{',
        "    id: 'session-agent', title: 'Session Agent', runtime: { kind: 'custom' }, primary: 'sessions',",
        "    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },",
        '  }] },',
        '};',
        'export function activate(api) {',
        "  api.agents.register('session-agent', createSessionAgentRuntime, {",
        '    sessionRunnerFactory: {',
        "      module: './agent/runtime.js', export: 'createSessionAgentRuntime', runtimeApiVersion: 1,",
        '    },',
        '  });',
        '}',
        '',
      ].join('\n');
      await writeFile(join(root, 'index.ts'), activationSource, 'utf8');

      const singleFileResult = await packLocalPlugin({
        locator: join(root, 'index.ts'),
        outPath: join(parent, 'single-file-session-agent.tgz'),
      });
      expect(singleFileResult).toMatchObject({ ok: false });

      const wrongExportRoot = join(parent, 'wrong-export-plugin');
      await cp(root, wrongExportRoot, { recursive: true });
      await writeFile(
        join(wrongExportRoot, 'index.ts'),
        activationSource.replace(
          "export: 'createSessionAgentRuntime'",
          "export: 'missingSessionAgentRuntime'",
        ),
        'utf8',
      );
      const wrongExportResult = await packLocalPlugin({
        locator: wrongExportRoot,
        outPath: join(parent, 'wrong-export-session-agent.tgz'),
      });
      expect(wrongExportResult).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: expect.stringMatching(/runner factory export.*does not match/u),
        })],
      });
      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result, result.ok ? '' : result.diagnostics.map((entry) => entry.message).join('\n'))
        .toMatchObject({ ok: true, pluginId: 'acme.session-agent' });
      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      const packagedRoot = join(extractedRoot, 'package');
      const activationModule = await import(pathToFileURL(join(packagedRoot, 'dist', 'index.js')).href) as Readonly<{
        activate(api: Readonly<{ agents: Readonly<{ register(id: string, factory: unknown): void }> }>): void;
      }>;
      const runnerModule = await import(pathToFileURL(join(packagedRoot, 'dist', 'agent', 'runtime.js')).href) as Readonly<{
        createSessionAgentRuntime: unknown;
      }>;
      let registeredFactory: unknown;
      activationModule.activate({
        agents: {
          register(_id, factory) {
            registeredFactory = factory;
          },
        },
      });
      expect(registeredFactory).toBe(runnerModule.createSessionAgentRuntime);
      const packagedPackageJson = JSON.parse(
        await readFile(join(packagedRoot, 'package.json'), 'utf8'),
      ) as { files?: unknown };
      expect(packagedPackageJson.files).toContain('dist/agent/runtime.js');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('packs and stages a dependency-closed external Voice provider artifact', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-packed-voice-'));
    const archivePath = join(parent, 'packed-voice.tgz');
    const installRoot = join(parent, 'installed');
    const fixtureRoot = fileURLToPath(new URL('../testkit/fixtures/packed-external-voice-provider', import.meta.url));
    let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;
    try {
      const packed = await packLocalPlugin({ locator: fixtureRoot, outPath: archivePath });
      expect(packed, packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n')).toMatchObject({ ok: true });
      if (!packed.ok) return;
      expect(packed).not.toHaveProperty('manifestDigest');
      const archiveBytes = await readFile(archivePath);
      await mkdir(installRoot);
      staged = await stageDownloadedNpmArtifactCandidate({
        candidate: {
          source: {
            kind: 'npm', registryOrigin: 'https://packed-voice.invalid',
            packageName: 'happier-plugin-acme-packed-voice', version: '1.0.0',
            integrity: sriSha512(archiveBytes), tarballUrl: pathToFileURL(archivePath).href,
          },
          artifactPath: archivePath,
          byteLength: archiveBytes.byteLength,
          archiveDigestSha256: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
          registrySignature: { status: 'absent' },
          provenance: { status: 'absent' },
        },
        stagingParentPath: installRoot,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(staged.candidate.manifest.value.entrypoints).toEqual({
        daemon: './dist/daemon.js',
      });
      expect(staged.candidate.inventory.map(({ path }) => path)).toEqual(expect.arrayContaining([
        'dist/daemon.js',
        'dist/happier-plugin-ui/react-native/voice-runtime-web/index.js',
      ]));
      const packedExecutableSources = await Promise.all([
        readFile(join(staged.candidate.rootPath, 'dist/daemon.js'), 'utf8'),
        readFile(join(
          staged.candidate.rootPath,
          'dist/happier-plugin-ui/react-native/voice-runtime-web/index.js',
        ), 'utf8'),
      ]);
      expect(packedExecutableSources.join('\n')).not.toMatch(
        /@happier-dev\/plugin-sdk\/(?:runtime|ui\/client)|registerSpeech|speechProviderIds|catalogProviders|accountMediation|PluginVoice|providerId/u,
      );
    } finally {
      if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('creates one npm-compatible selected-file artifact and validates it through canonical staging', async () => {
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
      expect(result).not.toHaveProperty('manifestDigest');
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
        "  displayName: 'Selected Plugin', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },",
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
      const expectedRuntime = await writeManagedRuntimeFixture(managedHome);
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
