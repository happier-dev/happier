import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

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
