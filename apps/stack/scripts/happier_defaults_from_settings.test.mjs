import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hstackBinPath, runNodeCapture, terminateChildProcess } from './testkit/auth_testkit.mjs';
import { buildStackFixtureEnv } from './testkit/core/env_scope.mjs';
import { createHappierCliMonorepoFixture } from './testkit/happier_cli_monorepo_testkit.mjs';
import { buildStubHappierServerSetSource } from './testkit/core/stub_happier_cli_server_set.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';

async function createMonorepoFixture(t, { prefix, distIndexScript }) {
  return createHappierCliMonorepoFixture(t, {
    prefix,
    distIndexScript: distIndexScript ?? [
      "const args = process.argv.slice(2);",
      buildStubHappierServerSetSource(),
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
  });
}

test('stack-scoped invocations initialize a canonical profile and use loopback only for transport', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  // The selected CLI is a child-process boundary. Simulate its existing
  // server-set persistence contract, then observe the forwarded command.
  const fixture = await createMonorepoFixture(t, {
    prefix: 'hstack-happier-canonical-profile-',
    distIndexScript: [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      "const settingsPath = join(process.env.HAPPIER_HOME_DIR, 'settings.json');",
      buildStubHappierServerSetSource(),
      "console.log(JSON.stringify({ serverUrl: process.env.HAPPIER_SERVER_URL,",
      "  publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL, localServerUrl: process.env.HAPPIER_LOCAL_SERVER_URL,",
      "  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,",
      "  settings: JSON.parse(readFileSync(settingsPath, 'utf8')) }));",
    ].join('\n'),
  });
  const storageDir = join(fixture.dir, 'storage');
  const stackDir = join(storageDir, 'test-stack');
  const port = await reserveUnusedPort();
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), `HAPPIER_STACK_SERVER_PORT=${port}\n`, 'utf8');
  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, storageDir });
  env.HAPPIER_STACK_ENV_FILE = join(stackDir, 'env');
  env.HAPPIER_STACK_SERVER_PORT = String(port);
  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', 'server', 'current', '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  const id = buildStackStableScopeId({ stackName: 'test-stack', cliIdentity: 'default' });
  assert.equal(parsed.publicServerUrl, `http://happier-test-stack.localhost:${port}`);
  assert.equal(parsed.serverUrl, `http://127.0.0.1:${port}`);
  assert.equal(parsed.localServerUrl, `http://127.0.0.1:${port}`);
  assert.equal(parsed.activeServerId, id);
  assert.equal(parsed.settings.activeServerId, id);
  assert.equal(parsed.settings.servers[id].serverUrl, parsed.publicServerUrl);
  assert.equal(parsed.settings.servers[id].localServerUrl, parsed.localServerUrl);
});

test('a fresh stack CLI home fails closed when the CLI does not persist its profile', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, {
    prefix: 'hstack-happier-missing-profile-',
    distIndexScript: [
      'const args = process.argv.slice(2);',
      buildStubHappierServerSetSource({ ignoreServerSet: true }),
      'console.log("requested-command-launched");',
    ].join('\n'),
  });
  const storageDir = join(fixture.dir, 'storage');
  const stackDir = join(storageDir, 'test-stack');
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), '', 'utf8');
  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, storageDir });
  env.HAPPIER_STACK_ENV_FILE = join(stackDir, 'env');
  env.HAPPIER_STACK_SERVER_PORT = String(await reserveUnusedPort());
  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', 'server', 'current', '--json'], { cwd: rootDir, env });
  assert.notEqual(res.code, 0);
  assert.equal(res.stdout.trim(), '', 'the requested command must not launch without its stack profile');
  assert.match(res.stderr, /did not apply the requested stack relay profile/);
});

test('stack profile reconciliation uses the configured endpoint instead of allocating a new port', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, {
    prefix: 'hstack-happier-configured-endpoint-',
    distIndexScript: [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      buildStubHappierServerSetSource(),
      "console.log(readFileSync(join(process.env.HAPPIER_HOME_DIR, 'settings.json'), 'utf8'));",
    ].join('\n'),
  });
  const storageDir = join(fixture.dir, 'storage');
  const stackDir = join(storageDir, 'test-stack');
  const port = await reserveUnusedPort();
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), `HAPPIER_SERVER_URL=http://127.0.0.1:${port}\n`, 'utf8');
  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, storageDir });
  env.HAPPIER_STACK_ENV_FILE = join(stackDir, 'env');
  env.HAPPIER_SERVER_URL = `http://127.0.0.1:${port}`;

  for (let invocation = 0; invocation < 2; invocation += 1) {
    const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', 'auth', 'status', '--json'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const settings = JSON.parse(res.stdout.trim());
    const id = buildStackStableScopeId({ stackName: 'test-stack', cliIdentity: 'default' });
    assert.equal(settings.servers[id].localServerUrl, `http://127.0.0.1:${port}`);
    assert.equal(settings.servers[id].serverUrl, `http://happier-test-stack.localhost:${port}`);
  }
});

test('daemon-only stack profile reconciliation follows the live external connection across port changes', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, {
    prefix: 'hstack-happier-external-endpoint-',
    distIndexScript: [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      buildStubHappierServerSetSource(),
      "console.log(readFileSync(join(process.env.HAPPIER_HOME_DIR, 'settings.json'), 'utf8'));",
    ].join('\n'),
  });
  const storageDir = join(fixture.dir, 'storage');
  const stackDir = join(storageDir, 'test-stack');
  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, storageDir });
  env.HAPPIER_STACK_ENV_FILE = join(stackDir, 'env');
  env.HAPPIER_STACK_CLI_HOME_DIR = join(stackDir, 'cli');
  env.HAPPIER_STACK_SERVER_PORT = '3010';
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=3010\n', 'utf8');
  // A real stack-marked process supplies OS lifecycle ownership; only the CLI
  // executable/profile persistence boundary is substituted by the fixture.
  const owner = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => terminateChildProcess(owner));
  await new Promise((resolve, reject) => {
    owner.stdout.once('data', resolve);
    owner.once('error', reject);
    owner.once('exit', code => reject(new Error(`fixture owner exited before readiness (${code})`)));
  });

  for (const port of [3020, 3022]) {
    const connection = {
      internalServerUrl: `http://127.0.0.1:${port}`,
      publicServerUrl: `http://happier-test-stack.localhost:${port}`,
    };
    await writeFile(join(stackDir, 'stack.runtime.json'), JSON.stringify({
      version: 1, stackName: 'test-stack', ownerPid: owner.pid, processes: {},
      ports: {}, placement: { server: 'external', daemon: 'local' }, serverConnection: connection,
    }), 'utf8');
    const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', 'auth', 'status', '--json'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const settings = JSON.parse(res.stdout.trim());
    const id = buildStackStableScopeId({ stackName: 'test-stack', cliIdentity: 'default' });
    assert.equal(settings.servers[id].localServerUrl, connection.internalServerUrl);
    assert.equal(settings.servers[id].serverUrl, connection.publicServerUrl);
  }
});

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function reserveUnusedPort() {
  const server = net.createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? Number(address.port) : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('failed to reserve test port');
  }
  return port;
}

function createHappierCommandEnv({
  fixtureDir,
  homeDir = '',
  storageDir = join(fixtureDir, 'storage'),
  stackName = 'test-stack',
  extraEnv = {},
}) {
  const env = buildStackFixtureEnv({
    homeDir: join(fixtureDir, 'stack-home'),
    storageDir,
    stackName,
    stripStackEnv: true,
    extraEnv: {
      HAPPIER_STACK_REPO_DIR: fixtureDir,
      HAPPIER_STACK_CANONICAL_HOME_DIR: join(fixtureDir, 'canonical-home'),
      HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
      ...extraEnv,
    },
  });
  delete env.HAPPIER_HOME_DIR;
  delete env.HAPPIER_SERVER_URL;
  delete env.HAPPIER_PUBLIC_SERVER_URL;
  delete env.HAPPIER_LOCAL_SERVER_URL;
  delete env.HAPPIER_WEBAPP_URL;
  delete env.HAPPIER_ACTIVE_SERVER_ID;
  if (homeDir) env.HAPPIER_HOME_DIR = homeDir;
  return env;
}

test('hstack happier defaults serverUrl/webappUrl from existing CLI settings (no localServerUrl)', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-settings-defaults-' });

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

  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, homeDir });

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.serverUrl, 'http://localhost:53288');
  assert.equal(parsed.webappUrl, 'http://happier.example.localhost:19364');
  assert.equal(parsed.publicServerUrl, null);
  assert.equal(parsed.localServerUrl, null);
  assert.equal(parsed.homeDir, homeDir);
});

test('hstack happier prefers existing CLI settings over stack defaults even when stack env is pinned', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-settings-cloud-over-stack-' });
  const stackPort = await reserveUnusedPort();

  const homeDir = join(fixture.dir, '.happy-home');
  await mkdir(homeDir, { recursive: true });
  await writeFile(
    join(homeDir, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      onboardingCompleted: true,
      activeServerId: 'cloud',
      servers: {
        cloud: {
          id: 'cloud',
          name: 'cloud',
          serverUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      },
    }),
    'utf-8',
  );

  const env = createHappierCommandEnv({
    fixtureDir: fixture.dir,
    homeDir,
    extraEnv: { HAPPIER_STACK_SERVER_PORT: String(stackPort) },
  });

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.serverUrl, 'https://api.happier.dev');
  assert.equal(parsed.webappUrl, 'https://app.happier.dev');
  assert.equal(parsed.activeServerId, null);
  assert.equal(parsed.homeDir, homeDir);
});

test('hstack happier defaults serverUrl via localServerUrl when present in settings', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-settings-local-defaults-' });

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

  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, homeDir });

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.publicServerUrl, 'https://public.example.test');
  assert.equal(parsed.localServerUrl, 'http://127.0.0.1:53288');
  assert.equal(parsed.serverUrl, 'http://127.0.0.1:53288');
  assert.equal(parsed.webappUrl, 'https://app.example.test');
});

test('hstack happier treats non-prefix --server as explicit server selection', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-subcommand-server-flag-' });

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

  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, homeDir });

  const res = await runNodeCapture(
    [hstackBinPath(rootDir), 'happier', 'doctor', '--server', 'example'],
    { cwd: rootDir, env },
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.serverUrl, null, 'serverUrl should not use stack defaults when --server is explicit');
  assert.equal(parsed.webappUrl, null, 'webappUrl should not use stack defaults when --server is explicit');
  assert.equal(parsed.activeServerId, null, 'activeServerId should be cleared when --server is explicit');
});

test('hstack happier honors explicit --server-url even when other top-level flags appear first', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-server-url-after-json-' });

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

  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, homeDir });

  const res = await runNodeCapture(
    [hstackBinPath(rootDir), 'happier', '--json', '--server-url=https://override.example'],
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
});

test('hstack happier honors explicit --server-url after a forwarded subcommand', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-server-url-after-subcommand-' });

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

  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, homeDir });

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
});

test('hstack happier rejects stack CLI home overrides that escape through symlinks', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires POSIX symlink semantics');
    return;
  }

  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-stack-home-symlink-' });
  const storageDir = join(fixture.dir, 'storage');
  const stackBaseDir = join(storageDir, 'main');
  const stackEnvPath = join(stackBaseDir, 'env');
  const externalHomeDir = join(fixture.dir, 'external-cli-home');
  const linkedHomeDir = join(stackBaseDir, 'linked-cli-home');

  await mkdir(stackBaseDir, { recursive: true });
  await mkdir(externalHomeDir, { recursive: true });
  await writeFile(stackEnvPath, '', 'utf-8');
  await symlink(externalHomeDir, linkedHomeDir, 'dir');

  const env = createHappierCommandEnv({
    fixtureDir: fixture.dir,
    storageDir,
    stackName: 'main',
    extraEnv: { HAPPIER_STACK_CLI_HOME_DIR: linkedHomeDir },
  });

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.notEqual(parsed.homeDir, linkedHomeDir);
  assert.notEqual(parsed.homeDir, externalHomeDir);
});

test('hstack happier treats auth subcommand --server as explicit server selection', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-auth-server-subcommand-' });

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

  const env = createHappierCommandEnv({ fixtureDir: fixture.dir, homeDir });

  const res = await runNodeCapture(
    [hstackBinPath(rootDir), 'happier', 'auth', 'login', '--server', 'example'],
    { cwd: rootDir, env },
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.serverUrl, null, 'serverUrl should not use stack defaults when auth forwards --server');
  assert.equal(parsed.webappUrl, null, 'webappUrl should not use stack defaults when auth forwards --server');
  assert.equal(parsed.activeServerId, null, 'activeServerId should be cleared when auth forwards explicit --server');
});
