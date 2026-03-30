import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { createHappierCliMonorepoFixture } from './testkit/happier_cli_monorepo_testkit.mjs';

async function createMonorepoFixture(t, { prefix }) {
  return createHappierCliMonorepoFixture(t, {
    prefix,
    distIndexScript: [
      "console.log(JSON.stringify({",
      "  serverUrl: process.env.HAPPIER_SERVER_URL ?? null,",
      "  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID ?? null,",
      "  homeDir: process.env.HAPPIER_HOME_DIR ?? null,",
      "}));",
      '',
    ].join('\n'),
  });
}

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack happier --server-url clears stack-scoped HAPPIER_ACTIVE_SERVER_ID', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-scope-' });

  const env = {
    ...process.env,
    // Keep the test hermetic: do not load a real stack env file.
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: join(fixture.dir, '.happy-home'),
    // Simulate a stack-scoped active server id (common in stack env files).
    HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default',
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', '--server-url=http://localhost:3014'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  function deriveEnvServerId(url) {
    let h = 2166136261;
    const text = String(url ?? '');
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `env_${(h >>> 0).toString(16)}`;
  }
  assert.equal(
    parsed.activeServerId,
    deriveEnvServerId('http://localhost:3014'),
    `expected HAPPIER_ACTIVE_SERVER_ID to be derived from --server-url\nstdout:\n${res.stdout}`,
  );
});
