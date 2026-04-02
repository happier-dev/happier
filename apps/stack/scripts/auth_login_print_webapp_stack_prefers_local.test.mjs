import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthStackFixture, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack stack auth <name> login --print --webapp=stack prefers stack-local URLs over stack env overrides', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const fixture = await createAuthStackFixture({
    t,
    prefix: 'auth-print-webapp-stack-prefers-local',
    stackName: 'print-stack',
    stackEnvLines: [
      // Simulate a stack env that opts into an HTTPS share URL and hosted webapp URL.
      // The stack-local UX should still prefer localhost for stack-scoped browser auth.
      'HAPPIER_PUBLIC_SERVER_URL=https://example.test',
      'HAPPIER_WEBAPP_URL=https://example.test',
    ],
  });

  const env = fixture.buildEnv({
    // Force stack scoping for the command under test.
    HAPPIER_STACK_STACK: 'print-stack',
    HAPPIER_STACK_ENV_FILE: fixture.envPath,
  });

  const res = await runNodeCapture(
    [
      hstackBinPath(rootDir),
      'stack',
      'auth',
      'print-stack',
      'login',
      '--print',
      '--no-open',
      '--method=web',
      '--webapp=stack',
    ],
    { cwd: rootDir, env }
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  // Default stack auth port is 3005 when no runtime port is detected (print mode does not start the stack).
  assert.match(res.stdout, /HAPPIER_PUBLIC_SERVER_URL="http:\/\/localhost:3005"/);
  // Stack-local webapp URL is preferred for origin isolation.
  assert.match(res.stdout, /HAPPIER_WEBAPP_URL="http:\/\/happier-print-stack\.localhost:3005"/);
});
