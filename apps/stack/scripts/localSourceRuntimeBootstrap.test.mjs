import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
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
