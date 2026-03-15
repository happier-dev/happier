import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

async function createMonorepoFixture({ prefix }) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const cliDistDir = join(dir, 'apps', 'cli', 'dist');
  await mkdir(cliDistDir, { recursive: true });
  await mkdir(join(dir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(dir, 'apps', 'server'), { recursive: true });

  await writeFile(join(dir, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  await writeFile(
    join(cliDistDir, 'index.mjs'),
    [
      "console.log(JSON.stringify({",
      "  serverUrl: process.env.HAPPIER_SERVER_URL ?? null,",
      "  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID ?? null,",
      "  homeDir: process.env.HAPPIER_HOME_DIR ?? null,",
      "}));",
      '',
    ].join('\n'),
    'utf-8',
  );

  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack happier --server-url clears stack-scoped HAPPIER_ACTIVE_SERVER_ID', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-scope-' });

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

  try {
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
  } finally {
    await fixture.cleanup();
  }
});
