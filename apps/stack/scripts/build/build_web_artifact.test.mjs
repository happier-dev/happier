import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

import {
  buildWebArtifact,
  ensureWebUiDependencies,
  exportWebPayloadToArtifactPayloadDir,
  resolveWebExportStagingRootDir,
} from './build_web_artifact.mjs';
import { readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { resolveLatestComponentArtifact } from './resolve_latest_component_artifact.mjs';
import { pruneComponentArtifacts } from './runtime_retention.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { prepareFiniteSourceWebFixture } from '../testkit/core/source_web_fixture.mjs';

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

test('latest component lookup selects only complete artifacts for the requested runtime target', async (t) => {
  const root = createTempDir('stack-artifact-target-select-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = { platform: 'linux', arch: 'x64' };
  for (const [id, arch, createdAt] of [['matching', 'x64', '2026-10-05T01:00:00Z'], ['foreign', 'arm64', '2026-10-05T02:00:00Z']]) {
    const artifactDir = join(root, 'artifacts/web', id);
    mkdirSync(join(artifactDir, 'payload'), { recursive: true });
    writeFileSync(join(artifactDir, 'payload/index.html'), '<html>web</html>');
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({
      version: 1, component: 'web', artifactFingerprint: id, sourceFingerprint: 'source',
      target: { platform: 'linux', arch }, createdAt, payloadDir: 'payload', entrypoint: 'index.html',
    }));
  }
  assert.equal((await resolveLatestComponentArtifact({ stackBaseDir: root, component: 'web', target })).manifest.artifactFingerprint, 'matching');
});

test('web publication refreshes authored inputs at a stable captured Metro root and records the consumer target', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'stack-web-target-' });
  const root = fixture.root;
  const repoDir = fixture.path('source');
  const { uiInput, uiSource, pluginInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  const uiPackagePath = join(repoDir, 'apps/ui/package.json');
  const uiPackage = JSON.parse(readFileSync(uiPackagePath, 'utf8'));
  delete uiPackage.type; // The production Metro config is CommonJS.
  writeFileSync(uiPackagePath, JSON.stringify(uiPackage));
  const priorRepoDir = process.env.HAPPIER_STACK_REPO_DIR;
  process.env.HAPPIER_STACK_REPO_DIR = join(root, 'ambient-checkout');
  t.after(() => {
    if (priorRepoDir === undefined) delete process.env.HAPPIER_STACK_REPO_DIR;
    else process.env.HAPPIER_STACK_REPO_DIR = priorRepoDir;
  });
  const target = { platform: 'linux', arch: process.arch === 'arm64' ? 'x64' : 'arm64' };
  const artifactDir = join(root, 'artifacts', 'web', 'target-web');
  const captureRoots = [];
  const inventories = [];
  let expectedUiSource = uiSource;
  let expectedPluginValue = 'captured-plugin-input';
  let expectedPayload = 'browser payload';
  const buildOptions = {
    rootDir: repoDir, artifactDir, artifactFingerprint: 'target-web', target,
    sourceMetadata: { repoDir, sourceFingerprint: 'source', builtAt: '2026-10-05T00:00:00Z' },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_HOME_DIR: join(root, 'home'),
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), HAPPIER_STACK_STACK: 'artifact-fixture' },
    // Package installation/postinstall and Expo are external tool boundaries;
    // export staging, payload validation, atomic publication and manifests stay real.
    ensureDepsInstalledImpl: async (dir) => {
      assert.equal(dir, join(repoDir, 'apps/ui'), 'supplied environment selects the UI before dependency consumption');
    },
    expoExecImpl: async ({ dir, args, env }) => {
      if (captureRoots.length) assert.equal(dir, captureRoots[0], 'changed artifacts must retain their Router-bound Metro project root');
      captureRoots.push(dir);
      inventories.push(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY);
      assert.equal(readFileSync(join(dir, 'sources/app/_layout.tsx'), 'utf8'), expectedUiSource);
      assert.equal(typeof env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'string', 'native export must consume its private authored-source inventory');
      const inventory = readFileSync(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
      assert.match(inventory, /happier\.admission-fixture/);
      const artifacts = runInNewContext(`${inventory.replaceAll('export const ', 'const ')}\nBUNDLED_PLUGIN_UI_APP_ARTIFACTS`, { require: path => path });
      const module = { exports: {} };
      runInNewContext(readFileSync(artifacts[0].files[0].asset, 'utf8'), { module, exports: module.exports });
      assert.equal(module.exports.renderSurface(), expectedPluginValue, 'changed plugin source must rebuild its real compiled artifact');
      assert.ok(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY.startsWith(root));
      const inventoryBlocked = execFileSync(process.execPath, ['-e', `
        const config = require(${JSON.stringify(join(dir, 'metro.config.js'))});
        const blockList = config.resolver.blockList;
        const patterns = Array.isArray(blockList) ? blockList : [blockList];
        process.stdout.write(String(patterns.some(pattern => pattern?.test(process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY))));
      `], { env, encoding: 'utf8' });
      assert.equal(inventoryBlocked, 'false', 'the real Metro file-map policy must admit the prepared inventory');
      await pruneComponentArtifacts({ stackBaseDir: root, component: 'web', keepCount: 1 });
      assert.equal(existsSync(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY), true, 'artifact retention must not reclaim inputs consumed by an active export');
      assert.equal(env.EXPO_PUBLIC_HAPPIER_SERVER_URL, '');
      const output = args[args.indexOf('--output-dir') + 1];
      assert.ok(output.startsWith(resolveWebExportStagingRootDir(dir)), 'Expo output keeps its project-local staging boundary');
      if (captureRoots.length > 1) assert.equal(readFileSync(join(artifactDir, 'payload/chunk.js'), 'utf8'), 'browser payload', 'the previous artifact remains published throughout the next export');
      writeFileSync(join(output, 'index.html'), '<script src="./chunk.js"></script>');
      writeFileSync(join(output, 'chunk.js'), expectedPayload);
    },
  };
  const result = await buildWebArtifact(buildOptions);
  assert.deepEqual(result.manifest.target, target);
  assert.deepEqual(JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8')).target, target);
  assert.equal(readFileSync(join(artifactDir, 'payload', 'chunk.js'), 'utf8'), 'browser payload');
  assert.deepEqual(readdirSync(artifactDir).sort(), ['manifest.json', 'payload']);
  assert.deepEqual(readdirSync(join(root, 'artifacts', 'web')), ['target-web'], 'private source inputs must not remain after publication');
  assert.deepEqual(readdirSync(join(root, 'artifacts')), ['web']);
  assert.equal(existsSync(captureRoots[0]), false, 'captured source is retired after Metro consumes it');
  expectedUiSource = 'export const admissionInput = "changed-ui-input";';
  expectedPluginValue = 'changed-plugin-input';
  expectedPayload = 'browser payload changed';
  writeFileSync(uiInput, expectedUiSource);
  writeFileSync(pluginInput, 'export function renderSurface() { return "changed-plugin-input"; }');
  const refreshed = await buildWebArtifact({ ...buildOptions, artifactFingerprint: 'refreshed-web',
    sourceMetadata: { repoDir, sourceFingerprint: 'changed-source', builtAt: '2026-10-05T00:00:01Z' } });
  assert.equal(refreshed.manifest.artifactFingerprint, 'refreshed-web');
  assert.equal(readFileSync(join(artifactDir, 'payload/chunk.js'), 'utf8'), expectedPayload);
  assert.equal(inventories[0], inventories[1], 'one context retains the canonical compiler inventory across changed artifacts');
  assert.equal(existsSync(captureRoots[1]), false);
  assert.equal(existsSync(inventories[1]), true, 'validated compiler candidates remain available outside published artifact payloads');
  const exportFailure = new Error('external export failed');
  await assert.rejects(buildWebArtifact({
    rootDir: repoDir, artifactDir, artifactFingerprint: 'failed-web', target,
    sourceMetadata: { repoDir, sourceFingerprint: 'changed-source', builtAt: '2026-10-05T00:00:01Z' },
    env: buildOptions.env,
    ensureDepsInstalledImpl: async () => {},
    expoExecImpl: async () => { throw exportFailure; },
  }), exportFailure);
  assert.equal(readFileSync(join(artifactDir, 'payload', 'chunk.js'), 'utf8'), expectedPayload, 'a failed export preserves the existing artifact');
  assert.deepEqual(readdirSync(join(root, 'artifacts', 'web')), ['target-web'], 'failed export must retire only its private inputs');
  assert.deepEqual(readdirSync(join(root, 'artifacts')), ['web']);
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
