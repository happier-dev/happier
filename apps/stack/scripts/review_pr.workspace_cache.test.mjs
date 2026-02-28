import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function parseSpawnLog(markerPath) {
  const raw = await readFile(markerPath, 'utf-8');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

function findSetupPrCall(calls) {
  return calls.find((c) => Array.isArray(c.args) && c.args.includes('setup-pr')) ?? null;
}

test('review-pr defaults to a persistent workspace cache (sandbox keeps home/runtime/storage isolated)', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-pr-workspace-cache-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const markerPath = join(tmp, 'spawn.calls.jsonl');
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
  log({ cmd, args, options: { cwd: options.cwd ?? null, env: options.env ?? null } });
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}
`),
    './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
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

  const homeDir = join(tmp, 'home');
  const expectedWorkspace = resolve(join(homeDir, 'cache', 'sandbox', 'workspace'));

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HSTACK_REVIEW_PR_MARKER: markerPath,
  };

  const res = await runNode(
    [
      '--import',
      registerPath,
      join(rootDir, 'scripts', 'review_pr.mjs'),
      '--repo=58',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const calls = await parseSpawnLog(markerPath);
  const setupPr = findSetupPrCall(calls);
  assert.ok(setupPr, `expected a setup-pr spawn call\n${JSON.stringify(calls, null, 2)}`);

  const got = setupPr?.options?.env?.HAPPIER_STACK_SANDBOX_WORKSPACE_DIR ?? '';
  assert.equal(resolve(String(got)), expectedWorkspace);
});

test('review-pr supports opting out of workspace cache', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-review-pr-no-cache-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const markerPath = join(tmp, 'spawn.calls.jsonl');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register-loader.mjs');
  await writeFile(markerPath, '', 'utf-8');

  const stubBySpecifier = {
    'node:child_process': toDataUrl(`
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
const p = process.env.HSTACK_REVIEW_PR_MARKER;
export function spawn(cmd, args, options = {}) {
  if (p) appendFileSync(p, JSON.stringify({ cmd, args, options: { env: options.env ?? null } }) + '\\n', 'utf-8');
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}
`),
    './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
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
    HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    HSTACK_REVIEW_PR_MARKER: markerPath,
  };

  const res = await runNode(
    [
      '--import',
      registerPath,
      join(rootDir, 'scripts', 'review_pr.mjs'),
      '--repo=58',
      '--no-workspace-cache',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const calls = await parseSpawnLog(markerPath);
  const setupPr = findSetupPrCall(calls);
  assert.ok(setupPr, `expected a setup-pr spawn call\n${JSON.stringify(calls, null, 2)}`);

  assert.equal(Boolean(setupPr?.options?.env?.HAPPIER_STACK_SANDBOX_WORKSPACE_DIR), false);
});
