import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderPluginActionReferenceMarkdown } from './generatePluginActionReference.mjs';
import { GENERATORS } from './generateReference.mjs';
import * as reference from './generateReference.mjs';
import { ensureWorkspacePackagesBuiltByName } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { withPatchedProcessEnv } from '../../stack/scripts/testkit/core/env_scope.mjs';

test('canonical freshness reuses a warm Action reference and refreshes changed dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-docs-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"private":true}');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  for (const app of ['cli', 'ui', 'server']) {
    await mkdir(join(root, 'apps', app), { recursive: true });
    await writeFile(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  for (const name of ['reference-input', 'protocol']) {
    const packageRoot = join(root, 'packages', name);
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`,
      version: '0.0.0', type: 'module', main: './dist/index.js', scripts: { build: 'fixture-compiler' },
      ...(name === 'protocol' ? { dependencies: { '@happier-dev/reference-input': 'workspace:*' } } : {}) }));
  }
  const dependency = join(root, 'packages/reference-input/src/index.js');
  await writeFile(dependency, 'export const title = "First";\n');
  await writeFile(join(root, 'packages/protocol/src/index.js'),
    'import {title} from "../../reference-input/dist/index.js"; export function renderPluginActionReferenceMarkdown() { return "# " + title; }\n');
  let builds = 0;
  const prepare = (_repo, names, options) => ensureWorkspacePackagesBuiltByName(root, names, {
    ...options,
    // The compiler is the external boundary; graph, fingerprints, locks and publication are real.
    workspaceBuildBoundary: { prepareEnv: async (_dir, env) => env,
      runPackageBuild: async (dir, { env }) => {
        builds += 1;
        await mkdir(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), await readFile(join(dir, 'src/index.js'), 'utf8'));
      } },
  });
  const render = () => renderPluginActionReferenceMarkdown({
    rendererPath: join(root, 'packages/protocol/dist/index.js'), ensureWorkspacePackagesBuiltByName: prepare,
  });
  let started = performance.now();
  assert.equal(await render(), '# First');
  console.log(`GENSIMP docs cold: ${(performance.now() - started).toFixed(3)}ms, builds=${builds}`);
  const coldBuilds = builds;
  started = performance.now();
  const outputPath = join(root, 'host-actions.mdx');
  assert.equal(await reference.writeGeneratedPages({
    repoRoot: root,
    generators: [{ name: 'Actions', outputPath, render }],
  }), 0);
  assert.equal(await readFile(outputPath, 'utf8'), '# First');
  console.log(`GENSIMP docs warm: ${(performance.now() - started).toFixed(3)}ms, builds=${builds - coldBuilds}`);
  assert.equal(builds, coldBuilds, 'an unchanged render must build no packages');
  await writeFile(dependency, 'export const title = "Second";\n');
  assert.equal(await render(), '# Second');
  assert.ok(builds > coldBuilds, 'a dependency change must refresh the rendered reference');
});

test('concurrent docs writers serialize derivation and publication under the same owner', async t => {
  withPatchedProcessEnv(t, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '1' });
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-docs-concurrency-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const outputPath = join(repoRoot, 'actions.mdx');
  let enterFirst;
  let releaseFirst;
  const entered = new Promise(resolve => { enterFirst = resolve; });
  const released = new Promise(resolve => { releaseFirst = resolve; });
  let secondEntered = false;
  const first = reference.writeGeneratedPages({ repoRoot, generators: [{ name: 'first', outputPath,
    render: async () => { enterFirst(); await released; return 'first'; } }] });
  await entered;
  const second = reference.writeGeneratedPages({ repoRoot, generators: [{ name: 'second', outputPath,
    render: async () => { secondEntered = true; return 'second'; } }] });
  await new Promise(resolve => setImmediate(resolve));
  const serialized = !secondEntered;
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(serialized, true);
  assert.equal(await readFile(outputPath, 'utf8'), 'second');
});

test('the docs generator registry owns the published Plugin host Action reference', () => {
  const expectedOutput = fileURLToPath(
    new URL('../content/docs/plugins/api/host-actions.mdx', import.meta.url),
  );

  assert.equal(
    GENERATORS.filter((generator) => generator.outputPath === expectedOutput).length,
    1,
    'host-actions.mdx must have exactly one registered docs generator',
  );
});

test('the docs writer preserves unchanged pages and publishes only the selected generators', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-docs-reference-write-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const outputPath = join(repoRoot, 'actions.mdx');
  await writeFile(outputPath, '# Current\n');
  await utimes(outputPath, 1, 1);
  const generators = [{ name: 'Actions', outputPath, render: async () => '# Current\n' }];
  assert.equal(typeof reference.writeGeneratedPages, 'function');
  assert.equal(await reference.writeGeneratedPages({ repoRoot, generators }), 0);
  assert.equal((await stat(outputPath)).mtimeMs, 1000);
  generators[0].render = async () => '# Updated\n';
  assert.equal(await reference.writeGeneratedPages({ repoRoot, generators }), 0);
  assert.equal(await readFile(outputPath, 'utf8'), '# Updated\n');
});

test('renders freshly built dependencies after another reference loaded the previous build', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'docs-action-reference-'));
  try {
    const dependencyPath = join(fixture, 'dependency.mjs');
    const rendererPath = join(fixture, 'renderer.mjs');
    await writeFile(dependencyPath, 'export const previous = true;\n');
    // Earlier generators can import the old Protocol graph before the build.
    await import(pathToFileURL(dependencyPath).href);

    const rendered = await renderPluginActionReferenceMarkdown({
      rendererPath,
      ensureWorkspacePackagesBuiltByName: async () => {
        // Model the real build's filesystem output, not the renderer internals.
        await writeFile(dependencyPath, 'export const current = "# Current Actions\\n";\n');
        await writeFile(rendererPath,
          'import { current } from "./dependency.mjs";\n'
          + 'export function renderPluginActionReferenceMarkdown() { return current; }\n');
      },
    });
    assert.equal(rendered, '# Current Actions\n');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
