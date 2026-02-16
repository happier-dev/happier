import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './testkit/auth_testkit.mjs';

test('mobile-dev-client --help runs without syntax errors', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const script = join(rootDir, 'scripts', 'mobile_dev_client.mjs');

  const env = {
    ...process.env,
    // Prevent env.mjs from selecting a real stack env file (keeps the test fast and hermetic).
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture([script, '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /\bmobile-dev-client\b/, `expected help to mention command name\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--port(?:=|\b)/, `expected help to mention --port\nstdout:\n${res.stdout}`);
});

