import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envModulePath = join(dirname(fileURLToPath(import.meta.url)), 'env.mjs');

test('env loader overlays explicit stack env over stale inherited stack/server context', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-env-loader-'));
  try {
    const stackName = 'exp-test';
    const storageDir = join(tmp, 'storage');
    const stackDir = join(storageDir, stackName);
    const repoDir = join(tmp, 'repo');
    await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
    await mkdir(join(repoDir, 'apps', 'cli'), { recursive: true });
    await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
    await mkdir(stackDir, { recursive: true });
    await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf8');
    await writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{}\n', 'utf8');
    await writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{}\n', 'utf8');
    const stackEnvPath = join(stackDir, 'env');
    await writeFile(
      stackEnvPath,
      [
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(stackDir, 'cli')}`,
        'HAPPIER_STACK_SERVER_PORT=4901',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          `await import(${JSON.stringify(envModulePath)});`,
          'process.stdout.write(JSON.stringify({',
          '  envFile: process.env.HAPPIER_STACK_ENV_FILE ?? null,',
          '  repoDir: process.env.HAPPIER_STACK_REPO_DIR ?? null,',
          '  cliHomeDir: process.env.HAPPIER_STACK_CLI_HOME_DIR ?? null,',
          '  serverPort: process.env.HAPPIER_STACK_SERVER_PORT ?? null,',
          '  homeDir: process.env.HAPPIER_HOME_DIR ?? null,',
          '  serverUrl: process.env.HAPPIER_SERVER_URL ?? null,',
          '  webappUrl: process.env.HAPPIER_WEBAPP_URL ?? null,',
          '  tsxTsconfigPath: process.env.TSX_TSCONFIG_PATH ?? null,',
          '}));',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
          HAPPIER_STACK_STORAGE_DIR: storageDir,
          HAPPIER_STACK_WORKSPACE_DIR: join(tmp, 'workspace'),
          HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
          HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_ENV_FILE: stackEnvPath,
          HAPPIER_STACK_SERVER_PORT: '52753',
          HAPPIER_HOME_DIR: '/stale/home',
          HAPPIER_SERVER_URL: 'http://stale.localhost:9999',
          HAPPIER_WEBAPP_URL: 'http://stale.localhost:9999',
          TSX_TSCONFIG_PATH: '/stale/launcher/tsconfig.json',
        },
      },
    );

    assert.equal(res.status, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.envFile, stackEnvPath);
    assert.equal(payload.repoDir, repoDir);
    assert.equal(payload.cliHomeDir, join(stackDir, 'cli'));
    assert.equal(payload.serverPort, '4901');
    assert.equal(payload.homeDir, null);
    assert.equal(payload.serverUrl, null);
    assert.equal(payload.webappUrl, null);
    assert.equal(payload.tsxTsconfigPath, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('env loader detaches an unreadable inherited stack env when an explicit repo override is provided', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-env-loader-unreadable-'));
  try {
    const staleRepoDir = join(tmp, 'stale-repo');
    const freshRepoDir = join(tmp, 'fresh-repo');
    const staleStackDir = join(tmp, 'storage', 'stale-stack');
    for (const repoDir of [staleRepoDir, freshRepoDir]) {
      await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
      await mkdir(join(repoDir, 'apps', 'cli'), { recursive: true });
      await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
      await writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf8');
      await writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{}\n', 'utf8');
      await writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{}\n', 'utf8');
    }

    await mkdir(staleStackDir, { recursive: true });
    const unreadableEnvPath = join(staleStackDir, 'env');
    await writeFile(
      unreadableEnvPath,
      [
        `HAPPIER_STACK_REPO_DIR=${staleRepoDir}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(staleStackDir, 'cli')}`,
        'HAPPIER_STACK_SERVER_PORT=4901',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(unreadableEnvPath, 0o000);

    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          `await import(${JSON.stringify(envModulePath)});`,
          'process.stdout.write(JSON.stringify({',
          '  envFile: process.env.HAPPIER_STACK_ENV_FILE ?? null,',
          '  stackName: process.env.HAPPIER_STACK_STACK ?? null,',
          '  repoDir: process.env.HAPPIER_STACK_REPO_DIR ?? null,',
          '  cliHomeDir: process.env.HAPPIER_STACK_CLI_HOME_DIR ?? null,',
          '  homeDir: process.env.HAPPIER_HOME_DIR ?? null,',
          '  serverUrl: process.env.HAPPIER_SERVER_URL ?? null,',
          '}));',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
          HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
          HAPPIER_STACK_WORKSPACE_DIR: join(tmp, 'workspace'),
          HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
          HAPPIER_STACK_ENV_FILE: unreadableEnvPath,
          HAPPIER_STACK_STACK: 'stale-stack',
          HAPPIER_STACK_REPO_DIR: freshRepoDir,
          HAPPIER_STACK_CLI_HOME_DIR: join(staleStackDir, 'cli'),
          HAPPIER_HOME_DIR: '/stale/home',
          HAPPIER_SERVER_URL: 'http://stale.localhost:9999',
        },
      },
    );

    assert.equal(res.status, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.envFile, null);
    assert.equal(payload.stackName, null);
    assert.equal(payload.repoDir, freshRepoDir);
    assert.equal(payload.cliHomeDir, null);
    assert.equal(payload.homeDir, null);
    assert.equal(payload.serverUrl, null);
  } finally {
    await chmod(join(tmp, 'storage', 'stale-stack', 'env'), 0o600).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
});
