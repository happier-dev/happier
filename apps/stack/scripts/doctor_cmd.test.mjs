import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoctorWorkspaceFixture, doctorEnv, runNode } from './doctor.testHelper.mjs';

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
