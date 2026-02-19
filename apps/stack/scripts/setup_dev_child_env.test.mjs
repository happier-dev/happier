import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += String(d);
    });
    proc.stderr.on('data', (d) => {
      stderr += String(d);
    });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function toDataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

test('hstack setup --profile=dev passes setup-child env to workspace-aware setup steps', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-setup-dev-child-'));

  const markerPath = join(tmp, 'calls.log');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register.mjs');
  const workspaceDir = join(tmp, 'workspace');

  const stubBySpecifier = {
    './utils/proc/proc.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';

const markerPath = ${JSON.stringify(markerPath)};

function mark(payload) {
  appendFileSync(markerPath, String(payload) + '\\n', 'utf-8');
}

export function spawnProc() {
  return null;
}

export async function run(_cmd, args, { env } = {}) {
  mark(JSON.stringify({
    type: 'run',
    args,
    workspace: String(env?.HAPPIER_STACK_WORKSPACE_DIR ?? ''),
    setupChild: String(env?.HAPPIER_STACK_SETUP_CHILD ?? ''),
  }));
  return { status: 0, stdout: '', stderr: '' };
}

export async function runCapture(_cmd, args, { env } = {}) {
  mark(JSON.stringify({
    type: 'runCapture',
    args,
    workspace: String(env?.HAPPIER_STACK_WORKSPACE_DIR ?? ''),
    setupChild: String(env?.HAPPIER_STACK_SETUP_CHILD ?? ''),
  }));
  return '';
}
`),
    './utils/stack/stacks.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';

const markerPath = ${JSON.stringify(markerPath)};

function mark(payload) {
  appendFileSync(markerPath, String(payload) + '\\n', 'utf-8');
}

export function listAllStackNames() {
  mark(JSON.stringify({ type: 'listAllStackNames' }));
  return ['main'];
}

export function stackExistsSync(name) {
  const env = arguments.length > 1 ? arguments[1] : process.env;
  mark(JSON.stringify({
    type: 'stackExistsSync',
    name: String(name),
    workspace: String(env?.HAPPIER_STACK_WORKSPACE_DIR ?? ''),
    setupChild: String(env?.HAPPIER_STACK_SETUP_CHILD ?? ''),
    gotEnvArg: arguments.length > 1,
  }));
  return false;
}
`),
    './utils/git/dev_checkout.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';

const markerPath = ${JSON.stringify(markerPath)};

function mark(payload) {
  appendFileSync(markerPath, String(payload) + '\\n', 'utf-8');
}

export async function ensureDevCheckout({ env }) {
  mark(
    JSON.stringify({
      type: 'ensureDevCheckout',
      workspace: String(env?.HAPPIER_STACK_WORKSPACE_DIR ?? ''),
      setupChild: String(env?.HAPPIER_STACK_SETUP_CHILD ?? ''),
    })
  );
}
`),
    './utils/env/env_local.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';

const markerPath = ${JSON.stringify(markerPath)};

function mark(payload) {
  appendFileSync(markerPath, String(payload) + '\\n', 'utf-8');
}

export async function ensureEnvLocalUpdated() {
  mark(JSON.stringify({ type: 'ensureEnvLocalUpdated' }));
}
`),
    './utils/proc/commands.mjs': toDataUrl(`
export async function resolveCommandPath(cmd) {
  return String(cmd ?? '');
}

export async function runCaptureIfCommandExists(cmd, args, options) {
  const commandPath = await resolveCommandPath(cmd, options);
  if (!commandPath) {
    return '';
  }
  return '';
}

export async function commandExists() {
  return true;
}
`),
  };

  const loaderSource = `
const stubBySpecifier = ${JSON.stringify(stubBySpecifier)};

export async function resolve(specifier, context, defaultResolve) {
  const stub = stubBySpecifier[specifier];
  if (stub) {
    return { url: stub, shortCircuit: true };
  }
  return defaultResolve(specifier, context, defaultResolve);
}
`;

  await writeFile(loaderPath, loaderSource, 'utf-8');
  await writeFile(registerPath, [
    `import { register } from 'node:module';`,
    `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
    '',
  ].join('\n'), 'utf-8');

  const env = {
    ...process.env,
    HAPPIER_STACK_TEST_TTY: '1',
    HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
  };

  try {
    const res = await runNode(
      [
        '--import',
        registerPath,
        join(rootDir, 'scripts', 'setup.mjs'),
        '--profile=dev',
        '--server=happier-server-light',
        '--non-interactive',
        '--no-auth',
        '--no-start-now',
        '--no-autostart',
        '--no-menubar',
        '--no-tailscale',
        `--workspace-dir=${workspaceDir}`,
      ],
      { cwd: rootDir, env }
    );

    assert.equal(res.code, 0, `expected setup to exit 0, got ${res.code}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const markerText = await readFile(markerPath, 'utf-8');
    if (!String(markerText).trim()) {
      throw new Error('expected marker file to contain command traces');
    }
    const records = markerText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const hasArgEndsWith = (entry, suffix) => (entry.args ?? []).some((arg) => basename(String(arg)).startsWith(suffix));
    const initCalls = records.filter((record) => record.type === 'run' && hasArgEndsWith(record, 'init.mjs'));
    const installCalls = records.filter((record) => record.type === 'run' && hasArgEndsWith(record, 'install.mjs'));
    const stackCreateCalls = records.filter(
      (record) => record.type === 'run' && (record.args ?? []).includes('new') && (record.args ?? []).includes('dev')
    );

    assert.ok(initCalls.length >= 1, 'expected init command to run');
    assert.ok(installCalls.length >= 1, 'expected install command to run');
    assert.ok(stackCreateCalls.length >= 1, 'expected dev stack creation command to run');

    for (const call of [...initCalls, ...installCalls, ...stackCreateCalls]) {
      assert.equal(call.setupChild, '1', `expected setup-child marker, got ${call.setupChild}`);
      assert.equal(call.workspace, workspaceDir, `expected workspace dir propagation, got ${call.workspace}`);
    }

    const checkoutCall = records.find((record) => record.type === 'ensureDevCheckout');
    assert.ok(checkoutCall, 'expected ensureDevCheckout to run');
    assert.equal(checkoutCall.setupChild, '1', `expected setup-child marker on ensureDevCheckout, got ${checkoutCall.setupChild}`);
    assert.equal(checkoutCall.workspace, workspaceDir, `expected workspace propagation on ensureDevCheckout, got ${checkoutCall.workspace}`);

    const stackCheck = records.find((record) => record.type === 'stackExistsSync');
    assert.ok(stackCheck, 'expected stack existence check for dev stack');
    assert.equal(stackCheck.gotEnvArg, true, 'expected stackExistsSync to receive explicit setup env for existence checks');
    assert.equal(stackCheck.setupChild, '1', `expected setup-child marker on stackExistsSync, got ${stackCheck.setupChild}`);
    assert.equal(stackCheck.workspace, workspaceDir, `expected workspace propagation on stackExistsSync, got ${stackCheck.workspace}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
