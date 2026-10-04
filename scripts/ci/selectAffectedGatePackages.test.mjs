import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  execFileSync(process.execPath, [fileURLToPath(new URL('./selectAffectedGatePackages.mjs', import.meta.url))], {
    cwd: rootDir,
    env: { ...process.env, GITHUB_OUTPUT: output },
    input: 'apps/server/prisma/schema.prisma\0apps/server/sources/route.ts\0',
  });
  const lines = await readFile(output, 'utf8');
  assert.match(lines, /^packages=\["server"\]$/m);
  assert.match(lines, /^server_db_contract=true$/m);
});
