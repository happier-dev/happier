import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '../../packageBuildOutputTargets.mjs';

import {
  atomicReplaceDirSync,
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackage,
  bundleWorkspacePackageWithRuntimeDependencies,
  bundleWorkspacePackagesWithRuntimeDependencies,
  hasBundledWorkspacePackagesHealthy,
  materializePrepublicationWorkspacePackageRoots,
  resolveWorkspaceBundlesFromPackageJson,
  sanitizeBundledPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from './index';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writePackage(
  packageDir: string,
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = { 'index.js': 'module.exports = {};\n' },
): void {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  for (const [relativePath, contents] of Object.entries(files)) {
    const targetPath = join(packageDir, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents, 'utf8');
  }
}

function readPackageJson(packageDir: string): Readonly<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Readonly<Record<string, unknown>>;
}

function createPrepublicationBundleWriter(params: Readonly<{ sourceRoot: string; destinationRoot: string }>) {
  return (packageName: string, directoryName: string, manifest: Readonly<Record<string, unknown>> = {}):
    Parameters<typeof materializePrepublicationWorkspacePackageRoots>[0]['bundles'][number] => {
      const packageRoot = join(params.sourceRoot, directoryName);
      writePackage(packageRoot, {
        name: packageName,
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        files: ['dist', 'package.json'],
        happier: {
          publicSdkRelease: {
            posture: 'developer_preview',
            externalPublicationRequiresApproval: true,
          },
        },
        ...manifest,
      }, {
        'dist/index.js': 'export const packageMarker = true;\n',
        'dist/index.d.ts': 'export declare const packageMarker: true;\n',
      });
      return {
        packageName,
        srcDir: packageRoot,
        destDir: join(params.destinationRoot, 'node_modules', ...packageName.split('/')),
      };
    };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CLI source runtime closure', () => {
  it('admits every internal runtime dependency through the host bundle manifest', () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: join(repoRoot, 'apps', 'cli'),
    });
    expect(bundles.length).toBeGreaterThan(0);
  });
});

describe('Transformers isolated runtime closure', () => {
  it.each(['host', 'standalone'] as const)('preserves Node and Web Common versions for %s publication', async (mode) => {
    const root = createTempRoot('transformers-runtime-closure-');
    const source = join(root, 'source');
    const payload = join(root, 'payload');
    writePackage(source, { name: 'host', version: '1.0.0', dependencies: { '@huggingface/transformers': '3.8.1' } });
    const transformers = join(source, 'node_modules', '@huggingface', 'transformers');
    writePackage(transformers, { name: '@huggingface/transformers', version: '3.8.1', type: 'module', main: './index.js', dependencies: { 'onnxruntime-node': '1.21.0', 'onnxruntime-web': '1.22.0' } }, {
      'index.js': 'import { version as direct } from "onnxruntime-common"; import { version as node } from "onnxruntime-node"; import { version as web } from "onnxruntime-web"; export const versions = { direct, node, web };',
    });
    for (const [runtime, version] of [['node', '1.21.0'], ['web', '1.22.0']]) {
      const runtimeDir = join(source, 'node_modules', `onnxruntime-${runtime}`);
      writePackage(runtimeDir, { name: `onnxruntime-${runtime}`, version, type: 'module', main: './index.js', dependencies: { 'onnxruntime-common': version } }, { 'index.js': 'export { version } from "onnxruntime-common";' });
      writePackage(join(runtimeDir, 'node_modules', 'onnxruntime-common'), { name: 'onnxruntime-common', version, type: 'module', main: './index.js' }, { 'index.js': `export const version = ${JSON.stringify(version)};` });
    }
    if (mode === 'host') vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath: join(source, 'package.json'), destPackageDir: payload, dereferenceRootDir: root });
    else bundleInstalledPackageWithRuntimeDependencies({ packageName: '@huggingface/transformers', declaredSpec: '3.8.1', resolveFromPackageJsonPath: join(source, 'package.json'), destNodeModulesDir: join(payload, 'node_modules'), dereferenceRootDir: root });
    const result = await import(pathToFileURL(join(payload, 'node_modules', '@huggingface', 'transformers', 'index.js')).href);
    expect(result.versions).toEqual({ direct: '1.21.0', node: '1.21.0', web: '1.22.0' });
  });
});

describe('sanitizeBundledPackageJson', () => {
  it('preserves the exact prepublication author file inventory while stripping ordinary package files', () => {
    const declaredAuthorFiles = [
      'dist',
      'package.json',
      'API.md',
      'api-surface.json',
      'capability-matrix.json',
      'examples/public-authoring/index.ts',
      'scripts/validate-authoring.mjs',
      'API.md',
    ];

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      files: declaredAuthorFiles,
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    }).files).toEqual([
      'dist',
      'package.json',
      'API.md',
      // Generated governance records are publication-only, never runtime-declared.
      'capability-matrix.json',
      'examples/public-authoring/index.ts',
      'scripts/validate-authoring.mjs',
    ]);

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugins-example',
      version: '0.0.0',
      files: ['dist', 'README.md'],
    })).not.toHaveProperty('files');
  });

  it('keeps the executable entrypoint declaration for every bundled workspace package', () => {
    // `bin` is the only thing that makes a bundled package's dist executable
    // discoverable. The Plugin SDK's `happier-plugin-build-ui` is exactly that:
    // strip it and no `--ui` author can run `plugins dev build` from either
    // the packaged CLI's own bundled copy or a materialized prepublication root.
    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    }).bin).toEqual({ 'happier-plugin-build-ui': './dist/ui/build/bin.js' });

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugins-example',
      version: '0.0.0',
      bin: { 'example-tool': './dist/bin.js' },
    }).bin).toEqual({ 'example-tool': './dist/bin.js' });

    expect(sanitizeBundledPackageJson({
      name: '@happier-dev/plugins-example',
      version: '0.0.0',
    })).not.toHaveProperty('bin');
  });

  it.each([
    ['a traversal path', '../outside.md'],
    ['a glob path', 'examples/**'],
    ['a Windows path', 'scripts\\validate.mjs'],
  ])('rejects a marked prepublication manifest with %s', (_description, declaredFile) => {
    expect(() => sanitizeBundledPackageJson({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      files: ['dist', declaredFile],
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    })).toThrow(/exact relative path/u);
  });
});

describe('bundleWorkspacePackageWithRuntimeDependencies', () => {
  it('keeps canonical workspace links live across preparation and later producer edits', () => {
    const root = createTempRoot('workspace-package-live-link-');
    const sourceDir = join(root, 'packages', 'sdk');
    const hostDir = join(root, 'apps', 'cli');
    const destinationDir = join(hostDir, 'node_modules', '@happier-dev', 'sdk');
    writePackage(hostDir, { bundledDependencies: ['@happier-dev/sdk'] });
    writePackage(sourceDir, {
      name: '@happier-dev/sdk', version: '0.0.0', type: 'module',
      exports: { '.': { 'happier-source': './src/index.js', default: './dist/index.js' } },
    }, {
      'src/index.js': 'export const selected = "source-before";\n',
      'dist/index.js': 'export const selected = "dist-before";\n',
    });
    mkdirSync(dirname(destinationDir), { recursive: true });
    symlinkSync(sourceDir, destinationDir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    const prepare = () => bundleWorkspacePackagesWithRuntimeDependencies({
      publicationMode: 'live',
      // Exact prepared readers must preserve the source authority too.
      pruneStale: true,
      bundles: [{ packageName: '@happier-dev/sdk', srcDir: sourceDir, destDir: destinationDir }],
    });
    prepare();
    const readSelection = (source: boolean) => execFileSync(process.execPath, [
      ...(source ? ['--conditions=happier-source'] : []), '--input-type=module', '-e',
      'console.log((await import("@happier-dev/sdk")).selected);',
    ], { cwd: hostDir, encoding: 'utf8' }).trim();
    expect(readSelection(true)).toBe('source-before');
    expect(lstatSync(destinationDir).isSymbolicLink()).toBe(true);
    writeFileSync(join(sourceDir, 'src/index.js'), 'export const selected = "source-after";\n');
    writeFileSync(join(sourceDir, 'dist/index.js'), 'export const selected = "dist-after";\n');
    expect(readSelection(true)).toBe('source-after');
    expect(readSelection(false)).toBe('dist-after');
    prepare();
    expect(realpathSync(destinationDir)).toBe(realpathSync(sourceDir));
    rmSync(join(sourceDir, 'dist/index.js'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
    writeFileSync(join(sourceDir, 'dist/index.js'), 'export const selected = "dist-after";\n');
    // Prepack still detaches the same link and publishes compiled contents.
    bundleWorkspacePackagesWithRuntimeDependencies({
      publicationMode: 'artifact',
      bundles: [{ packageName: '@happier-dev/sdk', srcDir: sourceDir, destDir: destinationDir }],
    });
    expect(lstatSync(destinationDir).isSymbolicLink()).toBe(false);
    expect(readSelection(true)).toBe('dist-after');
  });

  it.each(['live', 'artifact'] as const)('replaces dangling workspace links during %s publication', (publicationMode) => {
    const root = createTempRoot('workspace-dangling-link-');
    const sourceDir = join(root, 'packages', 'sdk');
    const destinationDir = join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'sdk');
    const linkedRoot = join(root, 'removed-capture', 'sdk');
    writePackage(sourceDir, { name: '@happier-dev/sdk', version: '0.0.0', main: './dist/index.js' }, {
      'dist/index.js': 'export const generation = 1;\n',
    });
    mkdirSync(linkedRoot, { recursive: true });
    mkdirSync(dirname(destinationDir), { recursive: true });
    symlinkSync(linkedRoot, destinationDir, process.platform === 'win32' ? 'junction' : 'dir');
    rmSync(linkedRoot, { recursive: true });
    const publish = () => bundleWorkspacePackagesWithRuntimeDependencies({
      publicationMode,
      bundles: [{ packageName: '@happier-dev/sdk', srcDir: sourceDir, destDir: destinationDir }],
    });

    publish();
    expect(lstatSync(destinationDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(destinationDir, 'dist/index.js'), 'utf8')).toContain('generation = 1');
    expect(existsSync(linkedRoot)).toBe(false);
    writeFileSync(join(sourceDir, 'dist/index.js'), 'export const generation = 2;\n');
    publish();
    expect(readFileSync(join(destinationDir, 'dist/index.js'), 'utf8')).toContain('generation = 2');
  });

  it.each(['live', 'artifact'] as const)('restores a dangling workspace link after failed %s publication', (publicationMode) => {
    const root = createTempRoot('workspace-dangling-link-rollback-');
    const destinationDir = join(root, 'destination');
    const linkedRoot = join(root, 'removed-capture');
    mkdirSync(linkedRoot);
    symlinkSync(linkedRoot, destinationDir, process.platform === 'win32' ? 'junction' : 'dir');
    const originalLink = readlinkSync(destinationDir);
    rmSync(linkedRoot, { recursive: true });
    const publicationError = new Error('Filesystem rejected the staged publication');

    expect(() => atomicReplaceDirSync({
      destDir: destinationDir,
      preserveDestinationPath: publicationMode === 'live',
      buildInto: tempDir => writePackage(tempDir, { name: '@fixture/sdk' }),
      fsOps: {
        // Only the failing OS rename is replaced; real staging and rollback run.
        renameSync: (source, destination) => {
          if (String(source).includes('.__sync_tmp__.')) throw publicationError;
          renameSync(source, destination);
        },
      },
    })).toThrow(publicationError);
    expect(lstatSync(destinationDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(destinationDir)).toBe(originalLink);
    expect(existsSync(linkedRoot)).toBe(false);
  });

  it('materializes overlapping read-only declared and included author files', () => {
    const root = createTempRoot('workspace-readonly-author-files-');
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'destination');
    writePackage(sourceDir, {
      name: '@happier-dev/plugin-sdk', version: '0.0.0',
      main: './dist/index.js', files: ['dist', 'README.md', 'API.md'],
      exports: { '.': './dist/index.js', './api': './API.md' },
      happier: { publicSdkRelease: { posture: 'developer_preview' } },
    }, {
      'dist/index.js': 'export const marker = true;\n',
      'README.md': 'author documentation',
      'API.md': 'public API inventory',
    });
    for (const name of ['README.md', 'API.md']) chmodSync(join(sourceDir, name), 0o444);

    bundleWorkspacePackageWithRuntimeDependencies({
      packageName: '@happier-dev/plugin-sdk', srcDir: sourceDir, destDir: destinationDir,
      dereferenceRootDir: root, pruneStale: true,
    });

    expect(readFileSync(join(destinationDir, 'README.md'), 'utf8')).toBe('author documentation');
    expect(readFileSync(join(destinationDir, 'API.md'), 'utf8')).toBe('public API inventory');
  });

  it('accepts absent third-party declarations while requiring their runtime exports', () => {
    const root = createTempRoot('workspace-runtime-declarations-');
    const sourceDir = join(root, 'packages', 'agents');
    const hostDir = join(root, 'apps', 'cli');
    const destinationDir = join(hostDir, 'node_modules', '@happier-dev', 'agents');
    const manifest = { name: '@happier-dev/agents', version: '0.0.0',
      main: './dist/index.js', types: './dist/index.d.ts', dependencies: { 'cbor-x': '1.6.0' } };
    writePackage(hostDir, { bundledDependencies: ['@happier-dev/agents'] });
    for (const dir of [sourceDir, destinationDir]) {
      writePackage(dir, manifest, { 'dist/index.js': 'module.exports = {};\n',
        'dist/index.d.ts': 'export {};\n' });
    }
    const dependencyDir = join(destinationDir, 'node_modules', 'cbor-x');
    writePackage(dependencyDir, { name: 'cbor-x', version: '1.6.0', types: './index.d.ts',
      exports: { '.': { import: { types: './index.d.ts', default: './index.js' },
        require: { types: './index.d.cts', default: './index.cjs' } } } },
    { 'index.js': 'export const decode = () => {};\n', 'index.cjs': 'exports.decode = () => {};\n' });

    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    rmSync(join(dependencyDir, 'index.cjs'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
    writeFileSync(join(dependencyDir, 'index.cjs'), 'exports.decode = () => {};\n');
    rmSync(join(destinationDir, 'dist/index.d.ts'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
  });

  it('publishes source entrypoint dependencies and detects runtime content drift independently of build receipts', () => {
    const root = createTempRoot('workspace-package-source-closure-');
    const sourceDir = join(root, 'packages', 'sdk');
    const hostDir = join(root, 'apps', 'cli');
    const destinationDir = join(hostDir, 'node_modules', '@happier-dev', 'sdk');
    writePackage(hostDir, { bundledDependencies: ['@happier-dev/sdk'] });
    writePackage(sourceDir, {
      name: '@happier-dev/sdk', version: '0.0.0', type: 'module',
      exports: { '.': { 'happier-source': './src/index.js', default: './dist/index.js' } },
    }, {
      'dist/index.js': 'export const selected = "dist";\n',
      [`dist/${WORKSPACE_PACKAGE_BUILD_INPUT_RECORD}`]: JSON.stringify({ builtAt: 1, outputs: [] }),
      'src/index.js': 'export { selected } from "./private/value.js";\n',
      'src/private/value.js': 'export const selected = "source";\n',
    });
    const publish = () => bundleWorkspacePackageWithRuntimeDependencies({
      packageName: '@happier-dev/sdk', srcDir: sourceDir, destDir: destinationDir,
      dereferenceRootDir: root,
    });
    const readSource = () => execFileSync(process.execPath, [
      '--conditions=happier-source', '--input-type=module', '-e',
      'const module = await import("@happier-dev/sdk"); console.log(module.selected);',
    ], { cwd: hostDir, encoding: 'utf8' }).trim();

    publish();
    expect(readSource()).toBe('dist');
    expect(readFileSync(join(destinationDir, 'src/private/value.js'), 'utf8')).toContain('source');
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    writeFileSync(join(sourceDir, 'dist', WORKSPACE_PACKAGE_BUILD_INPUT_RECORD),
      JSON.stringify({ builtAt: 2, outputs: [] }));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    writeFileSync(join(sourceDir, 'src/private/value.js'), 'export const selected = "updated";\n');
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
    publish();
    expect(readSource()).toBe('dist');
    expect(readFileSync(join(destinationDir, 'src/private/value.js'), 'utf8')).toContain('updated');
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    rmSync(join(destinationDir, 'src/private/value.js'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
    publish();
    rmSync(sourceDir, { recursive: true });
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    rmSync(join(destinationDir, 'src/index.js'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    rmSync(join(destinationDir, 'dist/index.js'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
  });

  it.each(['live', 'artifact'] as const)('preserves conditional package imports and their package-root runtime targets for %s publication', (publicationMode) => {
    const root = createTempRoot('workspace-package-imports-');
    const sourceDir = join(root, 'packages', 'sdk');
    const destinationDir = join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'sdk');
    const imports = {
      '#http': { 'happier-source': './src/http.js', node: './runtime/node.js', default: './dist/fetch.js' },
      '#fs': 'fs',
      '#disabled': null,
    };
    const sourceManifest = {
      name: '@happier-dev/sdk', version: '0.0.0', type: 'module',
      exports: { '.': { browser: { 'happier-source': './src/connect.js', default: './dist/connect.js' }, 'happier-source': './src/connect.js', default: './dist/connect.js' } }, imports,
      scripts: { build: 'authored package compiler' },
    };
    const sourceFiles = {
      'dist/connect.js': 'import { transport } from "#http"; import { existsSync } from "#fs"; export const selected = transport + ":" + typeof existsSync;\n',
      'dist/fetch.js': 'export const transport = "fetch";\n',
      'runtime/node.js': 'export const transport = "node";\n',
      'src/authored.ts': 'export const authoredSource = true;\n',
      'src/connect.js': 'export { selected } from "./private.js";\n',
      'src/http.js': 'export { transport } from "./private.js";\n',
      'src/private.js': 'export const selected = "source"; export const transport = "source";\n',
    };
    writePackage(sourceDir, sourceManifest, sourceFiles);
    const authoredManifestBytes = readFileSync(join(sourceDir, 'package.json'));
    // Both publication modes detach workspace links before publishing private
    // compiled contents, preserving the linked author's original files.
    const linkedRoot = publicationMode === 'artifact' ? sourceDir : join(root, 'mounted', 'sdk');
    if (publicationMode === 'live') writePackage(linkedRoot, sourceManifest, sourceFiles);
    mkdirSync(dirname(destinationDir), { recursive: true });
    symlinkSync(linkedRoot, destinationDir, process.platform === 'win32' ? 'junction' : 'dir');
    bundleWorkspacePackagesWithRuntimeDependencies({
      publicationMode,
      bundles: [{
        packageName: '@happier-dev/sdk', srcDir: sourceDir, destDir: destinationDir,
        dereferenceRootDir: root,
      }],
    });

    expect(lstatSync(destinationDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(sourceDir, 'package.json'))).toEqual(authoredManifestBytes);
    expect(readFileSync(join(sourceDir, 'src/authored.ts'), 'utf8')).toBe(sourceFiles['src/authored.ts']);

    // Real Node resolution observes the published manifest, not Vitest's resolver.
    expect(execFileSync(process.execPath, ['--conditions=happier-source', '--conditions=browser', '--input-type=module', '-e',
      'const module = await import("@happier-dev/sdk"); console.log(module.selected);',
    ], { cwd: join(root, 'apps', 'cli'), encoding: 'utf8' }).trim()).toBe('node:function');
    expect(readPackageJson(destinationDir).imports).toEqual({
      ...imports, '#http': { node: './runtime/node.js', default: './dist/fetch.js' },
    });
    expect(readFileSync(join(destinationDir, 'dist/fetch.js'), 'utf8')).toContain('fetch');
    const hostDir = join(root, 'apps', 'cli');
    writePackage(hostDir, { bundledDependencies: ['@happier-dev/sdk'] });
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    writeFileSync(join(destinationDir, 'runtime/node.js'), 'export const transport = "stale";\n');
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
    writeFileSync(join(destinationDir, 'runtime/node.js'), 'export const transport = "node";\n');
    // An installed host can outlive its source checkout. Its own imports targets
    // still have to exist when workspace source-content comparison is unavailable.
    rmSync(sourceDir, { recursive: true });
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    rmSync(join(destinationDir, 'runtime/node.js'));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
  });

  it('detects package imports manifest drift even when all runtime files still match', () => {
    const root = createTempRoot('workspace-package-imports-parity-');
    const sourceDir = join(root, 'packages', 'sdk');
    const hostDir = join(root, 'apps', 'cli');
    const destinationDir = join(hostDir, 'node_modules', '@happier-dev', 'sdk');
    const manifest = {
      name: '@happier-dev/sdk', version: '0.0.0', type: 'module',
      exports: { '.': './dist/index.js' },
      imports: { '#http': { node: './dist/node.js', default: './dist/fetch.js' } },
    };
    writePackage(hostDir, { bundledDependencies: ['@happier-dev/sdk'] });
    writePackage(sourceDir, manifest, {
      'dist/index.js': 'export {};\n',
      'dist/node.js': 'export const transport = "node";\n',
      'dist/fetch.js': 'export const transport = "fetch";\n',
    });
    bundleWorkspacePackage({ packageName: '@happier-dev/sdk', srcDir: sourceDir, destDir: destinationDir });
    // Establish an exact current manifest independently so this test isolates the
    // health owner's comparison rather than the sanitizer's separate omission.
    writeFileSync(join(destinationDir, 'package.json'), JSON.stringify({ ...readPackageJson(destinationDir), imports: manifest.imports }));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(true);
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      ...manifest, imports: { '#http': { default: './dist/fetch.js', node: './dist/node.js' } },
    }));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      ...manifest, imports: { '#http': { node: './dist/fetch.js', default: './dist/fetch.js' } },
    }));
    expect(hasBundledWorkspacePackagesHealthy({ repoRoot: root, hostPackageDir: hostDir })).toBe(false);
  });

  it('validates the complete staged package before replacing last-green', () => {
    const repositoryRoot = createTempRoot('cli-common-workspace-stage-validation-');
    const sourceDir = join(repositoryRoot, 'packages', 'plugins', 'fixture');
    const destinationDir = join(
      repositoryRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'plugins-fixture',
    );
    writePackage(sourceDir, {
      name: '@happier-dev/plugins-fixture',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      dependencies: {},
    }, {
      'dist/index.js': 'export const generation = "current";\n',
    });
    writePackage(destinationDir, {
      name: '@happier-dev/plugins-fixture',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      dependencies: {},
    }, {
      'dist/index.js': 'export const generation = "last-green";\n',
    });

    expect(() => bundleWorkspacePackageWithRuntimeDependencies({
      packageName: '@happier-dev/plugins-fixture',
      srcDir: sourceDir,
      destDir: destinationDir,
      dereferenceRootDir: repositoryRoot,
      validatePreparedPackage: ({ packageName, packageDir }) => {
        expect(packageName).toBe('@happier-dev/plugins-fixture');
        expect(readFileSync(join(packageDir, 'dist', 'index.js'), 'utf8'))
          .toBe('export const generation = "current";\n');
        throw new Error('fixture staged package rejected');
      },
    })).toThrow(/fixture staged package rejected/u);

    expect(readFileSync(join(destinationDir, 'dist', 'index.js'), 'utf8'))
      .toBe('export const generation = "last-green";\n');
  });

  it('requires declared native bytes before publication and retains them in the prepared package', () => {
    const root = createTempRoot('cli-common-workspace-native-publication-');
    const sourceDir = join(root, 'packages', 'iroh-native');
    const destinationDir = join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'iroh-native');
    const nativePath = 'native/happier-iroh-native-lifecycle.linux-x64.node';
    writePackage(sourceDir, {
      name: '@happier-dev/iroh-native', version: '0.0.0', type: 'module',
      exports: { '.': './dist/index.js' }, files: ['dist', 'native/*.node'],
    }, { 'dist/index.js': 'export const generation = "current";\n' });
    writePackage(destinationDir, {
      name: '@happier-dev/iroh-native', version: '0.0.0', type: 'module',
      exports: { '.': './dist/index.js' },
    }, {
      'dist/index.js': 'export const generation = "last-green";\n',
      [nativePath]: 'last-green native fixture bytes',
    });
    const publish = () => bundleWorkspacePackageWithRuntimeDependencies({
      packageName: '@happier-dev/iroh-native', srcDir: sourceDir, destDir: destinationDir,
      dereferenceRootDir: root, pruneStale: true,
      validatePreparedPackage: ({ packageDir }) => {
        expect(readFileSync(join(packageDir, nativePath), 'utf8')).toBe('prepared native fixture bytes');
      },
    });

    expect(publish).toThrow();
    expect(readFileSync(join(destinationDir, 'dist/index.js'), 'utf8')).toContain('last-green');
    expect(readFileSync(join(destinationDir, nativePath), 'utf8')).toBe('last-green native fixture bytes');

    // Opaque byte-copy fixture, never loaded as or represented as a real addon.
    mkdirSync(join(sourceDir, 'native'));
    writeFileSync(join(sourceDir, nativePath), 'prepared native fixture bytes');
    mkdirSync(join(sourceDir, 'native/.private-staging'));
    writeFileSync(join(sourceDir, 'native/.private-staging/in-progress.node'), 'private native bytes');
    symlinkSync(root, join(sourceDir, 'native/.private-staging/escaping'), process.platform === 'win32' ? 'junction' : 'dir');
    publish();
    expect(readFileSync(join(destinationDir, nativePath), 'utf8')).toBe('prepared native fixture bytes');
    expect(existsSync(join(destinationDir, 'native/.private-staging'))).toBe(false);
    expect(readFileSync(join(destinationDir, 'dist/index.js'), 'utf8')).toContain('current');
  });
});

describe('materializePrepublicationWorkspacePackageRoots', () => {
  it('keeps a shared private runtime dependency resolvable from each public author root', () => {
    const root = createTempRoot('workspace-public-author-shared-private-');
    const bundle = createPrepublicationBundleWriter({ sourceRoot: join(root, 'source'), destinationRoot: join(root, 'author') });
    const protocol = bundle('@happier-dev/protocol', 'protocol', {
      happier: undefined,
      exports: { './plugins/contributions/ui/v2': './dist/index.js' },
    });
    writeFileSync(join(protocol.srcDir, 'dist/index.js'), 'export const admitted = "canonical-node";\n');
    const sdk = bundle('@happier-dev/plugin-sdk', 'sdk', {
      dependencies: { '@happier-dev/protocol': '0.0.0' },
      bundledDependencies: ['@happier-dev/protocol'],
    });
    const ui = bundle('@happier-dev/plugin-ui', 'ui', {
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0', '@happier-dev/protocol': '0.0.0' },
      bundledDependencies: ['@happier-dev/protocol'],
    });
    // Physical distributed package bytes are the boundary. Both root modules
    // exercise Node's real sibling/private dependency resolution after publication.
    for (const entry of [sdk, ui]) {
      writeFileSync(join(entry.srcDir, 'dist/index.js'), 'export { admitted } from "@happier-dev/protocol/plugins/contributions/ui/v2";\n');
    }
    materializePrepublicationWorkspacePackageRoots({ bundles: [sdk, ui, protocol],
      rootPackageNames: ['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui'] });
    for (const entry of [sdk, ui]) {
      expect(execFileSync(process.execPath, ['--input-type=module', '--eval',
        `const value = await import(${JSON.stringify(pathToFileURL(join(entry.destDir, 'dist/index.js')).href)}); process.stdout.write(value.admitted);`],
      { encoding: 'utf8' })).toBe('canonical-node');
    }
    expect(existsSync(protocol.destDir)).toBe(false);
    expect(readPackageJson(ui.destDir).bundledDependencies).toEqual(['@happier-dev/protocol']);
  });

  it('materializes reachable public author dependencies using the shared prepublication rule', () => {
    const root = createTempRoot('workspace-public-author-closure-');
    const destinationRoot = join(root, 'author');
    const bundle = createPrepublicationBundleWriter({ sourceRoot: join(root, 'packages'), destinationRoot });
    const sdk = bundle('@happier-dev/plugin-sdk', 'sdk');
    const ui = bundle('@happier-dev/plugin-ui', 'ui', {
      peerDependencies: { '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0' },
    });
    const sources = bundle('@happier-dev/triage-sources', 'sources', {
      dependencies: { '@happier-dev/plugin-ui': '0.0.0' },
      optionalDependencies: { '@happier-dev/channels-protocol': '^1.0.0' },
    });
    const unused = bundle('@happier-dev/channels-protocol', 'channels');
    materializePrepublicationWorkspacePackageRoots({
      bundles: [sources, ui, sdk, unused],
      rootPackageNames: ['@happier-dev/triage-sources'],
    });

    expect(existsSync(join(ui.destDir, 'dist/index.js'))).toBe(true);
    expect(existsSync(join(sdk.destDir, 'dist/index.js'))).toBe(true);
    expect(existsSync(unused.destDir)).toBe(false);
    expect(readPackageJson(sources.destDir).dependencies).toMatchObject({ '@happier-dev/plugin-ui': '0.0.0' });
  });

  it('materializes only requested packages carrying the canonical public author classification', () => {
    const root = createTempRoot('cli-common-public-author-roots-');
    const writePublicPackage = createPrepublicationBundleWriter({
      sourceRoot: join(root, 'source'),
      destinationRoot: join(root, 'destination'),
    });
    const sdk = writePublicPackage('@happier-dev/plugin-sdk', 'plugin-sdk');
    const channels = writePublicPackage('@happier-dev/channels-protocol', 'channels-protocol');

    materializePrepublicationWorkspacePackageRoots({
      bundles: [sdk, channels],
      rootPackageNames: ['@happier-dev/channels-protocol'],
    });

    expect(existsSync(join(channels.destDir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(sdk.destDir)).toBe(false);
    expect(() => materializePrepublicationWorkspacePackageRoots({
      bundles: [sdk, channels],
      rootPackageNames: ['@happier-dev/protocol'],
    })).toThrow(/not classified for public author use/u);
  });

  it('rejects a requested closure that names the same root package twice', () => {
    const root = createTempRoot('cli-common-public-author-duplicate-roots-');
    const writePublicPackage = createPrepublicationBundleWriter({
      sourceRoot: join(root, 'source'),
      destinationRoot: join(root, 'destination'),
    });
    const sdk = writePublicPackage('@happier-dev/plugin-sdk', 'plugin-sdk');

    expect(() => materializePrepublicationWorkspacePackageRoots({
      bundles: [sdk],
      rootPackageNames: ['@happier-dev/plugin-sdk', '@happier-dev/plugin-sdk'],
    })).toThrow(/duplicate root package names/u);
    expect(existsSync(sdk.destDir)).toBe(false);
  });

  it('materializes the declared bundled closure beneath each requested root instead of the whole classified set', () => {
    const root = createTempRoot('cli-common-public-author-closure-');
    const destinationRoot = join(root, 'destination');
    const writePublicPackage = createPrepublicationBundleWriter({
      sourceRoot: join(root, 'source'),
      destinationRoot,
    });
    // The requested root declares the feature protocol as its bundled runtime
    // closure. The protocol carries the same public author classification but
    // is NOT requested as a root, so the only honest materialization is
    // physically nested beneath the requested root — never as a sibling root
    // and never skipped.
    const sdk = writePublicPackage('@happier-dev/plugin-sdk', 'plugin-sdk', {
      bundledDependencies: ['@happier-dev/channels-protocol'],
    });
    const channels = writePublicPackage('@happier-dev/channels-protocol', 'channels-protocol');

    materializePrepublicationWorkspacePackageRoots({
      bundles: [sdk, channels],
      rootPackageNames: ['@happier-dev/plugin-sdk'],
    });

    expect(existsSync(join(sdk.destDir, 'dist', 'index.js'))).toBe(true);
    // Not a root: the request named only the SDK.
    expect(existsSync(channels.destDir)).toBe(false);
    // Physically nested inside the requested root, with its own dist bytes.
    const nestedChannelsDir = join(
      sdk.destDir,
      'node_modules',
      '@happier-dev',
      'channels-protocol',
    );
    expect(existsSync(join(nestedChannelsDir, 'dist', 'index.js'))).toBe(true);
    // The materialized manifest declares exactly that closure.
    const materializedSdkManifest = readPackageJson(sdk.destDir);
    expect(materializedSdkManifest.bundledDependencies).toEqual(['@happier-dev/channels-protocol']);
    const dependencies = materializedSdkManifest.dependencies as Readonly<Record<string, string>>;
    expect(dependencies['@happier-dev/channels-protocol']).toBe('0.0.0');
  });
});

describe('bundleInstalledPackageWithRuntimeDependencies', () => {
  it('rejects a resolved root package outside the caller-approved repository root', () => {
    const ancestorRoot = createTempRoot('cli-common-outside-root-package-');
    const repositoryRoot = join(ancestorRoot, 'repository');
    const hostPackageJsonPath = join(repositoryRoot, 'apps', 'host', 'package.json');
    const outsidePackageDir = join(ancestorRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    mkdirSync(dirname(hostPackageJsonPath), { recursive: true });
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(outsidePackageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    });

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      declaredSpec: '^1.0.0',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/resolved runtime dependency root-pkg.*outside.*approved root/i);
    expect(existsSync(join(destNodeModulesDir, 'root-pkg'))).toBe(false);
  });

  it.each([
    {
      label: 'file',
      createLink(packageDir: string, outsideRoot: string) {
        const outsideFile = join(outsideRoot, 'secret.txt');
        writeFileSync(outsideFile, 'outside-file\n', 'utf8');
        symlinkSync(outsideFile, join(packageDir, 'linked-secret.txt'), 'file');
      },
    },
    {
      label: 'directory',
      createLink(packageDir: string, outsideRoot: string) {
        const outsideDir = join(outsideRoot, 'secret-dir');
        mkdirSync(outsideDir, { recursive: true });
        writeFileSync(join(outsideDir, 'secret.txt'), 'outside-directory\n', 'utf8');
        symlinkSync(
          outsideDir,
          join(packageDir, 'linked-secret-dir'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    },
  ])('rejects a dereferenced $label symlink whose target escapes the caller-approved root', ({ createLink }) => {
    const repositoryRoot = createTempRoot('cli-common-symlink-repository-');
    const outsidePackageRoot = createTempRoot('cli-common-symlink-outside-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    mkdirSync(outsidePackageRoot, { recursive: true });
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    });
    createLink(packageDir, outsidePackageRoot);

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/dereferenced symlink target escapes copy source root/i);
  });

  it('allows a hoisted package-manager bin symlink within the caller-approved repository root', () => {
    const repositoryRoot = createTempRoot('cli-common-hoisted-bin-symlink-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'livekit-client');
    const hoistedTargetDir = join(repositoryRoot, 'node_modules', 'sdp-transform');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'livekit-client',
      version: '1.0.0',
      main: 'index.js',
    });
    writePackage(hoistedTargetDir, {
      name: 'sdp-transform',
      version: '1.0.0',
      main: 'checker.js',
    }, {
      'checker.js': 'module.exports = "checker";\n',
    });
    mkdirSync(join(packageDir, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(
      join(hoistedTargetDir, 'checker.js'),
      join(packageDir, 'node_modules', '.bin', 'sdp-verify'),
      'file',
    );

    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'livekit-client',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
      dereferenceRootDir: repositoryRoot,
    });

    expect(readFileSync(
      join(destNodeModulesDir, 'livekit-client', 'node_modules', '.bin', 'sdp-verify'),
      'utf8',
    )).toBe('module.exports = "checker";\n');
  });

  it('allows a dereferenced file symlink whose target stays within the package root', () => {
    const repositoryRoot = createTempRoot('cli-common-contained-symlink-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    }, {
      'index.js': 'module.exports = {};\n',
      'owned-target.txt': 'owned-content\n',
    });
    symlinkSync(
      join(packageDir, 'owned-target.txt'),
      join(packageDir, 'linked-owned-target.txt'),
      'file',
    );

    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    });

    expect(readFileSync(
      join(destNodeModulesDir, 'root-pkg', 'linked-owned-target.txt'),
      'utf8',
    )).toBe('owned-content\n');
  });

  it('rejects a contained directory symlink cycle on active physical ancestry', () => {
    const repositoryRoot = createTempRoot('cli-common-contained-symlink-cycle-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
    });
    symlinkSync(
      packageDir,
      join(packageDir, 'self'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    })).toThrow(/dereferenced directory symlink cycle detected/i);
  });

  it('terminates cyclic dependency ancestry by physical source identity', () => {
    const repositoryRoot = createTempRoot('cli-common-cycle-repository-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const packageADir = join(repositoryRoot, 'node_modules', 'package-a');
    const packageBDir = join(repositoryRoot, 'node_modules', 'package-b');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(packageADir, {
      name: 'package-a',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'package-b': '^1.0.0' },
    });
    writePackage(packageBDir, {
      name: 'package-b',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'package-a': '^1.0.0' },
    });

    expect(() => bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'package-a',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    })).not.toThrow();
    expect(JSON.parse(readFileSync(
      join(destNodeModulesDir, 'package-a', 'node_modules', 'package-b', 'package.json'),
      'utf8',
    ))).toMatchObject({ name: 'package-b', version: '1.0.0' });
    expect(existsSync(join(
      destNodeModulesDir,
      'package-a',
      'node_modules',
      'package-b',
      'node_modules',
      'package-a',
    ))).toBe(false);
  });

  it('preserves conflicting transitive package placements across sibling ancestry branches', () => {
    const repositoryRoot = createTempRoot('cli-common-conflicting-branches-');
    const hostPackageJsonPath = join(repositoryRoot, 'package.json');
    const rootPackageDir = join(repositoryRoot, 'node_modules', 'root-pkg');
    const leftPackageDir = join(repositoryRoot, 'node_modules', 'left-pkg');
    const rightPackageDir = join(repositoryRoot, 'node_modules', 'right-pkg');
    const leftSharedDir = join(leftPackageDir, 'node_modules', 'shared-pkg');
    const rightSharedDir = join(rightPackageDir, 'node_modules', 'shared-pkg');
    const destNodeModulesDir = join(repositoryRoot, 'artifact', 'node_modules');
    writeFileSync(hostPackageJsonPath, '{"name":"fixture-host","version":"0.0.0"}\n', 'utf8');
    writePackage(rootPackageDir, {
      name: 'root-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        'left-pkg': '^1.0.0',
        'right-pkg': '^1.0.0',
      },
    });
    writePackage(leftPackageDir, {
      name: 'left-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'shared-pkg': '^1.0.0' },
    });
    writePackage(rightPackageDir, {
      name: 'right-pkg',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'shared-pkg': '^2.0.0' },
    });
    writePackage(leftSharedDir, {
      name: 'shared-pkg',
      version: '1.0.0',
      main: 'index.js',
    });
    writePackage(rightSharedDir, {
      name: 'shared-pkg',
      version: '2.0.0',
      main: 'index.js',
    });

    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    });

    expect(JSON.parse(readFileSync(join(
      destNodeModulesDir,
      'root-pkg',
      'node_modules',
      'left-pkg',
      'node_modules',
      'shared-pkg',
      'package.json',
    ), 'utf8'))).toMatchObject({ version: '1.0.0' });
    expect(JSON.parse(readFileSync(join(
      destNodeModulesDir,
      'root-pkg',
      'node_modules',
      'right-pkg',
      'node_modules',
      'shared-pkg',
      'package.json',
    ), 'utf8'))).toMatchObject({ version: '2.0.0' });
  });
});

describe('vendorBundledPackageRuntimeDependencies', () => {
  it('omits an optional root without removing a nested plugin dependency or changing default vendoring', () => {
    const root = createTempRoot('optional-runtime-projection-');
    const source = join(root, 'source');
    writePackage(source, { name: 'host', dependencies: { heavy: '1.0.0', plugin: '1.0.0' } });
    writePackage(join(source, 'node_modules/heavy'), { name: 'heavy', version: '1.0.0' });
    writePackage(join(source, 'node_modules/plugin'), { name: 'plugin', version: '1.0.0', dependencies: { heavy: '1.0.0' } });
    const payload = join(root, 'payload');
    vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath: join(source, 'package.json'), destPackageDir: payload, dereferenceRootDir: root, excludeRootDependencies: ['heavy'] });
    expect(existsSync(join(payload, 'node_modules/heavy'))).toBe(false);
    expect(existsSync(join(payload, 'node_modules/plugin/node_modules/heavy/package.json'))).toBe(true);
    vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath: join(source, 'package.json'), destPackageDir: join(root, 'default'), dereferenceRootDir: root });
    expect(existsSync(join(root, 'default/node_modules/heavy/package.json'))).toBe(true);
  });
  it('rejects a malformed runtime dependency name before resolving or writing it', () => {
    const repositoryRoot = createTempRoot('cli-common-runtime-name-traversal-');
    const srcPackageDir = join(repositoryRoot, 'packages', 'workspace-pkg');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const destPackageDir = join(repositoryRoot, 'artifact', 'workspace-pkg');
    writePackage(srcPackageDir, {
      name: 'workspace-pkg',
      version: '1.0.0',
      dependencies: {
        '../../../../outside-runtime': '1.0.0',
      },
    });

    expect(() => vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath,
      destPackageDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/invalid package dependency name/i);
    expect(existsSync(join(repositoryRoot, 'outside-runtime'))).toBe(false);
  });

  it.each([
    ['required', 'dependencies'],
    ['optional', 'optionalDependencies'],
  ] as const)('rejects a %s runtime package resolved outside the caller-approved repository root', (
    _dependencyKind,
    dependencyField,
  ) => {
    const ancestorRoot = createTempRoot('cli-common-outside-transitive-package-');
    const repositoryRoot = join(ancestorRoot, 'repository');
    const srcPackageDir = join(repositoryRoot, 'packages', 'workspace-pkg');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const outsidePackageDir = join(ancestorRoot, 'node_modules', 'outside-dep');
    const destPackageDir = join(repositoryRoot, 'artifact', 'workspace-pkg');
    writePackage(srcPackageDir, {
      name: 'workspace-pkg',
      version: '1.0.0',
      [dependencyField]: { 'outside-dep': '^1.0.0' },
    });
    writePackage(outsidePackageDir, {
      name: 'outside-dep',
      version: '1.0.0',
      main: 'index.js',
    });

    expect(() => vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath,
      destPackageDir,
      dereferenceRootDir: repositoryRoot,
    })).toThrow(/resolved runtime dependency outside-dep.*outside.*approved root/i);
    expect(existsSync(join(destPackageDir, 'node_modules', 'outside-dep'))).toBe(false);
  });
});
