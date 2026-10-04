import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { selectAffectedGatePackages } from './selectAffectedGatePackages.mjs';

test('gate selection includes changed workspace consumers, including peer consumers and removed plugin paths', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-gate-selection-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const writeManifest = async (directory, manifest) => {
    await mkdir(join(rootDir, directory), { recursive: true });
    await writeFile(join(rootDir, directory, 'package.json'), JSON.stringify(manifest));
  };
  await writeManifest('.', { workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] });
  await writeManifest('apps/cli', { name: '@happier-dev/cli', dependencies: { '@happier-dev/shared': '*' } });
  await writeManifest('apps/ui', { name: '@happier-dev/app', peerDependencies: { '@happier-dev/shared': '*' } });
  await writeManifest('apps/server', { name: '@happier-dev/server' });
  await writeManifest('packages/shared', { name: '@happier-dev/shared', dependencies: { '@happier-dev/protocol': '*' } });
  await writeManifest('packages/protocol', { name: '@happier-dev/protocol' });
  await writeManifest('packages/plugins/agent', { name: '@happier-dev/plugins-agent', dependencies: { '@happier-dev/protocol': '*' } });

  assert.deepEqual(await selectAffectedGatePackages({ rootDir, changedPaths: ['packages/shared/src/value.ts'] }), ['cli', 'ui']);
  assert.deepEqual(await selectAffectedGatePackages({ rootDir, changedPaths: ['packages/protocol/src/wire.ts'] }), ['cli', 'plugins', 'protocol', 'ui']);
  assert.deepEqual(await selectAffectedGatePackages({ rootDir, changedPaths: ['apps/server/sources/route.ts'] }), ['server']);
  assert.deepEqual(await selectAffectedGatePackages({ rootDir, changedPaths: ['packages/plugins/deleted/package.json'] }), ['cli', 'plugins', 'protocol', 'server', 'ui']);
  assert.deepEqual(await selectAffectedGatePackages({ rootDir, changedPaths: ['yarn.lock'] }), ['cli', 'plugins', 'protocol', 'server', 'ui']);
  assert.deepEqual(await selectAffectedGatePackages({ rootDir, changedPaths: ['docs/testing.md', '.project/plans/lane.md'] }), []);

  const output = join(rootDir, 'github-output');
  await writeFile(output, '');
  const loader = join(rootDir, 'preinstall-loader.mjs');
  // The Node dependency-resolution boundary models checkout before yarn install.
  await writeFile(loader, [
    'export async function resolve(specifier, context, nextResolve) {',
    '  if (!specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:") && !specifier.startsWith("/")) {',
    '    throw new Error(`Dependencies are not installed: ${specifier}`);',
    '  }',
    '  return nextResolve(specifier, context);',
    '}',
  ].join('\n'));
  execFileSync(process.execPath, ['--experimental-loader', pathToFileURL(loader).href, fileURLToPath(new URL('./selectAffectedGatePackages.mjs', import.meta.url))], {
    cwd: rootDir,
    env: { ...process.env, GITHUB_OUTPUT: output },
    input: 'apps/server/prisma/schema.prisma\0apps/server/sources/route.ts\0',
  });
  const lines = await readFile(output, 'utf8');
  assert.match(lines, /^packages=\["server"\]$/m);
  assert.match(lines, /^server_db_contract=true$/m);

  const unitOutput = join(rootDir, 'github-unit-output');
  execFileSync(process.execPath, ['--experimental-loader', pathToFileURL(loader).href, fileURLToPath(new URL('./selectAffectedGatePackages.mjs', import.meta.url))], {
    cwd: rootDir,
    env: { ...process.env, GITHUB_OUTPUT: unitOutput },
    input: 'yarn.lock\0apps/server/prisma/schema.prisma\0',
  });
  const unitLines = await readFile(unitOutput, 'utf8');
  const matrixLine = unitLines.split('\n').find((line) => line.startsWith('unit_matrix='));
  assert.ok(matrixLine, 'the gate must emit runnable unit partitions, not one unpartitioned UI job');
  const { include } = JSON.parse(matrixLine.slice('unit_matrix='.length));
  const selectedPackages = JSON.parse(unitLines.split('\n').find((line) => line.startsWith('packages=')).slice('packages='.length));
  assert.deepEqual(selectedPackages, ['cli', 'plugins', 'protocol', 'server', 'ui']);
  assert.match(unitLines, /^server_db_contract=true$/m);
  const automaticJobs = include.length + 3 + 1; // selection/compiler, artifacts, Gate, and the selected DB contract
  assert.ok(automaticJobs <= 10, `the automatic v0.3 gate must use at most 10 jobs, received ${automaticJobs}`);
  assert.deepEqual(include.filter((row) => row.package !== 'ui'), [
    { package: 'cli', packages: ['cli'], part: 1, parts: 1 },
    { package: 'group', packages: ['plugins', 'protocol', 'server'], part: 1, parts: 1 },
  ]);
  assert.deepEqual([...new Set(include.flatMap((row) => row.packages))].sort(), selectedPackages,
    'partitioning must retain every selected package suite');
  const uiParts = include.filter((row) => row.package === 'ui');
  assert.equal(uiParts.length, 4, 'the capacity ruling assigns four automatic UI jobs');
  assert.deepEqual(uiParts.map((row) => row.packages), [['ui'], ['ui'], ['ui'], ['ui']]);
  assert.deepEqual(uiParts.map((row) => row.part), [1, 2, 3, 4]);
  const { resolveVitestShardRange } = await import('../../apps/ui/scripts/runVitestShards.mjs');
  const covered = uiParts.flatMap(({ part, parts }) => {
    assert.equal(parts, uiParts.length);
    const range = resolveVitestShardRange({
      HAPPIER_UI_VITEST_PART: String(part), HAPPIER_UI_VITEST_PARTS: String(parts),
    }, 402);
    return Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
  });
  assert.deepEqual(covered, Array.from({ length: 402 }, (_, index) => index + 1),
    'the published matrix must execute every canonical UI shard exactly once');
});
