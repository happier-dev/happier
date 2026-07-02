import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function writePackageJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeMinimalMonorepoFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-no-daemon-' });
  const repoDir = join(fixture.root, 'repo');
  const uiDir = join(repoDir, 'apps', 'ui');
  const cliDir = join(repoDir, 'apps', 'cli');
  const serverDir = join(repoDir, 'apps', 'server');

  await mkdir(uiDir, { recursive: true });
  await mkdir(cliDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });

  await writePackageJson(join(uiDir, 'package.json'), {
    name: '@fixture/ui',
    version: '0.0.0',
  });
  await writePackageJson(join(serverDir, 'package.json'), {
    name: '@fixture/server',
    version: '0.0.0',
  });
  await writePackageJson(join(cliDir, 'package.json'), {
    name: '@fixture/cli',
    version: '0.0.0',
    scripts: {
      build: 'node -e "process.stderr.write(\'cli build must not run\\\\n\'); process.exit(42)"',
    },
  });
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  return { ...fixture, repoDir };
}

async function startHealthyServer(t) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Welcome to Happier Server!');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port };
}

test('hstack dev --no-daemon does not require or build the CLI daemon package', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await writeMinimalMonorepoFixture(t);

  const res = await runNode([
    join(rootDir, 'scripts', 'dev.mjs'),
    '--no-server',
    '--no-ui',
    '--no-daemon',
    '--server-url=https://api.example.com',
  ], {
    cwd: rootDir,
    env: {
      ...sanitizeStackTestRunnerEnv(process.env, {
        isolatedStackRoot: fixture.root,
        repoDir: fixture.repoDir,
      }),
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_PM_CACHE_BASE_DIR: join(fixture.root, 'cache'),
    },
  });

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr + res.stdout, /cli build must not run/i);
});

test('hstack start --no-daemon does not require or build the CLI daemon package', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await writeMinimalMonorepoFixture(t);
  const server = await startHealthyServer(t);

  const res = await runNode([
    join(rootDir, 'scripts', 'run.mjs'),
    '--no-ui',
    '--no-daemon',
  ], {
    cwd: rootDir,
    env: {
      ...sanitizeStackTestRunnerEnv(process.env, {
        isolatedStackRoot: fixture.root,
        repoDir: fixture.repoDir,
      }),
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_PM_CACHE_BASE_DIR: join(fixture.root, 'cache'),
      HAPPIER_STACK_SERVER_PORT: String(server.port),
    },
  });

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr + res.stdout, /cli build must not run/i);
});
