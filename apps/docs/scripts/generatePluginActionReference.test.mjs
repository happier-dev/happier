import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderPluginActionReferenceMarkdown } from './generatePluginActionReference.mjs';
import { GENERATORS } from './generateReference.mjs';
import * as reference from './generateReference.mjs';
import { withPatchedProcessEnv } from '../../stack/scripts/testkit/core/env_scope.mjs';

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

test('renders current Action source and refreshed dependencies without preparing a workspace build', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'docs-action-reference-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dependencyPath = join(fixture, 'dependency.ts');
  const rendererPath = join(fixture, 'renderer.ts');
  await writeFile(rendererPath,
    'import { title } from "./dependency.js";\n'
    + 'export function renderPluginActionReferenceMarkdown(): string { return title; }\n');

  const render = () => renderPluginActionReferenceMarkdown({ rendererPath });
  await writeFile(dependencyPath, 'export const title: string = "# First";\n');
  assert.equal(await render(), '# First');
  await writeFile(dependencyPath, 'export const title: string = "# Second";\n');
  assert.equal(await render(), '# Second');
});
