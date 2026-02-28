import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function readMarker(markerPath) {
  const raw = await readFile(markerPath, 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

test('setup-pr mobile in sandbox defaults to dev-client scheme (not happier://)', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-setup-pr-mobile-scheme-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const markerPath = join(tmp, 'markers.log');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register-loader.mjs');
  await writeFile(markerPath, '', 'utf-8');

  const stubBySpecifier = {
    './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
`),
    './utils/auth/guided_pr_auth.mjs': toDataUrl(`
export async function decidePrAuthPlan() {
  return { mode: 'existing' };
}
`),
    './utils/proc/proc.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';
const markerPath = process.env.HSTACK_SETUP_PR_MARKER;
function mark(line) {
  if (!markerPath) return;
  appendFileSync(markerPath, String(line) + '\\n', 'utf-8');
}
export async function run(_cmd, args, { env } = {}) {
  const script = String(args?.[0] ?? '').split(/[\\\\/]/).pop();
  if (script === 'stack.mjs') {
    mark('stack.mobileScheme=' + String(env?.HAPPIER_STACK_MOBILE_SCHEME ?? ''));
    mark('stack.devClientScheme=' + String(env?.HAPPIER_STACK_DEV_CLIENT_SCHEME ?? ''));
    mark('stack.reviewOverride=' + String(env?.HAPPIER_STACK_REVIEW_MOBILE_SCHEME ?? ''));
    mark('stack.sandbox=' + String(env?.HAPPIER_STACK_SANDBOX_DIR ?? ''));
  }
  return { status: 0 };
}
export async function runCapture() {
  return '';
}
export async function runCaptureResult() {
  return { ok: true, status: 0, exitCode: 0, signal: null, out: '', err: '', durationMs: 0 };
}
export function spawnProc() {
  return { pid: 123, stdout: null, stderr: null, on() {}, kill() {} };
}
export function killProcessTree() {}
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
    HSTACK_SETUP_PR_MARKER: markerPath,
    HAPPIER_STACK_SANDBOX_DIR: join(tmp, 'sandbox'),
    HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
    HAPPIER_STACK_WORKSPACE_DIR: join(tmp, 'workspace'),
  };

  const res = await runNode(
    [
      '--import',
      registerPath,
      join(rootDir, 'scripts', 'setup_pr.mjs'),
      '--repo=123',
      '--name=pr123',
      '--dev',
      '--no-seed-auth',
      '--mobile',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const lines = await readMarker(markerPath);
  const mobileScheme = lines.find((l) => l.startsWith('stack.mobileScheme=')) ?? '';
  assert.equal(mobileScheme, 'stack.mobileScheme=hstack-dev');
});

test('setup-pr ignores HAPPIER_STACK_DEV_CLIENT_SCHEME in sandbox without review override', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-setup-pr-mobile-scheme-explicit-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const markerPath = join(tmp, 'markers.log');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register-loader.mjs');
  await writeFile(markerPath, '', 'utf-8');

  const stubBySpecifier = {
    './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
`),
    './utils/auth/guided_pr_auth.mjs': toDataUrl(`
export async function decidePrAuthPlan() {
  return { mode: 'existing' };
}
`),
    './utils/proc/proc.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';
const markerPath = process.env.HSTACK_SETUP_PR_MARKER;
function mark(line) {
  if (!markerPath) return;
  appendFileSync(markerPath, String(line) + '\\n', 'utf-8');
}
export async function run(_cmd, args, { env } = {}) {
  const script = String(args?.[0] ?? '').split(/[\\\\/]/).pop();
  if (script === 'stack.mjs') {
    mark('stack.mobileScheme=' + String(env?.HAPPIER_STACK_MOBILE_SCHEME ?? ''));
    mark('stack.devClientScheme=' + String(env?.HAPPIER_STACK_DEV_CLIENT_SCHEME ?? ''));
  }
  return { status: 0 };
}
export async function runCapture() {
  return '';
}
export async function runCaptureResult() {
  return { ok: true, status: 0, exitCode: 0, signal: null, out: '', err: '', durationMs: 0 };
}
export function spawnProc() {
  return { pid: 123, stdout: null, stderr: null, on() {}, kill() {} };
}
export function killProcessTree() {}
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
    HSTACK_SETUP_PR_MARKER: markerPath,
    HAPPIER_STACK_SANDBOX_DIR: join(tmp, 'sandbox'),
    HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
    HAPPIER_STACK_WORKSPACE_DIR: join(tmp, 'workspace'),
    HAPPIER_STACK_DEV_CLIENT_SCHEME: 'happier-dev',
  };

  const res = await runNode(
    [
      '--import',
      registerPath,
      join(rootDir, 'scripts', 'setup_pr.mjs'),
      '--repo=123',
      '--name=pr123',
      '--dev',
      '--no-seed-auth',
      '--mobile',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const lines = await readMarker(markerPath);
  const mobileScheme = lines.find((l) => l.startsWith('stack.mobileScheme=')) ?? '';
  assert.equal(mobileScheme, 'stack.mobileScheme=hstack-dev');
});

test('setup-pr honors HAPPIER_STACK_REVIEW_MOBILE_SCHEME in sandbox', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-setup-pr-mobile-scheme-review-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const markerPath = join(tmp, 'markers.log');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register-loader.mjs');
  await writeFile(markerPath, '', 'utf-8');

  const stubBySpecifier = {
    './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
`),
    './utils/auth/guided_pr_auth.mjs': toDataUrl(`
export async function decidePrAuthPlan() {
  return { mode: 'existing' };
}
`),
    './utils/proc/proc.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';
const markerPath = process.env.HSTACK_SETUP_PR_MARKER;
function mark(line) {
  if (!markerPath) return;
  appendFileSync(markerPath, String(line) + '\\n', 'utf-8');
}
export async function run(_cmd, args, { env } = {}) {
  const script = String(args?.[0] ?? '').split(/[\\\\/]/).pop();
  if (script === 'stack.mjs') {
    mark('stack.mobileScheme=' + String(env?.HAPPIER_STACK_MOBILE_SCHEME ?? ''));
    mark('stack.reviewOverride=' + String(env?.HAPPIER_STACK_REVIEW_MOBILE_SCHEME ?? ''));
  }
  return { status: 0 };
}
export async function runCapture() {
  return '';
}
export async function runCaptureResult() {
  return { ok: true, status: 0, exitCode: 0, signal: null, out: '', err: '', durationMs: 0 };
}
export function spawnProc() {
  return { pid: 123, stdout: null, stderr: null, on() {}, kill() {} };
}
export function killProcessTree() {}
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
    HSTACK_SETUP_PR_MARKER: markerPath,
    HAPPIER_STACK_SANDBOX_DIR: join(tmp, 'sandbox'),
    HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
    HAPPIER_STACK_WORKSPACE_DIR: join(tmp, 'workspace'),
    HAPPIER_STACK_REVIEW_MOBILE_SCHEME: 'hstack-dev',
  };

  const res = await runNode(
    [
      '--import',
      registerPath,
      join(rootDir, 'scripts', 'setup_pr.mjs'),
      '--repo=123',
      '--name=pr123',
      '--dev',
      '--no-seed-auth',
      '--mobile',
      '--json',
    ],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const lines = await readMarker(markerPath);
  const mobileScheme = lines.find((l) => l.startsWith('stack.mobileScheme=')) ?? '';
  assert.equal(mobileScheme, 'stack.mobileScheme=hstack-dev');
});
