import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('startDaemonPostAuth passes webapp URL to daemon env (never internal API URL)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-flow-webapp-url-'));
  try {
    const stackName = 'main';
    const storageDir = join(tmp, 'storage');
    const stackDir = join(storageDir, stackName);
    const envPath = join(stackDir, 'env');
    const markerPath = join(tmp, 'daemon-input.json');

    await mkdir(stackDir, { recursive: true });
    await writeFile(
      envPath,
      ['HAPPIER_STACK_STACK=main', 'HAPPIER_WEBAPP_URL=http://localhost:3010', ''].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({ version: 1, stackName, ownerPid: process.pid, ports: { server: 4102 } }, null, 2),
      'utf-8'
    );

    const loaderPath = join(tmp, 'loader.mjs');
    const registerPath = join(tmp, 'register-loader.mjs');
    const runnerPath = join(tmp, 'runner.mjs');

    const stubBySpecifier = {
      '../../daemon.mjs': toDataUrl(`
import { writeFileSync } from 'node:fs';
export async function startLocalDaemonWithAuth(input) {
  const marker = process.env.HSTACK_AUTH_FLOW_DAEMON_MARKER;
  if (marker) writeFileSync(marker, JSON.stringify(input), 'utf-8');
}
export function checkDaemonState() {
  return { status: 'running', pid: 12345 };
}
`),
    };

    await writeFile(
      loaderPath,
      `
const stubBySpecifier = ${JSON.stringify(stubBySpecifier)};
export async function resolve(specifier, context, defaultResolve) {
  const stub = stubBySpecifier[specifier];
  if (stub) return { url: stub, shortCircuit: true };
  return defaultResolve(specifier, context, defaultResolve);
}
`,
      'utf-8'
    );
    await writeFile(
      registerPath,
      `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);
`,
      'utf-8'
    );

    await writeFile(
      runnerPath,
      `
import { startDaemonPostAuth } from ${JSON.stringify(pathToFileURL(join(scriptsDir, 'utils', 'auth', 'orchestrated_stack_auth_flow.mjs')).href)};
await startDaemonPostAuth({
  rootDir: ${JSON.stringify(rootDir)},
  stackName: 'main',
  env: process.env,
  forceRestart: true,
});
`,
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_SERVER_PORT: '4102',
      HSTACK_AUTH_FLOW_DAEMON_MARKER: markerPath,
    };
    const res = await runNode(['--import', registerPath, runnerPath], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const markerRaw = await readFile(markerPath, 'utf-8');
    const marker = JSON.parse(markerRaw);
    assert.equal(marker.internalServerUrl, 'http://127.0.0.1:4102');
    assert.equal(marker.publicServerUrl, 'http://localhost:3010');
    assert.notEqual(marker.publicServerUrl, marker.internalServerUrl);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
