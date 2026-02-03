import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('hstack eas build honors space-separated --platform android', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const env = {
    ...process.env,
    // Avoid cloning/bootstrapping/stack assumptions; we only want argument wiring.
    HAPPIER_STACKS_COMPONENT_DIR_HAPPIER_UI: join(rootDir, '..', 'ui'),
    HAPPIER_STACKS_COMPONENT_DIR_HAPPIER_CLI: join(rootDir, '..', 'cli'),
    HAPPIER_STACKS_COMPONENT_DIR_HAPPIER_SERVER: join(rootDir, '..', 'server'),
    // Prevent npx/eas from running: use our test stub instead.
    HSTACK_EAS_TEST_STUB: '1',
  };

  const res = await runNode(
    [join(rootDir, 'scripts', 'eas.mjs'), 'build', '--platform', 'android', '--profile', 'production', '--non-interactive'],
    { cwd: rootDir, env }
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /--platform android\b/, `expected forwarded args to include "--platform android"\nstdout:\n${res.stdout}`);
  assert.ok(!res.stdout.includes('--platform ios'), `expected not to default to ios when platform is explicitly set\nstdout:\n${res.stdout}`);
});

