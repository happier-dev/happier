import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractBinaryFromArtifact, run, stageExtractedBinaryPayload } from './self_host_service_e2e_harness.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

test('self-host staging retains the extracted Windows launcher beside HStack', async (t) => {
  const fixture = await createTempFixture(t);
  const payloadDir = fixture.path('payload');
  const binDir = fixture.path('bin');
  await mkdir(payloadDir);
  await mkdir(binDir);
  await writeFile(join(payloadDir, 'hstack.exe'), 'fixture HStack');
  await writeFile(join(payloadDir, 'happier-service-launcher.exe'), 'fixture launcher');
  const artifactPath = fixture.path('hstack.tar.gz');
  run('tar', ['-czf', artifactPath, '-C', fixture.root, 'payload']);

  const extracted = await extractBinaryFromArtifact({ artifactPath, binaryName: 'hstack.exe' });
  t.after(() => rm(extracted.extractDir, { recursive: true, force: true }));
  const stagedBinaryPath = await stageExtractedBinaryPayload(extracted.binaryPath, binDir);

  assert.equal(stagedBinaryPath, join(binDir, 'hstack.exe'));
  assert.equal(await readFile(stagedBinaryPath, 'utf8'), 'fixture HStack');
  assert.equal(await readFile(join(binDir, 'happier-service-launcher.exe'), 'utf8'), 'fixture launcher');
});

test('self-host Windows commands retain executable extensions without inheriting application environment', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  withPatchedProcessEnv(t, {
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    NODE_OPTIONS: '--no-warnings',
    HAPPIER_HOME_DIR: 'unrelated-parent-home',
  });

  const probe = ['-e', `process.stdout.write(JSON.stringify({
    pathExt: Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    homeDir: process.env.HAPPIER_HOME_DIR ?? null,
    installRoot: process.env.HAPPIER_SELF_HOST_INSTALL_ROOT,
  }))`];
  const env = { PATH: process.env.PATH ?? '', HAPPIER_SELF_HOST_INSTALL_ROOT: 'test-install' };
  const result = run(process.execPath, probe, { env });

  assert.deepEqual(JSON.parse(result.stdout), {
    pathExt: '.COM;.EXE;.BAT;.CMD',
    nodeOptions: null,
    homeDir: null,
    installRoot: 'test-install',
  });
  assert.equal(Object.hasOwn(env, 'PATHEXT'), false, 'must not mutate the supplied environment');

  for (const supplied of [{ PATHEXT: '.EXE' }, { PATHEXT: '' }, { PathExt: '.CMD' }]) {
    const result = run(process.execPath, probe, { env: { ...env, ...supplied } });
    assert.equal(JSON.parse(result.stdout).pathExt, Object.values(supplied)[0]);
  }

  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  assert.equal(JSON.parse(run(process.execPath, probe, { env }).stdout).pathExt, null);
});

test('self-host commands fail before execution when the containing test deadline expired', () => {
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(0)'], {
    deadlineAtMs: Date.now() - 1,
  }), /test deadline exceeded/);
});

test('self-host preparation can use the containing deadline without a shorter phase cutoff', () => {
  const result = run(process.execPath, ['-e', 'process.stdout.write("built")'], {
    deadlineAtMs: Date.now() + 60_000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'built');
});
