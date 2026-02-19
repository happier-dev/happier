import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function writeHappyMonorepoStub({ repoDir }) {
  await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

test('hstack setup --profile=local-repo creates a dedicated stack without bootstrapping/cloning', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-setup-local-repo-'));

  const markerPath = join(tmp, 'calls.log');
  const loaderPath = join(tmp, 'loader.mjs');
  const registerPath = join(tmp, 'register.mjs');

  const repoDir = join(tmp, 'repo');
  await writeHappyMonorepoStub({ repoDir });

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
    './utils/env/env_local.mjs': toDataUrl(`
export async function ensureEnvLocalUpdated() {}
`),
    './utils/proc/commands.mjs': toDataUrl(`
export async function commandExists() { return true; }
export async function resolveCommandPath(cmd) { return String(cmd ?? ''); }
export async function runCaptureIfCommandExists() { return ''; }
`),
    './utils/stack/stacks.mjs': toDataUrl(`
export function stackExistsSync() { return false; }
export async function listAllStackNames() { return ['main']; }
`),
    './utils/git/dev_checkout.mjs': toDataUrl(`
export async function ensureDevCheckout() {
  throw new Error('ensureDevCheckout should not run for local-repo profile');
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
        '--profile=local-repo',
        '--server=happier-server-light',
        '--non-interactive',
        '--no-auth',
        '--no-start-now',
        '--no-autostart',
        '--no-menubar',
        '--no-tailscale',
        `--repo-dir=${repoDir}`,
      ],
      { cwd: rootDir, env }
    );

    assert.equal(res.code, 0, `expected setup to exit 0, got ${res.code}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const markerText = await readFile(markerPath, 'utf-8');
    const records = markerText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const hasScript = (entry, suffix) => (entry.args ?? []).some((arg) => basename(String(arg)).startsWith(suffix));
    const initCalls = records.filter((r) => r.type === 'run' && hasScript(r, 'init.mjs'));
    const installCalls = records.filter((r) => r.type === 'run' && hasScript(r, 'install.mjs'));
    assert.ok(initCalls.length >= 1, 'expected init command to run');
    assert.equal(installCalls.length, 0, 'expected bootstrap/install not to run for local-repo profile');

    const stackNewCalls = records.filter(
      (r) => r.type === 'run' && (r.args ?? []).includes('new') && (r.args ?? []).includes('--non-interactive')
    );
    assert.ok(stackNewCalls.length >= 1, 'expected stack creation command to run');
    const args = stackNewCalls[0]?.args ?? [];
    assert.ok(args.includes('local'), `expected default stack name "local" in args, got ${JSON.stringify(args)}`);
    assert.ok(args.some((a) => String(a).startsWith(`--repo=${repoDir}`)), `expected --repo to point at repoDir, got ${JSON.stringify(args)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

