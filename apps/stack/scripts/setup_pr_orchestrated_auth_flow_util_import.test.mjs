import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

function toDataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

test('setup_pr guided-login path delegates to orchestrated auth flow helpers at runtime', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-setup-pr-orchestrated-'));
  try {
    const markerPath = join(tmp, 'orchestrated.markers.log');
    const loaderPath = join(tmp, 'loader.mjs');
    const registerPath = join(tmp, 'register-loader.mjs');
    await writeFile(markerPath, '', 'utf-8');

    const stubBySpecifier = {
      './utils/cli/prereqs.mjs': toDataUrl(`
export async function assertCliPrereqs() {}
`),
      './utils/proc/proc.mjs': toDataUrl(`
export async function run() {}
`),
      './utils/auth/guided_pr_auth.mjs': toDataUrl(`
export async function decidePrAuthPlan() {
  return { mode: 'login', loginNow: true };
}
`),
      './utils/auth/orchestrated_stack_auth_flow.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';
const markerPath = process.env.HSTACK_SETUP_PR_MARKER;
function mark(name) {
  if (!markerPath) return;
  appendFileSync(markerPath, String(name) + '\\n', 'utf-8');
}
export async function runOrchestratedGuidedAuthFlow() {
  mark('runOrchestratedGuidedAuthFlow');
  return { ok: true, webappUrl: 'http://127.0.0.1:3010' };
}
export async function startDaemonPostAuth() {
  mark('startDaemonPostAuth');
  return { ok: true };
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
      HAPPIER_STACK_TEST_TTY: '1',
      HAPPIER_STACK_VERBOSE: '1',
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
      HAPPIER_STACK_WORKSPACE_DIR: join(tmp, 'workspace'),
      HSTACK_SETUP_PR_MARKER: markerPath,
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
      ],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const markerLog = await readFile(markerPath, 'utf-8');
    assert.match(markerLog, /\brunOrchestratedGuidedAuthFlow\b/, `expected setup_pr to call runOrchestratedGuidedAuthFlow\n${markerLog}`);
    assert.match(markerLog, /\bstartDaemonPostAuth\b/, `expected setup_pr to call startDaemonPostAuth\n${markerLog}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
