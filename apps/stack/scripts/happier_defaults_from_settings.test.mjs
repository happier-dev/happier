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
      "  publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL ?? null,",
      "  localServerUrl: process.env.HAPPIER_LOCAL_SERVER_URL ?? null,",
      "  webappUrl: process.env.HAPPIER_WEBAPP_URL ?? null,",
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

test('hstack happier defaults serverUrl/webappUrl from existing CLI settings (no localServerUrl)', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-settings-defaults-' });

  const homeDir = join(fixture.dir, '.happy-home');
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    join(homeDir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      onboardingCompleted: true,
      activeServerId: 'stack',
      servers: {
        stack: {
          id: 'stack',
          name: 'stack',
          serverUrl: 'http://localhost:53288',
          webappUrl: 'http://happier.example.localhost:19364',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      },
    }),
    'utf-8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: homeDir,
  };
  delete env.HAPPIER_SERVER_URL;
  delete env.HAPPIER_PUBLIC_SERVER_URL;
  delete env.HAPPIER_LOCAL_SERVER_URL;
  delete env.HAPPIER_WEBAPP_URL;

  try {
    const res = await runNodeCapture([hstackBinPath(rootDir), 'happier'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.serverUrl, 'http://localhost:53288');
    assert.equal(parsed.webappUrl, 'http://happier.example.localhost:19364');
    assert.equal(parsed.publicServerUrl, null);
    assert.equal(parsed.localServerUrl, null);
    assert.equal(parsed.homeDir, homeDir);
  } finally {
    await fixture.cleanup();
  }
});

test('hstack happier defaults serverUrl via localServerUrl when present in settings', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-settings-local-defaults-' });

  const homeDir = join(fixture.dir, '.happy-home');
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    join(homeDir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      onboardingCompleted: true,
      activeServerId: 'stack',
      servers: {
        stack: {
          id: 'stack',
          name: 'stack',
          serverUrl: 'https://public.example.test',
          localServerUrl: 'http://127.0.0.1:53288',
          webappUrl: 'https://app.example.test',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      },
    }),
    'utf-8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: homeDir,
  };
  delete env.HAPPIER_SERVER_URL;
  delete env.HAPPIER_PUBLIC_SERVER_URL;
  delete env.HAPPIER_LOCAL_SERVER_URL;
  delete env.HAPPIER_WEBAPP_URL;

  try {
    const res = await runNodeCapture([hstackBinPath(rootDir), 'happier'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.publicServerUrl, 'https://public.example.test');
    assert.equal(parsed.localServerUrl, 'http://127.0.0.1:53288');
    assert.equal(parsed.serverUrl, 'http://127.0.0.1:53288');
    assert.equal(parsed.webappUrl, 'https://app.example.test');
  } finally {
    await fixture.cleanup();
  }
});

