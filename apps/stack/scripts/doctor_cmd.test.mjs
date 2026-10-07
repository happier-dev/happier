import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { createDoctorWorkspaceFixture, doctorEnv, runNode } from './testkit/doctor_testkit.mjs';

test('doctor does not crash in non-json mode (kv helper not shadowed)', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { monoRoot } = await createDoctorWorkspaceFixture(t);
  const env = doctorEnv({
    monoRoot,
    extraEnv: {
      HAPPIER_STACK_SERVE_UI: '0',
    },
  });

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs')], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /doctor/i);
  assert.match(res.stdout, /Details/);
});

test('doctor distinguishes a reachable daemon from a live PID with failed control transport', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { monoRoot, tmp } = await createDoctorWorkspaceFixture(t);
  let reachable = true;
  // Genuine daemon HTTP boundary; state-path selection and status logic stay real.
  const server = createServer((req, res) => {
    if (req.url === '/ping') {
      assert.equal(req.headers['x-happier-daemon-token'], 'fixture-token');
      res.writeHead(reachable ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: reachable }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const cliHomeDir = join(tmp, 'observed-cli');
  const env = doctorEnv({ monoRoot, extraEnv: {
    HAPPIER_STACK_STACK: '', HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir, HAPPIER_STACK_SERVER_PORT: String(port),
    HAPPIER_ACTIVE_SERVER_ID: 'doctor-fixture', HAPPIER_STACK_SERVE_UI: '0',
    HAPPIER_STACK_TAILSCALE_SERVE: '0',
  } });
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: `http://127.0.0.1:${port}`, env });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ pid: process.pid, httpPort: port, controlToken: 'fixture-token' }));
  const observe = async () => {
    const result = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout).checks.daemon;
  };
  assert.equal((await observe()).ok, true);
  reachable = false;
  const unavailable = await observe();
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.line, /unreachable/i);
});

test('doctor reports a stopped daemon as unhealthy without launching CLI diagnostics', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { monoRoot, tmp } = await createDoctorWorkspaceFixture(t, {
    daemonStatusScript: [
      `(await import('node:fs')).writeFileSync(process.env.HAPPIER_TEST_STATUS_MARKER, 'invoked');`,
      `console.log('🩺 Happier CLI Doctor');`,
      `console.log('❌ Daemon is not running');`,
    ].join('\n  '),
  });
  const env = doctorEnv({
    monoRoot,
    extraEnv: {
      HAPPIER_STACK_SERVE_UI: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_TEST_STATUS_MARKER: join(tmp, 'status-invoked'),
    },
  });

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.checks.daemon.ok, false);
  assert.match(report.checks.daemon.line, /Daemon is not running/i);
  assert.equal(existsSync(join(tmp, 'status-invoked')), false,
    'doctor needs the canonical daemon observation, not another full CLI diagnostic process');
});
