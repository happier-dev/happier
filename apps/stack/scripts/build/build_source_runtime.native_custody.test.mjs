// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { buildSourceRuntimeBundle } from './build_source_runtime.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourcePreparationInputs } from '../testkit/core/source_runtime_fixture.mjs';
import * as sourceRuntimeEntries from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';

test('source daemon stages native custody from current sources and source-only workspace exports', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-native-custody-' });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'tools/unpacked'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  // Support both the committed emitter and the moving process-role emitter;
  // only the latter declares these additional fixture entrypoints.
  for (const source of Object.values(sourceRuntimeEntries.CLI_PROCESS_ROLE_GRAPH_ENTRIES ?? {})) {
    await mkdir(dirname(join(cliDir, source)), { recursive: true });
    await writeFile(join(cliDir, source), 'export const ready = true;');
  }
  for (const name of ['packages', 'node_modules']) await symlink(join(canonicalRepo, name), join(repoDir, name), process.platform === 'win32' ? 'junction' : 'dir');
  await cp(join(canonicalRepo, 'apps/cli/native/processcustody'), join(cliDir, 'native/processcustody'), { recursive: true });
  await installSourcePreparationInputs(repoDir, 'daemon');
  const name = `happier-process-custody${process.platform === 'win32' ? '.exe' : ''}`;
  const stale = join(cliDir, 'tools/unpacked', name);
  await writeFile(stale, 'stale helper lacking disk-measure');
  const staleTargets = join(cliDir, 'tools/unpacked/targets');
  await mkdir(staleTargets);
  for (const arch of ['x64', 'arm64']) {
    await writeFile(join(staleTargets, `happier-process-custody.linux-${arch}`), `stale ${arch}`);
  }
  // This fixture covers daemon custody staging; guest CLI compilation has its own payload suite.
  const guestPayloadDir = fixture.path('manual-guest-payload');
  await mkdir(guestPayloadDir);
  await writeFile(join(guestPayloadDir, 'happier'), '#!/bin/sh\nexit 0\n');
  const built = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('runtime'), component: 'daemon',
    env: { ...process.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: guestPayloadDir } });
  const helper = join(built.runtimeDir, 'tools/unpacked', name);
  assert.notEqual(await realpath(helper), await realpath(stale));
  for (const arch of ['x64', 'arm64']) {
    const targetHelper = await readFile(join(built.runtimeDir, 'tools/unpacked/targets', `happier-process-custody.linux-${arch}`));
    assert.equal(targetHelper.subarray(0, 4).toString('hex'), '7f454c46');
    assert.equal(targetHelper.readUInt16LE(18), arch === 'x64' ? 62 : 183);
    assert.equal(await readFile(join(staleTargets, `happier-process-custody.linux-${arch}`), 'utf8'), `stale ${arch}`);
  }
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(helper, ['disk-measure'], (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ paths: [] }));
  });
  const measured = JSON.parse(stdout);
  assert.equal(measured.v, 1);
  assert.deepEqual(measured.perPath, []);
  assert.equal(await readFile(stale, 'utf8'), 'stale helper lacking disk-measure');
});
