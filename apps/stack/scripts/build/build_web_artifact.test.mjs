import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildWebArtifact,
  ensureWebUiDependencies,
  exportWebPayloadToArtifactPayloadDir,
  resolveWebExportStagingRootDir,
} from './build_web_artifact.mjs';
import { readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { resolveLatestComponentArtifact } from './resolve_latest_component_artifact.mjs';

test('web reuse requires a non-empty entrypoint and its local referenced assets', async (t) => {
  const root = createTempDir('stack-web-reuse-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A missing fixture payload must not rebuild the operator's configured UI.
  const previousRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
  process.env.HAPPIER_STACK_REPO_DIR = join(root, 'missing-checkout');
  t.after(() => {
    if (previousRepoDir === undefined) delete process.env.HAPPIER_STACK_REPO_DIR;
    else process.env.HAPPIER_STACK_REPO_DIR = previousRepoDir;
  });
  const artifactDir = join(root, 'artifacts', 'web', 'web');
  const payloadDir = join(artifactDir, 'payload');
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({
    version: 1, component: 'web', artifactFingerprint: 'web',
    sourceFingerprint: 'source', payloadDir: 'payload', entrypoint: 'index.html',
  }));
  const html = '<script src="/chunk.js?v=1&amp;x=2"></script><link rel="stylesheet" href="./style.css"><a href="/sessions">sessions</a><img src="https://example.com/icon.png">';
  writeFileSync(join(payloadDir, 'index.html'), html);
  assert.equal(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'web' }), null);
  writeFileSync(join(payloadDir, 'chunk.js'), 'bundle');
  assert.equal(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'web' }), null);
  writeFileSync(join(payloadDir, 'style.css'), 'style');
  assert.ok(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'web' }));
  assert.equal((await resolveLatestComponentArtifact({ stackBaseDir: root, component: 'web' })).artifactDir, artifactDir);
  assert.equal((await buildWebArtifact({ artifactDir, artifactFingerprint: 'web' })).artifactDir, artifactDir);
  writeFileSync(join(payloadDir, 'index.html'), '');
  assert.equal(await readReusableArtifactManifest({ artifactDir, artifactFingerprint: 'web' }), null);
  assert.equal(await resolveLatestComponentArtifact({ stackBaseDir: root, component: 'web' }), null);
  await assert.rejects(buildWebArtifact({ artifactDir, artifactFingerprint: 'web' }));
});

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
    assert.ok(!args.includes('-c'), 'managed export should reuse the isolated Metro cache by default');
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
