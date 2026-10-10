import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectDependencyRefresh, isDependencyRefreshLockActive, withDependencyRefresh, withDependencyRefreshLock } from './dependency_refresh.mjs';

test('dependency refresh waits for its live owner beyond the former acquisition cutoff', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-owner-lifetime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let releaseOwner;
  let markOwnerStarted;
  const held = new Promise(resolve => { releaseOwner = resolve; });
  const started = new Promise(resolve => { markOwnerStarted = resolve; });
  const owner = withDependencyRefreshLock({ installDir: root }, async () => {
    markOwnerStarted();
    await held;
  });
  await started;
  let payloadStarts = 0;
  let outcome = 'pending';
  const contender = withDependencyRefreshLock({ installDir: root }, async () => { payloadStarts += 1; })
    .then(() => { outcome = 'completed'; }, error => { outcome = error.message; });
  try {
    // OS clock/timer boundaries advance the waiting duration while retaining
    // the real owner's fresh heartbeat and real filesystem lock.
    clock += 240_001;
    t.mock.timers.tick(5_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(outcome, 'pending', 'a live dependency owner governs admission, not a subordinate acquisition deadline');
    assert.equal(payloadStarts, 0, 'a waiting contender must not start authoritative installation');
    // The real bootstrap uses synchronous Yarn subprocesses, which can delay
    // this owner's JavaScript heartbeat without ending its installation.
    clock += 240_001;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(outcome, 'pending', 'a delayed heartbeat must not let a contender replace a live installer');
    assert.equal(payloadStarts, 0);
    assert.equal(isDependencyRefreshLockActive({ installDir: root }), true);
    releaseOwner();
    await Promise.all([owner, contender]);
    assert.equal(outcome, 'completed');
    assert.equal(payloadStarts, 1);
  } finally {
    releaseOwner();
    await Promise.allSettled([owner, contender]);
  }
});

test('dependency readiness is published only after postinstall completion and remains stale on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-postinstall-publication-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  await writeFile(join(root, 'yarn.lock'), '# fixture\n');
  const patchedPath = join(root, 'node_modules', 'streamingReveal.js');
  let failPostinstall = true;
  const refresh = () => withDependencyRefresh({
    installDir: root,
    onDependenciesReady: async () => {
      assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
        'a concurrent reader must not admit unpatched dependencies while postinstall is pending');
      if (failPostinstall) throw new Error('postinstall failed');
      await writeFile(patchedPath, 'export const patched = true;\n');
    },
  }, async () => {});
  await assert.rejects(refresh(), /postinstall failed/);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true);
  failPostinstall = false;
  assert.equal((await refresh()).refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  assert.match(await readFile(patchedPath, 'utf8'), /patched/);
  failPostinstall = true;
  await assert.rejects(refresh(), /postinstall failed/);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'failed warm prerequisite repair must also withdraw the previous ready marker');
  let skippedInstalls = 0;
  const readyOnly = await withDependencyRefresh({ installDir: root, refreshExisting: false,
    onDependenciesReady: async () => await writeFile(patchedPath, 'export const patched = true;\n') },
  async () => { skippedInstalls += 1; });
  assert.equal(skippedInstalls, 0, 'ready-only repair must preserve an explicit no-install request');
  assert.equal(readyOnly.refreshed, false);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'repairing outputs without installing stale dependency inputs cannot certify the tree');
  await withDependencyRefresh({ installDir: root }, async () => {});
  const admittedPath = join(root, 'node_modules', '.happier-stack-dependencies-ready');
  const admittedState = JSON.parse(await readFile(admittedPath, 'utf8'));
  await writeFile(join(root, 'yarn.lock'), '# changed source, prior installed tree remains coherent\n');
  await withDependencyRefresh({ installDir: root, refreshExisting: false,
    onDependenciesReady: async () => await writeFile(patchedPath, 'export const patched = true;\n') },
  async () => assert.fail('last-green repair must not install changed source inputs'));
  assert.deepEqual(JSON.parse(await readFile(admittedPath, 'utf8')), admittedState,
    'successful ready-only repair preserves prior admission, never certifies changed source inputs');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'the normal installer must still refresh changed inputs after last-green repair');
});

test('UI password codec source changes invalidate remote install readiness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-password-source-freshness-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (const component of ['ui', 'cli', 'server']) {
    const dir = join(root, 'apps', component);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'src', 'auth'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, workspaces: ['apps/*', 'packages/*'],
  }));
  await writeFile(join(root, 'yarn.lock'), '# fixture\n');
  // Real package metadata is the production boundary: the freshness owner must
  // observe this asset dependency, not a test-only declaration of its inputs.
  await cp(new URL('../../../../../packages/protocol/package.json', import.meta.url), join(protocolDir, 'package.json'));
  const codecPath = join(protocolDir, 'src', 'auth', 'accountPasswordCredential.ts');
  await writeFile(codecPath, 'export const codecRevision = 1;\n');
  await withDependencyRefresh({ installDir: root }, async () => {});
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  await writeFile(codecPath, 'export const codecRevision = 2;\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'the generated password worker consumes this source even without Protocol dist');
  await withDependencyRefresh({ installDir: root }, async () => {});
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
});

test('dependency refresh reclaims a lock whose owner exited', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-lock-exited-owner-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  for (const component of ['ui', 'cli', 'server']) {
    const componentDir = join(fixtureRoot, 'apps', component);
    await mkdir(componentDir, { recursive: true });
    await writeFile(join(componentDir, 'package.json'), `{ "name": "fixture-${component}" }\n`, 'utf8');
  }
  await mkdir(join(fixtureRoot, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(fixtureRoot, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(fixtureRoot, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  const lockPath = join(fixtureRoot, '.project', 'tmp', 'dependency-install.lock');
  const moduleUrl = new URL('./dependency_refresh.mjs', import.meta.url).href;
  const script = [
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import { dirname } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    `import { withDependencyRefresh } from ${JSON.stringify(moduleUrl)};`,
    `const lockPath = ${JSON.stringify(lockPath)};`,
    'await mkdir(dirname(lockPath), { recursive: true });',
    'const exitedOwner = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });',
    'if (exitedOwner.status !== 0) throw new Error("fixture owner did not exit successfully");',
    'await writeFile(lockPath, JSON.stringify({',
    '  pid: exitedOwner.pid,',
    '  createdAtMs: Date.now(),',
    '  updatedAtMs: Date.now(),',
    '}), "utf8");',
    `await withDependencyRefresh({ installDir: ${JSON.stringify(fixtureRoot)} }, async () => {});`,
    'process.stdout.write("refreshed\\n");',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('dependency refresh did not reclaim the exited-owner lock'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(stdout, 'refreshed\n');
});

test('dependency refresh lock follows the explicit Stack home environment', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-lock-home-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const installDir = join(fixtureRoot, 'install');
  const stackHomeDir = join(fixtureRoot, 'stack-home');
  const expectedLockDir = join(stackHomeDir, 'cache', 'dependencies');
  await mkdir(join(installDir, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(installDir, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(installDir, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  await withDependencyRefresh({
    installDir,
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: stackHomeDir },
  }, async () => {
    const lockNames = await readdir(expectedLockDir);
    assert.equal(lockNames.length, 1);
    assert.match(lockNames[0], /^[a-f0-9]{64}\.lock$/);
  });
});

test('dependency readiness survives relocation of a byte-identical installed tree', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-relocation-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const sourceRoot = join(fixtureRoot, 'source');
  const relocatedRoot = join(fixtureRoot, 'relocated');
  await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await writeFile(join(sourceRoot, 'install-input.txt'), 'fixture input\n', 'utf8');
  await symlink(join(sourceRoot, 'install-input.txt'), join(sourceRoot, 'install-input-link'));
  await Promise.all([
    writeFile(join(sourceRoot, 'package.json'), '{"name":"fixture","private":true,"packageManager":"yarn@1.22.22","happier":{"installFreshnessInputs":["install-input-link"]}}\n', 'utf8'),
    writeFile(join(sourceRoot, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: sourceRoot }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1);
  const sourceInspection = await inspectDependencyRefresh({ installDir: sourceRoot });
  assert.equal(sourceInspection.required, false);
  const marker = JSON.parse(await readFile(sourceInspection.markerPath, 'utf8'));
  assert.equal(marker.version, 6);
  assert.equal(Object.hasOwn(marker, 'installDir'), false);
  assert.equal(marker.inputs.every((input) => !input.path.includes(sourceRoot)), true);
  assert.equal(JSON.stringify(marker).includes(sourceRoot), false, 'symlink targets must be hashed instead of storing absolute paths');

  await cp(sourceRoot, relocatedRoot, { recursive: true });
  assert.equal(
    (await inspectDependencyRefresh({ installDir: relocatedRoot })).required,
    false,
    'absolute installation paths must not participate in dependency freshness identity',
  );
  await withDependencyRefresh({ installDir: relocatedRoot }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1, 'relocating a ready tree must not trigger another install');
});

test('dependency readiness rejects legacy markers and a different toolchain identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true,"packageManager":"yarn@1.22.22"}\n', 'utf8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);
  const armIdentity = {
    packageManager: 'yarn@1.22.22',
    nodeVersion: '24.0.0',
    nodeAbi: '137',
    platform: 'linux',
    architecture: 'arm64',
    installMode: 'development-full-v1',
  };
  const x64Identity = { ...armIdentity, architecture: 'x64' };

  await withDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity }, async () => {});
  const admitted = await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity });
  assert.equal(admitted.required, false);
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: x64Identity })).required,
    true,
    'architecture-sensitive dependency state must not cross worker architectures',
  );

  const marker = JSON.parse(await readFile(admitted.markerPath, 'utf8'));
  await writeFile(admitted.markerPath, `${JSON.stringify({ ...marker, version: 5 })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity })).required,
    true,
    'v5 markers may have admitted scriptless installs as full installs and must be refreshed',
  );
  await writeFile(admitted.markerPath, `${JSON.stringify({
    ...marker,
    version: 4,
    installDir: root,
  })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity })).required,
    true,
    'v4 absolute-path markers remain stale on read',
  );
});

test('dependency admission repairs an exact node_modules self-link without reinstalling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-self-link-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const nodeModules = join(root, 'node_modules');
  await Promise.all([
    mkdir(nodeModules, { recursive: true }),
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: root }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);

  const invalidLink = join(nodeModules, 'node_modules');
  await symlink(nodeModules, invalidLink, 'dir');
  const corrupted = await inspectDependencyRefresh({ installDir: root });
  assert.equal(corrupted.required, true);
  assert.equal(corrupted.selfReferentialNodeModulesLinkPath, invalidLink);

  const repaired = await withDependencyRefresh({ installDir: root }, async () => {
    refreshCount += 1;
  });
  assert.deepEqual(repaired, {
    refreshed: false,
    reason: 'repaired-self-referential-node-modules-link',
  });
  assert.equal(refreshCount, 1, 'repairing the exact self-link must not run a package install');
  await assert.rejects(() => lstat(invalidLink), { code: 'ENOENT' });
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
});
