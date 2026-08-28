import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function createPlacementFixture(t) {
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-remote-server-placement-'));
  t.after(async () => await rm(storageDir, { recursive: true, force: true }));
  const stackName = 'repo-placement-test';
  const stackDir = join(storageDir, stackName);
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), JSON.stringify({
    version: 2,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-target',
      repoDir: '/Users/test/happier-0.2',
      cliHomeDir: '/Users/test/.happier/dev-targets/mac',
    }],
    runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac-host' },
      expo: { mode: 'local' },
      daemon: { mode: 'local-and-targets', targets: ['mac-host'] },
    },
  }, null, 2));
  return { stackName, storageDir };
}

function placementEnv({ stackName, storageDir }) {
  return {
    ...process.env,
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    HAPPIER_STACK_RUNTIME_MODE: 'source',
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_DB_PROVIDER: 'sqlite',
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
    HAPPIER_STACK_SERVER_PORT: '43005',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
  };
}

test('hstack dev projects an authoritative Mac server without suppressing Linux or Mac daemons', async (t) => {
  const fixture = await createPlacementFixture(t);
  const result = await runNode([
    join(packageRoot, 'scripts', 'dev.mjs'),
    '--json',
    '--no-ui',
    '--server-public-url=http://127.0.0.1:52753',
  ], {
    cwd: packageRoot,
    env: placementEnv(fixture),
  });

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.startServer, false);
  assert.equal(output.startDaemon, true);
  assert.equal(output.publicServerUrl, 'http://127.0.0.1:52753');
  assert.deepEqual(output.servicePlans.local, { server: false, expo: false, daemon: true });
  assert.deepEqual(output.servicePlans.targets, [{
    target: {
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-target',
      repoDir: '/Users/test/happier-0.2',
      cliHomeDir: '/Users/test/.happier/dev-targets/mac',
      remoteServerPort: null,
    },
    services: { server: true, expo: false, daemon: true },
  }]);
});

test('--no-dev-targets cannot bypass configured authoritative remote server placement', async (t) => {
  const fixture = await createPlacementFixture(t);
  const result = await runNode([
    join(packageRoot, 'scripts', 'dev.mjs'),
    '--json',
    '--no-ui',
    '--no-dev-targets',
  ], {
    cwd: packageRoot,
    env: placementEnv(fixture),
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--no-dev-targets.*remote server placement/i);
});
