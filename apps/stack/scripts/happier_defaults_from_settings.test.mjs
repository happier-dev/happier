import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';

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
      "// Parse --server-url from argv",
      "let serverUrlFromArg = null;",
      "for (let i = 0; i < process.argv.length; i++) {",
      "  const arg = process.argv[i];",
      "  if (arg === '--server-url' && i + 1 < process.argv.length) {",
      "    serverUrlFromArg = process.argv[i + 1];",
      "    break;",
      "  }",
      "  if (arg.startsWith('--server-url=')) {",
      "    serverUrlFromArg = arg.slice('--server-url='.length);",
      "    break;",
      "  }",
      "}",
      "console.log(JSON.stringify({",
      "  serverUrl: serverUrlFromArg ?? process.env.HAPPIER_SERVER_URL ?? null,",
      "  publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL ?? null,",
      "  localServerUrl: process.env.HAPPIER_LOCAL_SERVER_URL ?? null,",
      "  webappUrl: process.env.HAPPIER_WEBAPP_URL ?? null,",
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

test('hstack happier treats non-prefix --server as explicit server selection', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-subcommand-server-flag-' });

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
  delete env.HAPPIER_ACTIVE_SERVER_ID;

  try {
    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'happier', 'doctor', '--server', 'example'],
      { cwd: rootDir, env },
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.serverUrl, null, 'serverUrl should not use stack defaults when --server is explicit');
    assert.equal(parsed.webappUrl, null, 'webappUrl should not use stack defaults when --server is explicit');
    assert.equal(parsed.activeServerId, null, 'activeServerId should be cleared when --server is explicit');
  } finally {
    await fixture.cleanup();
  }
});

test('hstack happier honors explicit --server-url even when other top-level flags appear first', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-server-url-after-json-' });

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
  delete env.HAPPIER_ACTIVE_SERVER_ID;

  try {
    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'happier', '--json', '--server-url=https://override.example'],
      { cwd: rootDir, env },
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    // The explicit --server-url should override the settings default
    assert.equal(parsed.serverUrl, 'https://override.example', 'serverUrl should use explicit --server-url override');
    // The activeServerId should be derived from the override URL, not the stack default
    assert.notEqual(
      parsed.activeServerId,
      buildStackStableScopeId({ stackName: 'test-stack', cliIdentity: 'default' }),
      'activeServerId should not use stack-stable id when explicit server is selected',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('hstack happier honors explicit --server-url after a forwarded subcommand', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-server-url-after-subcommand-' });

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
  delete env.HAPPIER_ACTIVE_SERVER_ID;

  try {
    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'happier', 'auth', 'login', '--server-url=https://override.example'],
      { cwd: rootDir, env },
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.serverUrl, 'https://override.example', 'serverUrl should use explicit --server-url override');
    assert.notEqual(
      parsed.activeServerId,
      buildStackStableScopeId({ stackName: 'test-stack', cliIdentity: 'default' }),
      'activeServerId should not use stack-stable id when explicit server is selected',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('hstack happier treats auth subcommand --server as explicit server selection', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-auth-server-subcommand-' });

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
  delete env.HAPPIER_ACTIVE_SERVER_ID;

  try {
    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'happier', 'auth', 'login', '--server', 'example'],
      { cwd: rootDir, env },
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.serverUrl, null, 'serverUrl should not use stack defaults when auth forwards --server');
    assert.equal(parsed.webappUrl, null, 'webappUrl should not use stack defaults when auth forwards --server');
    assert.equal(parsed.activeServerId, null, 'activeServerId should be cleared when auth forwards explicit --server');
  } finally {
    await fixture.cleanup();
  }
});
