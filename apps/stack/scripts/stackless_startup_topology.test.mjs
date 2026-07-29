import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(dirname(scriptsDir)));
const entrypoints = [
  { name: 'run', script: join(scriptsDir, 'run.mjs'), args: ['--source', '--no-daemon', '--no-ui'] },
  { name: 'dev', script: join(scriptsDir, 'dev.mjs'), args: ['--no-daemon', '--no-ui', '--no-mobile'] },
];

function listenHealthFixture({ status, respond = true }) {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      if (!respond) return;
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
    }));
  });
}

function runStartup(entrypoint, port, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of [
      'HAPPIER_STACK_STACK',
      'HAPPIER_STACK_ENV_FILE',
      'HAPPIER_STACK_RUNTIME_STATE_PATH',
      'HAPPIER_STACK_STORAGE_DIR',
      'HAPPIER_STACK_REPO_DIR',
    ]) delete env[key];
    Object.assign(env, {
      CI: '1',
      HAPPIER_STACK_HOME_DIR: join('/tmp', `hstack-stackless-topology-${process.pid}`),
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      HAPPIER_STACK_SERVER_PORT: String(port),
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_NO_BROWSER: '1',
    });
    const child = spawn(process.execPath, [entrypoint.script, ...entrypoint.args, ...extraArgs], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

for (const entrypoint of entrypoints) {
  test(`${entrypoint.name} stackless startup adopts a healthy occupied endpoint without ownership`, async (t) => {
    const fixture = await listenHealthFixture({ status: 200 });
    t.after(() => fixture.server.close());

    const result = await runStartup(entrypoint, fixture.port);

    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(fixture.server.listening, true);
    assert.match(`${result.stdout}\n${result.stderr}`, /already running/i);
  });

  test(`${entrypoint.name} stackless restart refuses a healthy unowned endpoint`, async (t) => {
    const fixture = await listenHealthFixture({ status: 200 });
    t.after(() => fixture.server.close());

    const result = await runStartup(entrypoint, fixture.port, ['--restart']);

    assert.notEqual(result.code, 0);
    assert.equal(fixture.server.listening, true);
    assert.match(`${result.stdout}\n${result.stderr}`, /healthy but unowned/i);
  });

  test(`${entrypoint.name} stackless startup refuses an unhealthy occupied endpoint without killing it`, async (t) => {
    const fixture = await listenHealthFixture({ status: 503 });
    t.after(() => fixture.server.close());

    const result = await runStartup(entrypoint, fixture.port);

    assert.notEqual(result.code, 0);
    assert.equal(fixture.server.listening, true);
    assert.match(`${result.stdout}\n${result.stderr}`, /topology is foreign/i);
  });

  test(`${entrypoint.name} stackless startup fails closed on inconclusive occupied health without killing it`, async (t) => {
    const fixture = await listenHealthFixture({ status: 200, respond: false });
    t.after(() => fixture.server.close());

    const result = await runStartup(entrypoint, fixture.port);

    assert.notEqual(result.code, 0);
    assert.equal(fixture.server.listening, true);
    assert.match(`${result.stdout}\n${result.stderr}`, /topology is inconclusive/i);
  });
}
