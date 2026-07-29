import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reserveLocalhostPort } from './self_host_service_e2e_harness.mjs';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

async function createAuditFixture(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-audit-mysql-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = join(workspaceDir, 'main');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  async function writeStack(stackName, {
    serverPort = null,
    databaseUrl = null,
    serverComponent = 'happier-server',
    dbProvider = 'mysql',
  }) {
    const baseDir = join(storageDir, stackName);
    const envPath = join(baseDir, 'env');
    await mkdir(baseDir, { recursive: true });
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_SERVER_COMPONENT=${serverComponent}`,
        `HAPPIER_DB_PROVIDER=${dbProvider}`,
        ...(serverPort == null ? [] : [
          `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
          `HAPPIER_STACK_PG_PORT=${serverPort + 1000}`,
        ]),
        `HAPPIER_STACK_UI_BUILD_DIR=${join(baseDir, 'ui')}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
        ...(databaseUrl == null ? [] : [`DATABASE_URL=${databaseUrl}`]),
        '',
      ].join('\n'),
      'utf-8',
    );
    return envPath;
  }

  async function audit(args) {
    return await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'audit', ...args, '--json'], {
      cwd: rootDir,
      env,
    });
  }

  async function edit(stackName) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'edit', stackName, '--interactive', '--json'], {
        cwd: rootDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const prompts = ['Pick [1-2]', 'Port (empty', 'Git remote', 'Select repo'];
      let promptIndex = 0;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (promptIndex < prompts.length && stdout.includes(prompts[promptIndex])) {
          promptIndex += 1;
          child.stdin.write('\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr }));
    });
  }

  return { audit, edit, writeStack };
}

test('hstack stack audit --unpin-ports preserves explicit MySQL DATABASE_URL authority', async (t) => {
  const fixture = await createAuditFixture(t);
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  const envPath = await fixture.writeStack('mysql-unpin', { serverPort: await reserveLocalhostPort(), databaseUrl });

  const result = await fixture.audit(['--unpin-ports']);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.match(raw, new RegExp(`^DATABASE_URL=${databaseUrl}$`, 'm'));
  assert.doesNotMatch(raw, /^HAPPIER_STACK_SERVER_PORT=/m);
});

test('hstack stack audit --fix-ports preserves explicit MySQL DATABASE_URL authority', async (t) => {
  const fixture = await createAuditFixture(t);
  const sharedPort = await reserveLocalhostPort();
  await fixture.writeStack('mysql-a-keep', {
    serverPort: sharedPort,
    databaseUrl: 'mysql://keep:secret@keep.example.test:3306/happier',
  });
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  const repairedEnvPath = await fixture.writeStack('mysql-z-repair', { serverPort: sharedPort, databaseUrl });

  const result = await fixture.audit(['--fix-ports']);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const raw = await readFile(repairedEnvPath, 'utf-8');
  assert.match(raw, new RegExp(`^DATABASE_URL=${databaseUrl}$`, 'm'));
  assert.match(raw, /^HAPPIER_DB_PROVIDER=mysql$/m);
  assert.doesNotMatch(raw, new RegExp(`^HAPPIER_STACK_SERVER_PORT=${sharedPort}$`, 'm'));
});

test('hstack stack audit --unpin-ports preserves explicit external Postgres DATABASE_URL authority', async (t) => {
  const fixture = await createAuditFixture(t);
  const databaseUrl = 'postgresql://operator:secret@db.example.test:5432/happier?sslmode=require';
  const envPath = await fixture.writeStack('postgres-external-unpin', {
    serverPort: await reserveLocalhostPort(),
    databaseUrl,
    dbProvider: 'postgres',
  });

  const result = await fixture.audit(['--unpin-ports']);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.ok(raw.includes(`DATABASE_URL=${databaseUrl}\n`), raw);
  assert.doesNotMatch(raw, /^HAPPIER_STACK_SERVER_PORT=/m);
});

test('hstack stack audit --fix-ports preserves explicit external Postgres DATABASE_URL authority', async (t) => {
  const fixture = await createAuditFixture(t);
  const sharedPort = await reserveLocalhostPort();
  await fixture.writeStack('postgres-a-keep', {
    serverPort: sharedPort,
    databaseUrl: 'postgresql://keep:secret@keep.example.test:5432/happier',
    dbProvider: 'postgres',
  });
  const databaseUrl = 'postgresql://operator:secret@db.example.test:5432/happier?sslmode=require';
  const repairedEnvPath = await fixture.writeStack('postgres-z-repair', {
    serverPort: sharedPort,
    databaseUrl,
    dbProvider: 'postgres',
  });

  const result = await fixture.audit(['--fix-ports']);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const raw = await readFile(repairedEnvPath, 'utf-8');
  assert.ok(raw.includes(`DATABASE_URL=${databaseUrl}\n`), raw);
  assert.match(raw, /^HAPPIER_DB_PROVIDER=postgres$/m);
  assert.doesNotMatch(raw, new RegExp(`^HAPPIER_STACK_SERVER_PORT=${sharedPort}$`, 'm'));
});

test('hstack stack audit reports MySQL without DATABASE_URL and does not invent authority', async (t) => {
  const fixture = await createAuditFixture(t);
  const envPath = await fixture.writeStack('mysql-missing-url', { serverPort: await reserveLocalhostPort() });

  const result = await fixture.audit([]);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /missing_mysql_database_url/);

  const raw = await readFile(envPath, 'utf-8');
  assert.doesNotMatch(raw, /^DATABASE_URL=/m);
});

test('hstack stack edit preserves MySQL provider and DATABASE_URL for an ephemeral stack', async (t) => {
  const fixture = await createAuditFixture(t);
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  const envPath = await fixture.writeStack('mysql-edit-ephemeral', { databaseUrl });

  const result = await fixture.edit('mysql-edit-ephemeral');
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.match(raw, /^HAPPIER_DB_PROVIDER=mysql$/m);
  assert.match(raw, new RegExp(`^DATABASE_URL=${databaseUrl}$`, 'm'));
  assert.doesNotMatch(raw, /^HAPPIER_STACK_PG_/m);
});

test('hstack stack edit preserves external Postgres authority without generating managed PG state', async (t) => {
  const fixture = await createAuditFixture(t);
  const databaseUrl = 'postgresql://operator:secret@db.example.test:5432/happier?sslmode=require';
  const envPath = await fixture.writeStack('postgres-external-edit', {
    databaseUrl,
    dbProvider: 'postgres',
  });

  const result = await fixture.edit('postgres-external-edit');
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.match(raw, /^HAPPIER_DB_PROVIDER=postgres$/m);
  assert.ok(raw.includes(`DATABASE_URL=${databaseUrl}\n`), raw);
  assert.doesNotMatch(raw, /^HAPPIER_STACK_PG_/m);
});
