import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('packages/tests exposes a desktop native e2e wrapper script that delegates to the root lane', async () => {
  const packageJsonPath = join(process.cwd(), 'packages/tests/package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };

  const scripts = packageJson.scripts ?? {};
  const script = scripts['test:desktop:native'];
  assert.equal(typeof script, 'string');
  assert.match(script, /\btest:e2e:desktop:native\b/);
});
