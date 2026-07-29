import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('doctor --json reports zero-exit stopped daemon status as unhealthy', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { monoRoot } = await createDoctorWorkspaceFixture(t, {
    daemonStatusScript: [
      `console.log('🩺 Happier CLI Doctor');`,
      `console.log('❌ Daemon is not running');`,
    ].join('\n  '),
  });
  const env = doctorEnv({
    monoRoot,
    extraEnv: {
      HAPPIER_STACK_SERVE_UI: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
    },
  });

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.checks.daemon.ok, false);
  assert.match(report.checks.daemon.line, /Daemon is not running/i);
});
