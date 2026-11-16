import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork, spawnSync } from 'node:child_process';

const sourceBootstrapRepoDir = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRuntimePreload = new URL('../bin/localSourceRuntimeBootstrap.mjs', import.meta.url).href;

function observeColdSourcePreload(entry) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks, isBuiltin } from 'node:module';
    import { resolve } from 'node:path';
    const externalRequests = [];
    // Module resolution is the external boundary: model a cold installation
    // without removing or changing this worker's installed dependencies.
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (!isBuiltin(specifier) && !specifier.startsWith('.')
          && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
        externalRequests.push(specifier);
        throw Object.assign(new Error('Fixture package is not installed'), { code: 'ERR_MODULE_NOT_FOUND' });
      }
      return nextResolve(specifier, context);
    } });
    process.argv[1] = resolve(${JSON.stringify(sourceBootstrapRepoDir)}, ${JSON.stringify(entry)});
    let failure = null;
    try { await import(${JSON.stringify(sourceRuntimePreload)}); }
    catch (error) { failure = error.code ?? String(error); }
    console.log(JSON.stringify({ failure, externalRequests }));
  `], {
    cwd: sourceBootstrapRepoDir,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('dependency preparation starts without loading packages it must install', () => {
  assert.deepEqual(observeColdSourcePreload('apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs'), {
    failure: null,
    externalRequests: [],
  });
});

test('ordinary source tools retain source runtime registration', () => {
  const result = observeColdSourcePreload('apps/stack/scripts/utils/dev_targets/qa_browser.mjs');
  assert.equal(result.failure, 'ERR_MODULE_NOT_FOUND');
  assert.deepEqual(result.externalRequests, ['tsx']);
});

test('OS custody runs without loading source tooling or installed dependencies', async t => {
  if (process.platform === 'win32') return t.skip('POSIX foreground group custody');
  const root = await mkdtemp(join(tmpdir(), 'happier-os-custody-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  // Copy the real OS-only closure. There is deliberately no installed tree:
  // listener and process observations must remain usable during dependency refresh.
  for (const relative of ['apps/stack/bin/localSourceRuntimeBootstrap.mjs',
    'apps/stack/scripts/utils',
    'packages/cli-common']) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await cp(join(repo, relative), join(root, relative), { recursive: true,
      filter: source => !source.includes('/node_modules') && !source.includes('/dist') });
  }
  const entry = join(root, 'apps/stack/scripts/utils/proc/proc.mjs');
  const preload = join(root, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs');
  const invocation = { command: process.execPath, args: ['-e', 'process.stdout.write("OS_PROBE_OK")'],
    spawnOptions: { env: { ...process.env, NODE_OPTIONS: '' } } };
  const child = fork(entry, ['--happier-foreground-custody', JSON.stringify(invocation)], {
    detached: true, execArgv: [], env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'OS_PROBE_OK');
});

// P03-TOOLING-ISOLATION: tooling runs live from the shared checkout, but a
// half-landed product package edit (an import of a missing export, a deleted
// file still imported at HEAD) must not break every stack start and reload.
test('checkout tooling loads product packages at the committed revision, on the controller and on a Git-less mirror', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tooling-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const controller = join(root, 'controller');
  for (const relative of ['apps/stack/bin', 'apps/stack/scripts/utils']) {
    await cp(join(repo, relative), join(controller, relative), { recursive: true, filter: source => !source.includes('/node_modules') });
  }
  // The source runtime's own registration leaf (root modules only; package sources are not needed).
  await cp(join(repo, 'packages/cli-common'), join(controller, 'packages/cli-common'), { recursive: true,
    filter: source => source === join(repo, 'packages/cli-common') || /\.(?:mjs|cjs|json)$/u.test(source) && dirname(source) === join(repo, 'packages/cli-common') });
  const write = async (relative, contents) => {
    await mkdir(dirname(join(controller, relative)), { recursive: true });
    await writeFile(join(controller, relative), contents);
  };
  await write('packages/protocol/package.json', JSON.stringify({ name: '@happier-dev/protocol', type: 'module',
    exports: { './*': { 'happier-source': './src/*.ts' } } }));
  await write('packages/protocol/src/scm.ts', 'export const ScmRefusal: string = "committed";\n');
  await write('packages/protocol/src/helper.ts', 'export const helper = (value: string): string => `${value}+helper`;\n');
  await write('packages/protocol/src/actions.ts', 'import { ScmRefusal } from "./scm.js";\nimport { helper } from "./helper.js";\nexport const value = helper(ScmRefusal);\n');
  await write('apps/stack/scripts/probe.mjs', 'const { value } = await import("@happier-dev/protocol/actions");\nprocess.stdout.write(value);\n');
  const git = args => {
    const result = spawnSync('git', ['-C', controller, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  await symlink(join(repo, 'node_modules'), join(controller, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Another lane's half-landed edit: the import lands before its export, and a helper moved away.
  await write('packages/protocol/src/actions.ts', 'import { ScmMissingRefusal } from "./scm.js";\nexport const value = ScmMissingRefusal;\n');
  await rm(join(controller, 'packages/protocol/src/helper.ts'));
  const probe = (checkout, env = {}) => spawnSync(process.execPath, ['--conditions=happier-source',
    `--import=${pathToFileURL(join(checkout, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs')).href}`,
    join(checkout, 'apps/stack/scripts/probe.mjs')], { cwd: checkout, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_TOOLING_PACKAGES: '', ...env } });
  const pinned = probe(controller);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, 'committed+helper');
  // The opt-out (and the old behavior) loads the half-landed checkout bytes.
  const live = probe(controller, { HAPPIER_STACK_TOOLING_PACKAGES: 'live' });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /ScmMissingRefusal/u);
  // An execution host's mirror has no Git: it reads the synchronized pin the controller wrote.
  const mirror = join(root, 'mirror');
  await cp(controller, mirror, { recursive: true, verbatimSymlinks: true, filter: source => source !== join(controller, '.git') });
  const fromMirror = probe(mirror);
  assert.equal(fromMirror.status, 0, fromMirror.stderr);
  assert.equal(fromMirror.stdout, 'committed+helper');
});
