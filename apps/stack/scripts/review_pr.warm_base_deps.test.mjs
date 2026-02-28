import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', rejectPromise);
    proc.on('exit', (code, signal) => resolvePromise({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

function toDataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function parseJsonl(p) {
  const raw = await (await import('node:fs/promises')).readFile(p, 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('review-pr warms cached workspace deps when shouldRunYarnInstall returns true', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-pr-warm-deps-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const homeDir = join(tmp, 'home');
  const wsDir = join(homeDir, 'cache', 'sandbox', 'workspace');
  const mainDir = join(wsDir, 'main');
  await mkdir(join(mainDir, '.git'), { recursive: true });
  await writeFile(join(mainDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(mainDir, 'yarn.lock'), '#\n', 'utf-8');

  const markerPath = join(tmp, 'calls.jsonl');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register-loader.mjs');
  await writeFile(markerPath, '', 'utf-8');

  const stubBySpecifier = {
    'node:child_process': toDataUrl(`
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

function log(call) {
  const p = process.env.HSTACK_REVIEW_PR_MARKER;
  if (!p) return;
  appendFileSync(p, JSON.stringify(call) + '\\n', 'utf-8');
}

export function spawn(cmd, args, options = {}) {
  log({ kind: 'spawn', cmd, args, options: { cwd: options.cwd ?? null, env: options.env ?? null } });
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}
`),
    './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
`),
    './utils/git/fast_forward_to_remote.mjs': toDataUrl(`
export async function fastForwardBranchToRemote() {
  return { ok: true, updated: false, reason: 'up-to-date' };
}
`),
    './utils/git/default_branch.mjs': toDataUrl(`
export async function resolveDefaultRemoteBranch() {
  return 'main';
}
`),
    './utils/worktrees/yarn_install_guard.mjs': toDataUrl(`
export async function shouldRunYarnInstall() { return true; }
`),
    './utils/proc/pm.mjs': toDataUrl(`
export async function applyStackCacheEnv(env) { return env; }
`),
    './utils/proc/proc.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';
const p = process.env.HSTACK_REVIEW_PR_MARKER;
export async function run(cmd, args, options = {}) {
  if (p) appendFileSync(p, JSON.stringify({ kind: 'run', cmd, args, options: { cwd: options.cwd ?? null, env: options.env ?? null, stdio: options.stdio ?? null } }) + '\\n', 'utf-8');
}
`),
  };

  const loaderSource = `
const stubBySpecifier = ${JSON.stringify(stubBySpecifier)};
export async function resolve(specifier, context, defaultResolve) {
  const stub = stubBySpecifier[specifier];
  if (stub) return { url: stub, shortCircuit: true };
  return defaultResolve(specifier, context, defaultResolve);
}
`;
  await writeFile(loaderPath, loaderSource, 'utf-8');
  await writeFile(
    registerPath,
    [
      `import { register } from 'node:module';`,
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HSTACK_REVIEW_PR_MARKER: markerPath,
  };

  const res = await runNode(
    ['--import', registerPath, join(rootDir, 'scripts', 'review_pr.mjs'), '--repo=58', '--json'],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const calls = await parseJsonl(markerPath);
  const yarnRun = calls.find((c) => c.kind === 'run' && c.cmd === 'yarn' && Array.isArray(c.args) && c.args[0] === 'install');
  assert.ok(yarnRun, `expected a yarn install run call\n${JSON.stringify(calls, null, 2)}`);
  assert.equal(resolve(String(yarnRun.options.cwd)), resolve(mainDir));
  const pmCacheBase = join(homeDir, 'cache', 'sandbox', 'pm');
  assert.equal(resolve(String(yarnRun.options.env.HAPPIER_STACK_PM_CACHE_BASE_DIR)), resolve(pmCacheBase));
});
