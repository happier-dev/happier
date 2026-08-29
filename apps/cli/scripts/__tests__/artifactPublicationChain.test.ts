import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundleWorkspacePackageWithRuntimeDependencies } from '../../../../packages/cli-common/src/workspaces/index';
import { main as publishSharedDeps } from '../buildSharedDeps.mjs';
import { bundleWorkspaceDeps } from '../bundleWorkspaceDeps.mjs';
import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';

const PLUGIN_PACKAGE_NAME = '@happier-dev/plugins-grok';
const PLUGIN_WORKSPACE_NAME = 'plugins-grok';
const INVENTORY_RELATIVE_PATH =
  'apps/cli/scripts/build-owned/generatedBundledPluginSourceIntegrities.json';

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function collectPackageTreeRelativePaths(packageDir: string): string[] {
  const found: string[] = [];
  const visit = (absolutePath: string): void => {
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      if (absolutePath === packageDir && entry.name === 'node_modules') continue;
      const childPath = resolve(absolutePath, entry.name);
      if (entry.isDirectory()) visit(childPath);
      else if (entry.isFile()) found.push(relative(packageDir, childPath).split(sep).join('/'));
    }
  };
  visit(packageDir);
  return found
    // `files` in the plugin manifest selects what a published package tree carries.
    .filter((relativePath) => relativePath === 'package.json' || relativePath.startsWith('dist/'))
    .sort((left, right) => left.localeCompare(right));
}

function writeArtifactInventory(repoRoot: string, packageDirsByName: ReadonlyMap<string, string>): void {
  const inventoryPath = resolve(repoRoot, INVENTORY_RELATIVE_PATH);
  const integrities = [...packageDirsByName].map(([packageName, packageDir]) => ({
    packageName,
    files: collectPackageTreeRelativePaths(packageDir).map((relativePath) => {
      const bytes = readFileSync(resolve(packageDir, ...relativePath.split('/')));
      return { relativePath, byteLength: bytes.byteLength, digest: sha256Digest(bytes) };
    }),
  }));
  mkdirSync(dirname(inventoryPath), { recursive: true });
  writeFileSync(
    inventoryPath,
    `${JSON.stringify({
      BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES: integrities,
    }, null, 2)}\n`,
    'utf8',
  );
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

type Sandbox = Readonly<{
  repoRoot: string;
  happyCliDir: string;
  pluginWorkspaceDir: string;
  pluginSourcePath: string;
  installedPluginDir: string;
  destDir: string;
}>;

function createSandbox(): Sandbox {
  const repoRoot = createTempDirSync('happier-artifact-publication-chain-');
  const happyCliDir = resolve(repoRoot, 'apps', 'cli');
  const pluginWorkspaceDir = resolve(repoRoot, 'packages', 'plugins', 'grok');
  const installedPluginDir = resolve(happyCliDir, 'node_modules', '@happier-dev', 'plugins-grok');
  const destDir = resolve(repoRoot, 'pack-destination');

  writeFile(resolve(repoRoot, 'package.json'), '{"private":true}\n');
  writeFile(resolve(repoRoot, 'yarn.lock'), '# fixture\n');
  writeFile(resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js'), 'export {};\n');
  writeFile(resolve(happyCliDir, 'package.json'), `${JSON.stringify({
    name: '@happier-dev/cli',
    version: '0.0.0',
    files: ['package.json'],
    dependencies: { [PLUGIN_PACKAGE_NAME]: '0.0.0' },
    bundledDependencies: [PLUGIN_PACKAGE_NAME],
  }, null, 2)}\n`);
  writeFile(resolve(pluginWorkspaceDir, 'package.json'), `${JSON.stringify({
    name: PLUGIN_PACKAGE_NAME,
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    files: ['dist', 'package.json'],
  }, null, 2)}\n`);
  writeFile(resolve(pluginWorkspaceDir, 'tsconfig.json'), '{}\n');
  writeFile(
    resolve(pluginWorkspaceDir, 'src', 'manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "grok", runtime: { apiVersion: 1 }, contributes: {} });\n',
  );
  mkdirSync(destDir, { recursive: true });

  return {
    repoRoot,
    happyCliDir,
    pluginWorkspaceDir,
    pluginSourcePath: resolve(pluginWorkspaceDir, 'src', 'plugin.ts'),
    installedPluginDir,
    destDir,
  };
}

/**
 * Compiles the sandbox plugin the way the canonical workspace owner compiles a real one:
 * current source in, package output out, and a hard failure when the source does not
 * compile. `FAIL_TO_COMPILE` is this sandbox compiler's syntax error.
 */
function createSandboxWorkspaceCompiler(sandbox: Sandbox) {
  return async (_repoRoot: string, packageNames: readonly string[]) => {
    for (const packageName of packageNames) {
      if (packageName !== PLUGIN_PACKAGE_NAME) continue;
      const source = readFileSync(sandbox.pluginSourcePath, 'utf8');
      if (source.includes('FAIL_TO_COMPILE')) {
        throw new Error(`TS1005: ${PLUGIN_PACKAGE_NAME} failed to compile`);
      }
      writeFile(
        resolve(sandbox.pluginWorkspaceDir, 'dist', 'index.js'),
        `// compiled by the sandbox workspace owner\n${source}`,
      );
    }
    return { ok: true, built: [...packageNames], skipped: [] as string[] };
  };
}

/**
 * Publishes the inventory the artifact ships from the exact package outputs this run
 * produced, which is the contract the canonical generator owns in the real repository.
 */
function createSandboxArtifactPublisher(sandbox: Sandbox) {
  return async ({ workspaceNames = [] }: { workspaceNames?: readonly string[] }) => {
    const packageDirsByName = new Map<string, string>();
    for (const workspaceName of workspaceNames) {
      if (workspaceName !== PLUGIN_WORKSPACE_NAME) continue;
      packageDirsByName.set(PLUGIN_PACKAGE_NAME, stagePluginPackage(sandbox));
    }
    writeArtifactInventory(sandbox.repoRoot, packageDirsByName);
    return true;
  };
}

/**
 * Stages the plugin's publishable package tree through the canonical workspace bundler,
 * which is the tree the runtime copier installs and the packer ships.
 */
function stagePluginPackage(sandbox: Sandbox): string {
  const stagedDir = resolve(sandbox.repoRoot, '.artifact-staging', PLUGIN_WORKSPACE_NAME);
  bundleWorkspacePackageWithRuntimeDependencies({
    packageName: PLUGIN_PACKAGE_NAME,
    srcDir: sandbox.pluginWorkspaceDir,
    destDir: stagedDir,
    dereferenceRootDir: sandbox.repoRoot,
    preserveDestinationPath: true,
  });
  return stagedDir;
}

function listTarballs(destDir: string): string[] {
  return readdirSync(destDir).filter((name) => name.endsWith('.tgz')).sort();
}

/**
 * Runs the canonical CLI publication chain in the order `apps/cli` `prepack` runs it:
 * shared-deps publication, pack-time workspace bundling, then the packer. `&&` means a
 * refused publication must never reach `npm pack`.
 */
async function runPublicationChain(sandbox: Sandbox): Promise<string> {
  await publishSharedDeps({
    mode: 'runtime',
    publicationMode: 'artifact',
    repoRoot: sandbox.repoRoot,
    workspaceNames: [PLUGIN_WORKSPACE_NAME],
    ensureWorkspacePackagesBuiltByNameImpl: createSandboxWorkspaceCompiler(sandbox),
    publishBundledPluginArtifactsImpl: createSandboxArtifactPublisher(sandbox),
    withBuildSharedDepsLockImpl: async (operation: () => Promise<unknown>) => await operation(),
    resolveCliCommonWorkspacesHelpersAfterBuildImpl: async () => ({}),
    syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
    syncCliRuntimeDependenciesImpl: () => undefined,
    publishSourceDevReadinessFromRuntimeClosureImpl: () => ({ stamped: true }),
  });

  await bundleWorkspaceDeps({
    repoRoot: sandbox.repoRoot,
    happyCliDir: sandbox.happyCliDir,
    publicationMode: 'artifact',
    ensureWorkspacePackagesBuiltByName: createSandboxWorkspaceCompiler(sandbox),
  });

  return execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--silent', '--ignore-scripts', '--pack-destination', sandbox.destDir],
    { cwd: sandbox.happyCliDir, encoding: 'utf8', shell: process.platform === 'win32' },
  ).trim();
}

function readPackedPluginEntry(sandbox: Sandbox, tarballName: string): string {
  return execFileSync(
    'tar',
    [
      '-xzOf',
      resolve(sandbox.destDir, tarballName),
      `package/node_modules/${PLUGIN_PACKAGE_NAME}/dist/index.js`,
    ],
    { encoding: 'utf8' },
  );
}

describe('CLI artifact publication chain', () => {
  it('emits no tarball while a bundled plugin fails to build and ships the repaired source once it compiles', async () => {
    const sandbox = createSandbox();
    try {
      // A previously published generation is installed and inventoried. This is exactly the
      // state that let a publication build succeed on stale plugin bytes.
      writeFile(sandbox.pluginSourcePath, 'export const grokPluginMarker = "last-green";\n');
      await createSandboxWorkspaceCompiler(sandbox)(sandbox.repoRoot, [PLUGIN_PACKAGE_NAME]);
      bundleWorkspacePackageWithRuntimeDependencies({
        packageName: PLUGIN_PACKAGE_NAME,
        srcDir: sandbox.pluginWorkspaceDir,
        destDir: sandbox.installedPluginDir,
        dereferenceRootDir: sandbox.repoRoot,
        preserveDestinationPath: true,
      });
      writeArtifactInventory(
        sandbox.repoRoot,
        new Map([[PLUGIN_PACKAGE_NAME, sandbox.installedPluginDir]]),
      );

      // 1. Break the plugin build. The chain must refuse before anything can be packed.
      writeFile(
        sandbox.pluginSourcePath,
        'export const grokPluginMarker = "FAIL_TO_COMPILE";\n',
      );
      const brokenOutcome = await runPublicationChain(sandbox).then(
        (tarballName) => ({
          kind: 'packed' as const,
          tarballName,
          packedPluginEntry: readPackedPluginEntry(sandbox, tarballName),
        }),
        (error: unknown) => ({
          kind: 'refused' as const,
          message: String((error as { message?: unknown })?.message ?? error),
        }),
      );
      expect(brokenOutcome).toMatchObject({
        kind: 'refused',
        message: expect.stringContaining('TS1005: @happier-dev/plugins-grok failed to compile'),
      });
      expect(listTarballs(sandbox.destDir)).toEqual([]);
      // The retained last-green bytes are still installed; they simply cannot be published.
      expect(readFileSync(resolve(sandbox.installedPluginDir, 'dist', 'index.js'), 'utf8'))
        .toContain('last-green');

      // 2. Repair the plugin. The tarball must carry a sentinel that only current source can
      //    produce, not the inventoried last-green bytes.
      const sentinel = `grok-sentinel-${process.pid}-${Date.now()}`;
      writeFile(sandbox.pluginSourcePath, `export const grokPluginMarker = "${sentinel}";\n`);
      const tarballName = await runPublicationChain(sandbox);
      expect(listTarballs(sandbox.destDir)).toEqual([tarballName]);

      const packedEntry = readPackedPluginEntry(sandbox, tarballName);
      expect(packedEntry).toContain(sentinel);
      expect(packedEntry).not.toContain('last-green');
    } finally {
      removeTempDirSync(sandbox.repoRoot);
    }
  }, 120_000);
});
