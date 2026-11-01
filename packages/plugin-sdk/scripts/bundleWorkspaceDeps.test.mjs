import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  copyFile,
  symlink,
  utimes,
  writeFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { installNativeAdmissionFixture } from '../../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';
import { ensureWorkspacePackagesBuiltByName, defaultWorkspaceBuildBoundary } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { isPidAlive } from '../../../apps/stack/scripts/utils/proc/pids.mjs';
import { withDependencyRefreshLock } from '../../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import {
  bundleWorkspaceDeps,
  preparePluginSdkWorkspaceDeclarations,
  preparePluginSdkWorkspacePrerequisites,
  resolvePluginSdkWorkspaceBundleLockPath,
  runPluginSdkPreparedScript,
} from './bundleWorkspaceDeps.mjs';

async function createPreparedScriptAdmissionFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'happier-sdk-prepared-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = await installNativeAdmissionFixture({ root });
  const pluginSdkDir = resolve(root, 'packages/plugin-sdk');
  const scriptPath = resolve(pluginSdkDir, 'scripts/bundleWorkspaceDeps.mjs');
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  await writeFile(resolve(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  for (const name of ['cli', 'ui', 'server']) {
    await mkdir(resolve(root, 'apps', name), { recursive: true });
    await writeFile(resolve(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  const manifest = { name: '@happier-dev/plugin-sdk', type: 'module', main: './dist/index.js', scripts: {
    build: 'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=build:prepared',
    'build:prepared': 'node compile.mjs', 'failure:prepared': 'node compile.mjs', 'cancel:prepared': 'node compile.mjs',
  } };
  await writeFile(resolve(pluginSdkDir, 'package.json'), JSON.stringify(manifest));
  const sourceUrl = new URL('./bundleWorkspaceDeps.mjs', import.meta.url);
  let source = await readFile(sourceUrl, 'utf8');
  source = source.replace(/(from\s+)'(\.[^']+)'/g, (_match, prefix, relativePath) =>
    `${prefix}${JSON.stringify(relativePath.endsWith('/workspace_build_admission.mjs')
      ? pathToFileURL(resolve(root, 'native-owner/apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href
      : new URL(relativePath, sourceUrl).href)}`);
  await writeFile(scriptPath, source);
  // Filesystem execution boundary reexports the real workspace graph; no
  // parser, prerequisite decision or publisher implementation is substituted.
  const commonDir = resolve(root, 'packages/cli-common');
  await mkdir(resolve(commonDir, 'dist/workspaces'), { recursive: true });
  await writeFile(resolve(commonDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' }));
  await writeFile(resolve(commonDir, 'dist/workspaces/index.js'), `export * from ${JSON.stringify(new URL('../../cli-common/dist/workspaces/index.js', import.meta.url).href)};\n`);
  const marker = resolve(root, 'prepared.json');
  const yarn = resolve(root, 'yarn.mjs');
  await writeFile(yarn, `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { callerHoldsDependencyConsumption } from ${JSON.stringify(new URL('../../../apps/stack/scripts/utils/proc/dependency_refresh.mjs', import.meta.url).href)};
const script = process.argv.at(-1);
if (script === 'build') {
  if (process.cwd().endsWith('/prerequisite')) {
    mkdirSync(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
    writeFileSync(resolve(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const prerequisite = true;\\n');
    process.exit(0);
  }
  const result = spawnSync(process.execPath, [resolve('scripts/bundleWorkspaceDeps.mjs'), '--declarations', '--run-script=build:prepared'], { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const token = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
const admissionClass = token ? readFileSync(resolve(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT,
  'owners', token.replace(':', '-'), 'class'), 'utf8').trim() : null;
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ token: token ?? null, admissionClass,
  dependencyCustody: callerHoldsDependencyConsumption(process.env),
  leases: JSON.parse(process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]'),
  script, cwd: process.cwd(), pid: process.pid, staged: process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR }));
if (script === 'failure:prepared') process.exit(7);
if (script === 'cancel:prepared') setInterval(() => {}, 1000);
else {
  mkdirSync(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
  writeFileSync(resolve(process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const ready = true;\\n');
}\n`);
  const memory = resolve(root, 'memory');
  await writeFile(memory, '73400320 73400320\n');
  const { binDir } = writeFakeBin({ root, binDirName: 'native-owner/node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$SDK_FIXTURE_MEMORY" ;;
  */proc/pressure/memory*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, HAPPIER_DEV_TARGET_EXECUTION: '1',
    SDK_FIXTURE_MEMORY: memory, npm_execpath: yarn, HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: resolve(root, 'staged') };
  for (const key of Object.keys(env)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')
    || key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_') || key === 'HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY') delete env[key];
  const locks = [resolveWorkspaceBundleLockPath(root), resolveWorkspacePackageBuildLockPath(pluginSdkDir, manifest)];
  const start = (scriptName = 'build:prepared') => {
    const child = spawn(process.execPath, [scriptPath, '--declarations', `--run-script=${scriptName}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolveDone, rejectDone) => { child.once('error', rejectDone); child.once('close', (status, signal) => resolveDone({ status, signal, stderr })); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await done; });
    return { child, done, stderr: () => stderr };
  };
  return { ...native, root, pluginSdkDir, env, marker, memory, locks, start };
}

test('SDK prepared public entrypoint acquires dependency consumption and both publication leases before admission', { skip: process.platform !== 'linux' }, async t => {
  for (const heldIndex of [0, 1, 'dependency']) await t.test(heldIndex === 0 ? 'bundle' : heldIndex === 1 ? 'package' : 'dependency', async t => {
    const fixture = await createPreparedScriptAdmissionFixture(t);
    let running;
    const whileHeld = async () => {
      running = fixture.start();
      await new Promise(resolveWait => setTimeout(resolveWait, 700));
      assert.equal(await readFile(fixture.marker, 'utf8').catch(() => null), null, 'a foreign publisher must prevent the prepared script from starting');
      assert.deepEqual(await readdir(resolve(fixture.admissionRoot, 'owners')).catch(() => []), [], 'foreign lease wait must remain unadmitted');
    };
    if (heldIndex === 'dependency') {
      await withDependencyRefreshLock({ installDir: fixture.root, env: fixture.env }, whileHeld);
    } else {
      await withWorkspaceBundleLock(whileHeld, { lockPath: fixture.locks[heldIndex] });
    }
    assert.equal((await running.done).status, 0);
    const result = JSON.parse(await readFile(fixture.marker, 'utf8'));
    assert.ok(result.token, 'the selected script must run beneath genuine admission');
    assert.equal(result.dependencyCustody, true, 'nested compilation must inherit installed-tree consumption before publication admission');
    assert.deepEqual(result.leases.map(value => JSON.parse(value).path).sort(), [...fixture.locks].sort());
    assert.equal(result.script, 'build:prepared');
    assert.equal(result.staged, fixture.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR);
  });
});

test('SDK prepared public entrypoint releases both leases while waiting for memory', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createPreparedScriptAdmissionFixture(t);
  await writeFile(fixture.memory, '1 73400320\n');
  const running = fixture.start();
  for (let attempt = 0; !running.stderr().includes('waiting for heavyweight admission'); attempt++) {
    if (attempt === 500) assert.fail(`SDK preparation did not wait for native capacity: ${running.stderr()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  for (const lockPath of fixture.locks) await withWorkspaceBundleLock(() => {}, { lockPath, timeoutMs: 100 });
  assert.deepEqual(await readdir(resolve(fixture.admissionRoot, 'owners')), []);
  await writeFile(fixture.memory, '73400320 73400320\n');
  assert.equal((await running.done).status, 0);
  assert.ok(JSON.parse(await readFile(fixture.marker, 'utf8')).token);
});

test('SDK prepared public entrypoint admits the selected script rather than the default build', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createPreparedScriptAdmissionFixture(t);
  const manifestPath = resolve(fixture.pluginSdkDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.scripts.build = 'pkgroll';
  manifest.scripts['check:prepared'] = 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await fixture.start('check:prepared').done;
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(await readFile(fixture.marker, 'utf8'));
  assert.equal(prepared.script, 'check:prepared');
  assert.equal(prepared.admissionClass, 'package-dist');
});

test('SDK prepared public entrypoint reuses producer leases inside captured workspace admission', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createPreparedScriptAdmissionFixture(t);
  const result = await ensureWorkspacePackagesBuiltByName(fixture.root, ['@happier-dev/plugin-sdk'], {
    env: fixture.env, buildMode: 'qa-runtime', quiet: true,
    workspaceBuildBoundary: { ...defaultWorkspaceBuildBoundary, workerLauncherPath: fixture.launcher },
  });
  assert.deepEqual(result.built, ['@happier-dev/plugin-sdk']);
  const prepared = JSON.parse(await readFile(fixture.marker, 'utf8'));
  assert.notEqual(prepared.cwd, fixture.pluginSdkDir, 'the prepared script consumes captured source');
  assert.equal(prepared.dependencyCustody, true, 'captured compilation retains the original installed-tree custody');
  assert.deepEqual([...new Set(prepared.leases.map(value => JSON.parse(value).path))].sort(), [...fixture.locks].sort(),
    'captured compilation must not create another publication owner');
  assert.match(await readFile(resolve(fixture.pluginSdkDir, 'dist/index.js'), 'utf8'), /ready/);
});

test('SDK prepared public entrypoint propagates script failure and cancellation without retaining custody', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createPreparedScriptAdmissionFixture(t);
  const failure = await fixture.start('failure:prepared').done;
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /failure:prepared failed with exit code 7/);
  const running = fixture.start('cancel:prepared');
  let prepared;
  for (let attempt = 0; ; attempt++) {
    prepared = await readFile(fixture.marker, 'utf8').then(JSON.parse).catch(() => null);
    if (prepared?.script === 'cancel:prepared') break;
    if (attempt === 500) assert.fail(`prepared child did not start: ${running.stderr()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  running.child.kill('SIGTERM');
  assert.notEqual((await running.done).status, 0);
  for (let attempt = 0; isPidAlive(prepared.pid); attempt++) {
    if (attempt === 500) assert.fail('cancelled prepared child retained process custody');
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.deepEqual(await readdir(resolve(fixture.admissionRoot, 'owners')), []);
  assert.deepEqual(await readdir(resolve(fixture.admissionRoot, 'waiters')), []);
  for (const lockPath of fixture.locks) await withWorkspaceBundleLock(() => {}, { lockPath, timeoutMs: 100 });
});

test('SDK prepared public entrypoint cancels a genuinely queued compiler prerequisite', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createPreparedScriptAdmissionFixture(t);
  const manifestPath = resolve(fixture.pluginSdkDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies = { '@happier-dev/prerequisite': 'workspace:*' };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const prerequisite = resolve(fixture.root, 'packages/prerequisite');
  await mkdir(resolve(prerequisite, 'src'), { recursive: true });
  await writeFile(resolve(prerequisite, 'src/index.ts'), 'export const prerequisite = true;\n');
  await writeFile(resolve(prerequisite, 'package.json'), JSON.stringify({ name: '@happier-dev/prerequisite',
    type: 'module', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  const spawnBoundary = resolve(fixture.root, 'native-spawn-boundary.mjs');
  const canonicalLauncher = fileURLToPath(new URL('../../../apps/stack/bin/hstack-exec', import.meta.url));
  await writeFile(spawnBoundary, `import { createRequire, syncBuiltinESMExports } from 'node:module';
const childProcess = createRequire(import.meta.url)('node:child_process');
const original = childProcess.spawn;
const canonical = ${JSON.stringify(canonicalLauncher)};
const fixture = ${JSON.stringify(fixture.launcher)};
childProcess.spawn = (command, args, options) => original(command === canonical ? fixture : command,
  args?.map(value => value === canonical ? fixture : value), options);
syncBuiltinESMExports();\n`);
  fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(spawnBoundary).href}`;
  await writeFile(fixture.memory, '1 73400320\n');
  const running = fixture.start();
  try {
    for (let attempt = 0; !running.stderr().includes('waiting for heavyweight admission'); attempt++) {
      if (attempt === 500) assert.fail(`prerequisite did not queue: ${running.stderr()}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    running.child.kill('SIGTERM');
    const completion = await Promise.race([running.done, new Promise(resolveWait => setTimeout(() => resolveWait('pending'), 5000))]);
    assert.notEqual(completion, 'pending', 'SDK cancellation must retire the queued prerequisite before its compiler starts');
    assert.notEqual(completion.status, 0);
    assert.equal(await readFile(fixture.marker, 'utf8').catch(() => null), null);
    assert.deepEqual(await readdir(resolve(fixture.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(resolve(fixture.admissionRoot, 'waiters')), []);
  } finally {
    // A RED assertion must still release this test's legitimate queued work.
    await writeFile(fixture.memory, '73400320 73400320\n');
    await running.done;
  }
});

test('plugin-sdk workspace bundling uses the canonical repository bundle lock by default', () => {
  const repoRoot = '/repo';

  assert.equal(
    resolvePluginSdkWorkspaceBundleLockPath({ repoRoot }),
    resolveWorkspaceBundleLockPath(repoRoot),
  );
});

test('runtime compilation leaves public-toolchain checks to the check lane', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(packageJson.scripts['build:prepared'], /prepare:declarations:prepared|check:action-type-map/u);
  assert.doesNotMatch(packageJson.scripts['build:prepared'], /api-governance|public-toolchain/u);
  assert.match(packageJson.scripts['check:api-governance'], /--run-script=check:api-governance:locked/u);
  assert.match(packageJson.scripts['check:api-governance:locked'], /--profile plugin-sdk --check/u);
  assert.match(packageJson.scripts['check:public-toolchain'], /--run-script=check:public-toolchain:prepared/u);
  assert.match(packageJson.scripts['check:public-toolchain:prepared'], /generatePublicToolchainCompatibility\.mjs --check/u);
  assert.match(packageJson.scripts['prepack:prepared'], /api-governance\/cli\.mjs --profile plugin-sdk --write/u);
});

test('internal SDK dependency builds admit a stale Action map while publication gates reject it', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'happier-sdk-stale-action-map-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await mkdir(resolve(directory, 'scripts'), { recursive: true });
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({
    name: '@fixture/sdk', private: true, type: 'module',
    scripts: {
      ...scripts,
      // Compiler and Action-generator subprocesses are genuine system boundaries.
      // The actual package-script graph and prepared-script runner remain real.
      'build:compiled': 'node ./scripts/compile.mjs',
    },
  }));
  await writeFile(resolve(directory, 'scripts/compile.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('compiled', 'runtime emitted');\n");
  await writeFile(resolve(directory, 'scripts/generateActionTypeMap.mjs'),
    "throw new Error('Generated Action type map is stale: result field changed');\n");
  await assert.doesNotReject(() => runPluginSdkPreparedScript('build:prepared', { pluginSdkDir: directory }));
  assert.equal(await readFile(resolve(directory, 'compiled'), 'utf8'), 'runtime emitted');
  for (const gate of ['check:prepare:api-governance:prepared', 'prepack:prepared', 'check:action-type-map', 'generated:finite']) {
    await assert.rejects(() => runPluginSdkPreparedScript(gate, { pluginSdkDir: directory }),
      undefined, `${gate} must retain rejection of the stale Action map`);
  }
});

test('declaration preparation derives stale Plugin SDK DTOs through the canonical producer', async t => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const cache = resolve(repo, 'packages/plugin-sdk/node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(resolve(cache, 'happier-sdk-dto-preparation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = resolve(root, 'packages/plugin-sdk');
  const linkDirectory = async (source, target) => symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(resolve(sdk, 'scripts'), { recursive: true });
  await mkdir(resolve(sdk, 'src/actions'), { recursive: true });
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(resolve(sdk, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: manifest.scripts }));
  for (const script of ['generateActionTypeMap.mjs', 'deriveActionDtos.mjs']) {
    await copyFile(new URL(script, import.meta.url), resolve(sdk, 'scripts', script));
  }
  await linkDirectory(resolve(repo, 'packages/protocol'), resolve(root, 'packages/protocol'));
  await linkDirectory(resolve(repo, 'scripts'), resolve(root, 'scripts'));
  await linkDirectory(resolve(repo, 'apps'), resolve(root, 'apps'));
  const output = resolve(sdk, 'src/actions/actionTypeMap.generated.ts');
  await writeFile(output, '// stale DTOs\n');
  const options = { pluginSdkDir: sdk, env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' } };
  await runPluginSdkPreparedScript('prepare:declarations:prepared', options);
  assert.match(await readFile(output, 'utf8'), /export type PluginActionInputById/u);
  await runPluginSdkPreparedScript('check:action-type-map', options);
  await writeFile(output, '// stale DTOs again\n');
  await assert.rejects(() => runPluginSdkPreparedScript('check:action-type-map', options));
});

test('plugin-sdk workspace bundling preserves an explicit lock override', () => {
  assert.equal(
    resolvePluginSdkWorkspaceBundleLockPath({ repoRoot: '/repo', lockPath: '/tmp/explicit.lock' }),
    '/tmp/explicit.lock',
  );
});

test('plugin-sdk declaration preparation delegates to the canonical stale-only workspace owner', async () => {
  const calls = [];
  const pluginSdkDir = '/repo/packages/plugin-sdk';
  const env = { CI: '1' };

  const result = await preparePluginSdkWorkspacePrerequisites({
    pluginSdkDir,
    env,
    ensureWorkspacePackagesBuiltForComponent: async (...args) => {
      calls.push(args);
      return { ok: true, built: [], skipped: [] };
    },
  });

  assert.deepEqual(calls, [[pluginSdkDir, { env, quiet: true }]]);
  assert.deepEqual(result, { ok: true, built: [], skipped: [] });
});

test('plugin-sdk declaration preparation publishes the exact workspace graph consumed by the SDK', async () => {
  const calls = [];
  const repoRoot = '/repo';
  const pluginSdkDir = '/repo/packages/plugin-sdk';
  const env = { CI: '1' };
  const consumePreparedWorkspace = async () => {};

  const result = await preparePluginSdkWorkspaceDeclarations({
    repoRoot,
    pluginSdkDir,
    env,
    consumePreparedWorkspace,
    bundleWorkspaceDepsImpl: async (options) => {
      calls.push(options);
      return { bundles: [{ packageName: '@happier-dev/protocol' }] };
    },
  });

  assert.deepEqual(calls, [{
    repoRoot,
    pluginSdkDir,
    env,
    publicationMode: 'live',
    pruneStale: true,
    consumePreparedWorkspace,
  }]);
  assert.deepEqual(result, {
    bundles: [{ packageName: '@happier-dev/protocol' }],
  });
});

test('plugin-sdk prepared readers preserve the caller environment until their script exits', async () => {
  const calls = [];
  const child = new EventEmitter();
  const run = runPluginSdkPreparedScript('typecheck:tests:prepared', {
    pluginSdkDir: '/repo/packages/plugin-sdk',
    env: {
      npm_execpath: '/tooling/pnpm',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: 'held-by-reader',
    },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  await run;

  assert.deepEqual(calls, [{
    command: '/tooling/pnpm',
    args: ['--silent', 'run', 'typecheck:tests:prepared'],
    options: {
      cwd: '/repo/packages/plugin-sdk',
      env: {
        npm_execpath: '/tooling/pnpm',
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: 'held-by-reader',
      },
      stdio: 'inherit',
      ownedProcessGroup: true,
    },
  }]);
});

test('plugin-sdk declaration preparation reuses prerequisites admitted by the canonical package build', async () => {
  const result = await preparePluginSdkWorkspacePrerequisites({
    pluginSdkDir: '/repo/packages/plugin-sdk',
    env: {
      HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1',
    },
    ensureWorkspacePackagesBuiltForComponent: async () => {
      throw new Error('canonical package builds must not re-enter prerequisite admission');
    },
  });

  assert.deepEqual(result, {
    ok: true,
    built: [],
    skipped: ['canonical-package-build'],
  });
});

test('plugin-sdk keeps publication preparation separate from ordinary source validation', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  const publicationPreparers = [
    'prepare:api-governance',
    'api-governance',
    'check:prepare:api-governance',
    'check:api-governance',
    'prepare:declarations',
    'generate:public-toolchain',
    'check:public-toolchain',
    'prepack',
    'build:finite',
    'api:finite',
    'build',
  ];
  for (const scriptName of publicationPreparers) {
    assert.match(
      packageJson.scripts[scriptName],
      /^node \.\/scripts\/bundleWorkspaceDeps\.mjs --declarations --run-script=[a-z:-]+$/u,
      `${scriptName} must prepare its declaration/artifact inputs through the canonical publication owner`,
    );
    const preparedScriptName = packageJson.scripts[scriptName].split('--run-script=')[1];
    assert.equal(typeof packageJson.scripts[preparedScriptName], 'string');
  }

  assert.equal(
    packageJson.scripts['check:api-governance:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --check --source-prepared',
  );
  assert.equal(packageJson.scripts['api-surface'], 'pnpm --silent run api-governance');
  assert.equal(packageJson.scripts['check:api-surface'], 'pnpm --silent run check:api-governance');
  assert.equal(packageJson.scripts.prebuild, undefined);
  assert.equal(packageJson.scripts['pretypecheck:source'], undefined);
  assert.equal(packageJson.scripts['pretypecheck:tests'], undefined);
  assert.equal(packageJson.scripts['test:source'], 'vitest run --config vitest.source.config.ts');
  assert.equal(packageJson.scripts['test:local'], 'pnpm --silent run test:source && pnpm --silent run test:local:adjacent');
  const adjacentScript = packageJson.scripts['test:local:adjacent'];
  assert.doesNotMatch(adjacentScript, /bundleWorkspaceDeps|prepare:declarations/u);
  assert.ok(
    adjacentScript.startsWith('node ./scripts/buildExampleProjects.mjs --yarn=automation-event-source,action-contract-producer,triage-source-target,triage-source-contributor --happier-dev=public-authoring,session-agent && node --test '),
    'the managed isolated build for every dist-importing example must immediately precede the SDK unit lane test batch',
  );
  const adjacentNodeTests = adjacentScript.slice(adjacentScript.indexOf('node --test '));
  for (const testPath of [
    'examples/triage-source-target/test/index.test.mjs',
    'examples/triage-source-contributor/test/index.test.mjs',
    'examples/public-authoring/test/index.test.mjs',
    'examples/session-agent/test/index.test.mjs',
  ]) {
    assert.ok(adjacentNodeTests.includes(testPath), 'expected node test batch to include ' + testPath);
  }
  assert.equal(
    packageJson.scripts['typecheck:source'],
    'pnpm --silent run typecheck:source:prepared',
  );
  assert.equal(
    packageJson.scripts['typecheck:source:prepared'],
    'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json',
  );
  assert.equal(
    packageJson.scripts['typecheck:tests'],
    'pnpm --silent run typecheck:tests:prepared',
  );
  assert.equal(
    packageJson.scripts['typecheck:tests:prepared'],
    'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json',
  );
  assert.equal(packageJson.scripts.typecheck, '../../apps/stack/bin/hstack-exec --script=typecheck:local');
  assert.equal(packageJson.scripts['typecheck:local'], 'pnpm --silent run typecheck:source:prepared && pnpm --silent run typecheck:tests:prepared');
  assert.equal(packageJson.scripts['generated:finite'], 'pnpm --silent run check:action-type-map');
  assert.ok(
    packageJson.scripts['test:prepared'].startsWith('vitest run --config vitest.config.ts && '),
    'the prepared test lane must use the authored-source collection boundary before adjacent tests',
  );
  assert.equal(packageJson.scripts['test:finite'], 'pnpm --silent run test:prepared');
  assert.equal(packageJson.scripts['typecheck:finite'], 'pnpm --silent run typecheck:tests:prepared');
});

test('plugin-sdk runtime bundling admits the resolved artifact closure and publishes it once', async () => {
  const events = [];
  const repoRoot = '/repo';
  const pluginSdkDir = '/repo/packages/plugin-sdk';

  await bundleWorkspaceDeps({
    repoRoot,
    pluginSdkDir,
    publicationMode: 'artifact',
    ensureWorkspacePackagesBuiltForComponent: async () => {
      throw new Error('runtime bundling should admit exact resolved names instead of the host component');
    },
    ensureWorkspacePackagesBuiltByName: async (root, packageNames, options) => {
      assert.equal(root, repoRoot);
      assert.deepEqual(packageNames, ['@happier-dev/protocol']);
      assert.equal(options?.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, undefined);
      events.push('admit-bundles');
      return { ok: true, built: [], skipped: packageNames };
    },
    withWorkspaceBundleLock: async (publish, options) => {
      assert.equal(options.lockPath, resolveWorkspaceBundleLockPath(repoRoot));
      assert.equal(options.timeoutMs, DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS);
      assert.equal(options.staleAfterMs, DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS);
      events.push('lock');
      return await publish({ heldLockValue: 'test-owner' });
    },
    loadCliCommonWorkspacesModule: async () => ({
      resolveWorkspaceBundlesFromPackageJson: () => {
        events.push('resolve-bundles');
        return [{ packageName: '@happier-dev/protocol' }];
      },
      bundleWorkspacePackagesWithRuntimeDependencies: ({ publicationMode }) => {
        events.push(`bundle:${publicationMode}`);
      },
    }),
  });

  assert.deepEqual(events, [
    'resolve-bundles',
    'admit-bundles',
    'lock',
    'bundle:artifact',
  ]);
});

test('plugin-sdk artifact bundling rebuilds newer stale workspace output from current source', async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'happy-plugin-sdk-artifact-admission-'));
  const pluginSdkDir = resolve(repoRoot, 'packages', 'plugin-sdk');
  const protocolDir = resolve(repoRoot, 'packages', 'protocol');
  const protocolSourcePath = resolve(protocolDir, 'src', 'index.ts');
  const protocolDistPath = resolve(protocolDir, 'dist', 'index.js');
  const admissionCalls = [];
  let bundledProtocolContents = null;

  try {
    await mkdir(resolve(protocolDir, 'src'), { recursive: true });
    await mkdir(resolve(protocolDir, 'dist'), { recursive: true });
    await writeFile(protocolSourcePath, 'export const generation = "current";\n', 'utf8');
    await writeFile(protocolDistPath, 'export const generation = "stale";\n', 'utf8');
    const now = Date.now();
    await utimes(protocolSourcePath, new Date(now), new Date(now));
    await utimes(protocolDistPath, new Date(now + 10_000), new Date(now + 10_000));

    await bundleWorkspaceDeps({
      repoRoot,
      pluginSdkDir,
      publicationMode: 'artifact',
      withWorkspaceBundleLock: async (publish) => await publish({ heldLockValue: 'test-owner' }),
      ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
        admissionCalls.push({ packageNames, force: options?.force });
        if (options?.force === true && packageNames.includes('@happier-dev/protocol')) {
          await writeFile(protocolDistPath, 'export const generation = "current";\n', 'utf8');
        }
        return { ok: true, built: options?.force === true ? packageNames : [], skipped: [] };
      },
      loadCliCommonWorkspacesModule: async (
        root,
        _env,
        ensureWorkspacePackagesBuiltByName,
        options,
      ) => {
        await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/cli-common'], options);
        return {
          resolveWorkspaceBundlesFromPackageJson: () => [{
            packageName: '@happier-dev/protocol',
            srcDir: protocolDir,
            destDir: resolve(pluginSdkDir, 'node_modules', '@happier-dev', 'protocol'),
          }],
          bundleWorkspacePackagesWithRuntimeDependencies: ({ bundles }) => {
            assert.equal(bundles.length, 1);
            bundledProtocolContents = readFileSync(protocolDistPath, 'utf8');
          },
        };
      },
    });

    assert.equal(bundledProtocolContents, 'export const generation = "current";\n');
    assert.deepEqual(admissionCalls, [
      { packageNames: ['@happier-dev/cli-common'], force: true },
      { packageNames: ['@happier-dev/protocol'], force: true },
    ]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('plugin-sdk live bundling keeps workspace admission incremental', async () => {
  const admissionCalls = [];
  const publications = [];

  await bundleWorkspaceDeps({
    repoRoot: '/repo',
    pluginSdkDir: '/repo/packages/plugin-sdk',
    publicationMode: 'live',
    withWorkspaceBundleLock: async (publish) => await publish({ heldLockValue: 'test-owner' }),
    ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
      admissionCalls.push({ packageNames, force: options?.force });
      return { ok: true, built: [], skipped: packageNames };
    },
    loadCliCommonWorkspacesModule: async (
      root,
      _env,
      ensureWorkspacePackagesBuiltByName,
      options,
    ) => {
      await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/cli-common'], options);
      return {
        resolveWorkspaceBundlesFromPackageJson: () => [{ packageName: '@happier-dev/protocol' }],
        bundleWorkspacePackagesWithRuntimeDependencies: (options) => {
          publications.push(options);
        },
      };
    },
  });

  assert.deepEqual(admissionCalls, [
    { packageNames: ['@happier-dev/cli-common'], force: false },
    { packageNames: ['@happier-dev/protocol'], force: undefined },
  ]);
  assert.deepEqual(publications, [{
    bundles: [{ packageName: '@happier-dev/protocol' }],
    publicationMode: 'live',
    pruneStale: undefined,
  }]);
});
