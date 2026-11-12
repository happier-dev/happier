import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildManagedPnpmEnvironment, ensureManagedPnpmCommand, managedPnpmBinPath } from '@/packagedRuntime/managedTools/pnpm/managedPnpm';
import { materializePrepublicationAuthorWorkspacePackages, resolvePluginAuthorToolchainSpawnInvocation, runManagedPluginPnpm } from './toolchain';
import { preparePluginDevelopmentRoot } from '@/plugins/daemon/developmentCandidateMaterializer';

const execFileAsync = promisify(execFile);

async function fileBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await fileBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

describe('prepublication author store', () => {
  // These real-process tests must execute the moving source, including its child role.
  beforeEach(() => vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('installs satisfying public runtime dependencies and peers from the real materialized closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-author-public-closure-'));
    const projectRoot = join(root, 'author');
    try {
      await mkdir(projectRoot);
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'author-fixture', version: '1.0.0',
        dependencies: { '@happier-dev/triage-sources': '>=0.0.0 <1.0.0' },
      }));
      // Physical package distribution is the external boundary. The selector,
      // materializer, transient overrides and managed pnpm all execute for real.
      const manifests = [
        { name: '@happier-dev/plugin-sdk', source: 'export const installed = true;\n' },
        { name: '@happier-dev/plugin-ui', peerDependencies: { '@happier-dev/plugin-sdk': '>=0.0.0 <1.0.0' },
          source: 'export { installed } from "@happier-dev/plugin-sdk";\n' },
        { name: '@happier-dev/triage-sources', dependencies: { '@happier-dev/plugin-ui': '0.0.0' },
          source: 'export { installed } from "@happier-dev/plugin-ui";\n' },
        { name: '@happier-dev/channels-protocol', source: 'export const installed = true;\n' },
      ];
      const bundles: { packageName: string; srcDir: string; destDir: string }[] = [];
      for (const { source, ...manifest } of manifests) {
        const srcDir = join(root, 'packages', ...manifest.name.split('/'));
        await mkdir(join(srcDir, 'dist'), { recursive: true });
        await writeFile(join(srcDir, 'package.json'), JSON.stringify({
          ...manifest, version: '0.0.0', type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts',
          files: ['dist'], happier: { publicSdkRelease: { posture: 'developer_preview' } },
        }));
        await writeFile(join(srcDir, 'dist/index.js'), source);
        await writeFile(join(srcDir, 'dist/index.d.ts'), 'export declare const installed: true;\n');
        bundles.push({ packageName: manifest.name, srcDir, destDir: join(root, 'unused', ...manifest.name.split('/')) });
      }
      const result = await runManagedPluginPnpm({ projectRoot, args: ['install', '--ignore-scripts', '--offline'] }, {
        ensureManagedPnpmCommand, managedPnpmBinPath, buildManagedPnpmEnvironment,
        processEnv: process.env,
        materializeBundledPrepublicationPackages: (packageNames) => materializePrepublicationAuthorWorkspacePackages({
          projectRoot, packageNames, bundles,
        }),
        spawn: async (input) => {
          const invocation = resolvePluginAuthorToolchainSpawnInvocation(input);
          const result = await execFileAsync(invocation.command, [...invocation.args], {
            cwd: invocation.cwd, env: invocation.env, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          });
          return { exitCode: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const authorRequire = createRequire(join(projectRoot, 'package.json'));
      // Follow Node's actual entrypoint resolution through pnpm's physical
      // package graph, including the UI dependency and its SDK peer import.
      expect((await import(pathToFileURL(authorRequire.resolve('@happier-dev/triage-sources')).href)).installed).toBe(true);
      expect(() => authorRequire.resolve('@happier-dev/channels-protocol')).toThrow();
      await expect(lstat(join(projectRoot, 'pnpm-workspace.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('reuses unchanged SDK content and prunes superseded content through real managed pnpm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-author-store-'));
    const projectRoot = join(root, 'author');
    const sdkRoot = join(root, 'sdk');
    const packageName = '@happier-dev/plugin-sdk';
    const paths: string[] = [];
    try {
      await mkdir(projectRoot);
      await mkdir(join(sdkRoot, 'dist'), { recursive: true });
      await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: packageName, version: '0.0.0', type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts',
        files: ['dist'], happier: { publicSdkRelease: { posture: 'developer_preview' } },
      }));
      await writeFile(join(sdkRoot, 'dist', 'index.js'), 'export const value = 1;\n');
      await writeFile(join(sdkRoot, 'dist', 'index.d.ts'), 'export declare const value: number;\n');
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'author-fixture', version: '1.0.0', dependencies: { [packageName]: '0.0.0' },
      }));
      // Physical package distribution is fixture input. Both closure materialization
      // and dependency preparation execute their real canonical implementations.
      const install = async () => {
        const prepared = await preparePluginDevelopmentRoot({ sourceRootPath: projectRoot, prepareDependencies: true }, {
          runManagedPluginPnpm: (input) => runManagedPluginPnpm({ ...input, args: [...input.args, '--offline'] }, {
            ensureManagedPnpmCommand, managedPnpmBinPath, buildManagedPnpmEnvironment,
            processEnv: process.env,
            materializeBundledPrepublicationPackages: async (packageNames) => {
              const materialized = await materializePrepublicationAuthorWorkspacePackages({
                projectRoot, packageNames,
                bundles: [{ packageName, srcDir: sdkRoot, destDir: join(projectRoot, 'unused') }],
              });
              paths.push(materialized.packageRootsByName.get(packageName)!);
              return materialized;
            },
            spawn: async (input) => {
              const invocation = resolvePluginAuthorToolchainSpawnInvocation(input);
              const result = await execFileAsync(invocation.command, [...invocation.args], {
                cwd: invocation.cwd, env: invocation.env, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
              });
              return { exitCode: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
            },
          }),
        });
        expect(prepared.rootPath).toBe(projectRoot);
        await prepared.cleanup();
      };
      const sdkEntries = async () => (await readdir(join(projectRoot, 'node_modules', '.pnpm')))
        .filter((name) => name.startsWith('@happier-dev+plugin-sdk@file+'));
      await install();
      const initialEntries = await sdkEntries();
      expect(initialEntries).toHaveLength(1);
      const initialBytes = await fileBytes(join(projectRoot, 'node_modules'));
      for (let attempt = 0; attempt < 3; attempt += 1) await install();
      expect(new Set(paths).size, 'unchanged SDK must have one file override identity').toBe(1);
      expect(await sdkEntries()).toEqual(initialEntries);
      expect(await fileBytes(join(projectRoot, 'node_modules'))).toBe(initialBytes);

      await writeFile(join(sdkRoot, 'dist', 'index.js'), 'export const value = 2;\n');
      await install();
      expect(paths.at(-1)).not.toBe(paths[0]);
      expect(await sdkEntries()).toHaveLength(1);
      expect(await sdkEntries()).not.toEqual(initialEntries);
      await expect(readFile(join(projectRoot, 'node_modules', packageName, 'dist', 'index.js'), 'utf8'))
        .resolves.toContain('value = 2');
      await expect(lstat(paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(projectRoot, 'pnpm-workspace.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(projectRoot, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
