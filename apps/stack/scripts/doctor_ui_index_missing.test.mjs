import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoctorWorkspaceFixture, doctorEnv, runNode } from './doctor.testHelper.mjs';

test('doctor reports a missing UI index.html when UI build dir exists', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const { tmp, monoRoot } = await createDoctorWorkspaceFixture(t, {
    tmpPrefix: 'happier-stack-doctor-ui-index-',
  });

  const uiBuildDir = join(tmp, 'ui');
  await mkdir(uiBuildDir, { recursive: true });
  // Directory exists but index.html is missing (common partial/failed export state).
  await writeFile(join(uiBuildDir, 'canvaskit.wasm'), 'stub\n', 'utf-8');

  const env = doctorEnv({
    monoRoot,
    extraEnv: {
      HAPPIER_STACK_UI_BUILD_DIR: uiBuildDir,
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
    },
  });

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs')], { cwd: rootDir, env });
  assert.equal(
    res.code,
    0,
    `expected exit 0, got ${res.code} (signal: ${res.signal})\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
  assert.match(res.stdout, /ui index missing/i, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /index\.html/i, `stdout:\n${res.stdout}`);
  assert.match(res.stdout, /hstack build/i, `stdout:\n${res.stdout}`);
});
