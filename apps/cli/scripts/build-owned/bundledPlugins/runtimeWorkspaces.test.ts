import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, onTestFinished } from 'vitest';

import { ensureWorkspacePackagesBuiltByName } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { stagePluginDaemonRuntime } from '../../../src/plugins/authoring/bundleDaemonRuntime';
import { prepareCanonicalRuntimeWorkspacePackages } from './runtimeWorkspaces.mjs';

it('stages new workspace exports after an earlier build and staging, and reuses unchanged output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-artifact-dist-freshness-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'packages/attention');
  const plugin = join(root, 'packages/plugins/consumer');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(plugin, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - packages/plugins/*\n');
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', app), { recursive: true });
    await writeFile(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: '@happier-dev/attention', type: 'module', scripts: { build: 'fixture compiler' },
    exports: { './v1': './dist/index.js' },
  }));
  await writeFile(join(workspace, 'tsconfig.json'), '{}\n');
  await writeFile(join(workspace, 'src/index.ts'), 'export const prior = 1;\n');
  await writeFile(join(plugin, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-consumer', type: 'module',
  }));
  const entry = join(plugin, 'src/index.ts');
  const consumer = (name: string) => `import { ${name} } from '@happier-dev/attention/v1';\nexport function activate() { return ${name}; }\n`;
  await writeFile(entry, consumer('prior'));
  const builds: string[] = [];
  const buildOptions = {
    // Replace only the compiler process; freshness, dependency discovery,
    // publication, and the subsequent esbuild artifact staging stay real.
    workspaceBuildBoundary: {
      async prepareEnv(_packageDir: string, env: NodeJS.ProcessEnv) { return { ...env }; },
      async runPackageBuild(packageDir: string, { env }: { env: NodeJS.ProcessEnv }) {
        builds.push(packageDir);
        const outputDir = env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        assert.ok(outputDir);
        await writeFile(join(outputDir, 'index.js'), await readFile(join(packageDir, 'src/index.ts')));
      },
    },
  };
  const bundles = [{ packageName: '@happier-dev/attention', srcDir: workspace },
    { packageName: '@happier-dev/plugins-consumer', srcDir: plugin }];
  await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/attention'], buildOptions);
  const stage = async (name: string, roots: Readonly<Record<string, string>>) => {
    const stagedRootPath = join(root, name);
    await mkdir(stagedRootPath);
    await stagePluginDaemonRuntime({ sourceRootPath: plugin, sourceEntryPath: entry,
      stagedRootPath, daemonEntrypoint: './runtime.mjs', canonicalWorkspacePackageRoots: roots });
    return (await import(pathToFileURL(join(stagedRootPath, 'runtime.mjs')).href)).activate();
  };
  const priorRoots = await prepareCanonicalRuntimeWorkspacePackages(root, bundles, buildOptions);
  assert.equal(await stage('prior', priorRoots), 1);
  await writeFile(join(workspace, 'src/index.ts'), 'export const prior = 1;\nexport const added = 2;\n');
  await writeFile(entry, consumer('added'));
  // Sensitivity control reproduces the actual missing-export failure when
  // package roots are staged without the workspace-build preparation.
  await assert.rejects(stage('stale', priorRoots), /No matching export.*added/u);
  const freshRoots = await prepareCanonicalRuntimeWorkspacePackages(root, bundles, buildOptions);
  assert.equal(await stage('fresh', freshRoots), 2);
  assert.equal(builds.length, 2);
  await prepareCanonicalRuntimeWorkspacePackages(root, bundles, buildOptions);
  assert.equal(await stage('unchanged', freshRoots), 2);
  assert.equal(builds.length, 2, 'unchanged workspace outputs must remain reusable');
});
