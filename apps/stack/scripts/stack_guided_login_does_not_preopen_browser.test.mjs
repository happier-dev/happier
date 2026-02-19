import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('guidedStackAuthLoginNow does not include a pre-open browser step (delegates UX to happier-cli)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const p = join(scriptsDir, 'utils', 'auth', 'stack_guided_login.mjs');
  const src = await readFile(p, 'utf-8');

  // We used to do a "Step 1/2 open the web app" pre-step before invoking happier-cli.
  // Now happier-cli owns the guided UX, and hstack should not open a browser ahead of it.
  assert.ok(!src.includes('guidedStackWebSignupThenLogin'), 'expected no guidedStackWebSignupThenLogin reference');
  assert.ok(!src.includes('guided_stack_web_login'), 'expected no guided_stack_web_login import');
});

