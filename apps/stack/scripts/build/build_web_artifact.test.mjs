import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureWebUiDependencies,
  exportWebPayloadToArtifactPayloadDir,
  resolveWebExportStagingRootDir,
} from './build_web_artifact.mjs';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('web artifact dependencies run the canonical UI postinstall through the dependency-ready callback', async () => {
  const events = [];
  const uiDir = '/tmp/happier-ui';
  const env = { HAPPIER_STACK_TEST: 'web-artifact-postinstall' };

  await ensureWebUiDependencies({
    uiDir,
    env,
    ensureDepsInstalledImpl: async (dir, label, options) => {
      events.push(['dependencies', dir, label]);
      await options.onDependenciesReady();
      events.push(['dependencies-ready']);
    },
    runUiPostinstallImpl: ({ uiDir: receivedUiDir, env: receivedEnv }) => {
      events.push(['postinstall', receivedUiDir, receivedEnv]);
    },
  });

  assert.deepEqual(events, [
    ['dependencies', uiDir, 'happier-ui'],
    ['postinstall', uiDir, env],
    ['dependencies-ready'],
  ]);
});

test('exportWebPayloadToArtifactPayloadDir exports via project-local staging dir and moves into payload', async () => {
  const root = createTempDir('stack-web-export-');
  const uiDir = join(root, 'ui');
  const payloadDir = join(root, 'artifact', 'payload');
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(join(payloadDir, '..'), { recursive: true });

  const fakeExpoExec = async ({ dir, args }) => {
    assert.equal(dir, uiDir);
    const outIndex = args.indexOf('--output-dir');
    assert.ok(outIndex >= 0, 'expected --output-dir in expo args');
    const outDir = args[outIndex + 1];
    assert.ok(outDir.startsWith(uiDir), 'expected output dir to be within uiDir');
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'assets'), { recursive: true });
    writeFileSync(join(outDir, 'index.html'), '<html>ok</html>', 'utf8');
    writeFileSync(join(outDir, 'assets', 'asset.txt'), 'ok', 'utf8');
  };

  const stagingRoot = resolveWebExportStagingRootDir(uiDir);
  assert.equal(existsSync(stagingRoot), false);

  const entrypoint = await exportWebPayloadToArtifactPayloadDir({
    uiDir,
    payloadDir,
    env: {},
    expoExecImpl: fakeExpoExec,
  });

  assert.equal(entrypoint, 'index.html');
  assert.equal(readFileSync(join(payloadDir, 'index.html'), 'utf8'), '<html>ok</html>');
  assert.equal(readFileSync(join(payloadDir, 'assets', 'asset.txt'), 'utf8'), 'ok');

  // Staging should be cleaned up to avoid polluting apps/ui/.expo.
  if (existsSync(stagingRoot)) {
    assert.deepEqual(readdirSync(stagingRoot), []);
  }

  rmSync(root, { recursive: true, force: true });
});
test('exportWebPayloadToArtifactPayloadDir throws when only a nested index.html is produced', async () => {
  const root = createTempDir('stack-web-export-nested-');
  const uiDir = join(root, 'ui');
  const payloadDir = join(root, 'artifact', 'payload');
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(join(payloadDir, '..'), { recursive: true });

  const fakeExpoExec = async ({ dir, args }) => {
    assert.equal(dir, uiDir);
    const outDir = args[args.indexOf('--output-dir') + 1];
    mkdirSync(join(outDir, 'client'), { recursive: true });
    writeFileSync(join(outDir, 'client', 'index.html'), '<html>client</html>', 'utf8');
  };

  await assert.rejects(
    () =>
      exportWebPayloadToArtifactPayloadDir({
        uiDir,
        payloadDir,
        env: {},
        expoExecImpl: fakeExpoExec,
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /missing/i);
      assert.match(err.message, /index\.html/i);
      assert.match(err.message, /client\/index\.html/i);
      return true;
    },
  );

  rmSync(root, { recursive: true, force: true });
});

test('exportWebPayloadToArtifactPayloadDir throws a diagnostic error when no index.html is produced', async () => {
  const root = createTempDir('stack-web-export-missing-');
  const uiDir = join(root, 'ui');
  const payloadDir = join(root, 'artifact', 'payload');
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(join(payloadDir, '..'), { recursive: true });

  const fakeExpoExec = async () => {
    // no-op: simulates a “silent” export that exits 0 but does not write output.
  };

  await assert.rejects(
    () =>
      exportWebPayloadToArtifactPayloadDir({
        uiDir,
        payloadDir,
        env: {},
        expoExecImpl: fakeExpoExec,
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /web export is incomplete/i);
      assert.match(err.message, /index\.html/i);
      assert.match(err.message, /staging dir/i);
      return true;
    },
  );

  rmSync(root, { recursive: true, force: true });
});
