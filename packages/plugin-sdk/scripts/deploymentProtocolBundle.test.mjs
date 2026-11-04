import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import * as workspaces from '../../cli-common/src/workspaces/index.ts';
import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';
import { WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

test('SDK packaging carries the deployment reader runtime and its declaration dependency closure', async t => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'happier-sdk-deployment-bundle-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pluginSdkDir = resolve(repoRoot, 'packages/plugin-sdk');
  await mkdir(pluginSdkDir, { recursive: true });
  await writeFile(resolve(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await writeFile(resolve(pluginSdkDir, 'package.json'), JSON.stringify({
    name: manifest.name, dependencies: manifest.dependencies, bundledDependencies: manifest.bundledDependencies,
  }));
  // Prebuilt workspace outputs are the filesystem boundary. Resolve and copy
  // them through the real SDK bundler and the real workspace implementation.
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@happier-dev/'))) {
    const packageDir = resolve(repoRoot, 'packages', name.split('/')[1]);
    await mkdir(resolve(packageDir, 'dist'), { recursive: true });
    const deployment = name === '@happier-dev/deployment-protocol';
    await writeFile(resolve(packageDir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module',
      main: './dist/index.js', types: './dist/index.d.ts', files: ['dist'],
      ...(deployment ? { dependencies: { '@happier-dev/protocol': '0.0.0' } } : {}),
    }));
    await writeFile(resolve(packageDir, 'dist/index.js'), 'export const reader = true;\n');
    await writeFile(resolve(packageDir, 'dist/index.d.ts'), deployment
      ? "export { reader } from '@happier-dev/protocol';\n" : 'export declare const reader: true;\n');
  }
  await bundleWorkspaceDeps({ repoRoot, pluginSdkDir, publicationMode: 'artifact',
    env: { ...process.env, [WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR]: '1' },
    loadCliCommonWorkspacesModule: async () => workspaces,
  });
  const bundled = resolve(pluginSdkDir, 'node_modules/@happier-dev');
  assert.equal(await readFile(resolve(bundled, 'deployment-protocol/dist/index.js'), 'utf8'), 'export const reader = true;\n');
  assert.equal(await readFile(resolve(bundled, 'deployment-protocol/dist/index.d.ts'), 'utf8'),
    "export { reader } from '@happier-dev/protocol';\n");
  assert.equal(await readFile(resolve(bundled, 'protocol/dist/index.d.ts'), 'utf8'), 'export declare const reader: true;\n');
  assert.equal(manifest.dependencies['@happier-dev/deployment-protocol'], '0.0.0',
    'a public SDK dependency must be installable outside the workspace');
});
