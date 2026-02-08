import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './stack_script_cmd.testHelper.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

async function createLightAuditFixture(t, { stackName = 'exp1', envLines }) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-audit-light-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = join(workspaceDir, 'main');
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(baseDir, { recursive: true });
  await writeFile(envPath, [...envLines, ''].join('\n'), 'utf-8');

  return {
    baseDir,
    envPath,
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    },
  };
}

async function runAuditFixPaths({ env }) {
  return await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'audit', '--fix-paths', '--json'], { cwd: rootDir, env });
}

test('hstack stack audit --fix-paths prunes legacy DATABASE_URL for light stacks and sets HAPPIER_SERVER_LIGHT_DB_DIR', async (t) => {
  const stackName = 'exp1';
  const fixture = await createLightAuditFixture(t, {
    stackName,
    envLines: (() => {
      const dataDir = join(join(join(tmpdir(), 'unused'), stackName), 'server-light');
      return [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_UI_BUILD_DIR=${join(join(tmpdir(), 'unused'), stackName, 'ui')}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(join(tmpdir(), 'unused'), stackName, 'cli')}`,
        `HAPPIER_STACK_REPO_DIR=${join(tmpdir(), 'unused', 'main')}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `DATABASE_URL=file:${join(dataDir, 'happier-server-light.sqlite')}`,
      ];
    })(),
  });

  const res = await runAuditFixPaths({ env: fixture.env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const raw = await readFile(fixture.envPath, 'utf-8');
  assert.ok(raw.includes('HAPPIER_SERVER_LIGHT_DB_DIR='), `expected HAPPIER_SERVER_LIGHT_DB_DIR to be set\n${raw}`);
  assert.ok(!raw.includes('\nDATABASE_URL='), `expected legacy DATABASE_URL to be pruned for light stacks\n${raw}`);
});

test('hstack stack audit --fix-paths normalizes mixed legacy light paths and removes DATABASE_URL', async (t) => {
  const stackName = 'exp-mixed';
  const fixture = await createLightAuditFixture(t, {
    stackName,
    envLines: [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_UI_BUILD_DIR=${join(fixturePathPlaceholder(), 'ui')}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(fixturePathPlaceholder(), 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${join(fixturePathPlaceholder(), 'repo')}`,
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${join(fixturePathPlaceholder(), 'legacy-light')}`,
      `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(fixturePathPlaceholder(), 'legacy-light', 'files-old')}`,
      `DATABASE_URL=file:${join(fixturePathPlaceholder(), 'legacy-light', 'legacy.sqlite')}`,
    ],
  });

  const expectedDataDir = join(fixture.baseDir, 'server-light');
  const expectedFilesDir = join(expectedDataDir, 'files');
  const expectedDbDir = join(expectedDataDir, 'pglite');

  const res = await runAuditFixPaths({ env: fixture.env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const raw = await readFile(fixture.envPath, 'utf-8');
  assert.ok(raw.includes(`HAPPIER_SERVER_LIGHT_DATA_DIR=${expectedDataDir}`), `expected normalized data dir\n${raw}`);
  assert.ok(raw.includes(`HAPPIER_SERVER_LIGHT_FILES_DIR=${expectedFilesDir}`), `expected normalized files dir\n${raw}`);
  assert.ok(raw.includes(`HAPPIER_SERVER_LIGHT_DB_DIR=${expectedDbDir}`), `expected normalized db dir\n${raw}`);
  assert.ok(!raw.includes('\nDATABASE_URL='), `expected legacy DATABASE_URL to be removed\n${raw}`);
});

test('hstack stack audit --fix-paths is idempotent for migrated light env files', async (t) => {
  const stackName = 'exp-idempotent';
  const fixture = await createLightAuditFixture(t, {
    stackName,
    envLines: [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_REPO_DIR=${join(fixturePathPlaceholder(), 'repo')}`,
      `DATABASE_URL=file:${join(fixturePathPlaceholder(), 'legacy.sqlite')}`,
    ],
  });

  const first = await runAuditFixPaths({ env: fixture.env });
  assert.equal(first.code, 0, `expected first audit exit 0, got ${first.code}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  const afterFirst = await readFile(fixture.envPath, 'utf-8');

  const second = await runAuditFixPaths({ env: fixture.env });
  assert.equal(second.code, 0, `expected second audit exit 0, got ${second.code}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  const afterSecond = await readFile(fixture.envPath, 'utf-8');

  assert.equal(afterSecond, afterFirst, 'expected second --fix-paths run to be idempotent');
});

function fixturePathPlaceholder() {
  return join(tmpdir(), 'hstack-stack-audit-placeholder');
}
