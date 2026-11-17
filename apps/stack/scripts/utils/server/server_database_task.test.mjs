import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFakeServerDatabaseOwner } from '../../testkit/core/server_database_fixture.mjs';
import { resolveServerDatabaseAccess, runServerDatabaseTask } from './server_database_task.mjs';

async function withServerDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'stack-server-database-task-'));
  const serverDir = join(root, 'server');
  await mkdir(serverDir, { recursive: true });
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: 'server', private: true, type: 'module' }), 'utf-8');
  try {
    return await fn(serverDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePrismaClientPackage(serverDir, version, source) {
  const dir = join(serverDir, 'node_modules', '@prisma', 'client');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@prisma/client', version, type: 'module', main: './index.js' }), 'utf-8');
  await writeFile(join(dir, 'index.js'), source, 'utf-8');
}

test('a server source checkout opens its database through its own client owner', async () => {
  await withServerDir(async (serverDir) => {
    // Server logging shares stdout with the task result.
    await writeFakeServerDatabaseOwner({
      serverDir,
      createClientSource: [
        "  console.log('{\"level\":30,\"msg\":\"server log\"}');",
        '  return { account: { count: async () => (provider === "sqlite" && databaseUrl === "file:/x.sqlite?connection_limit=1" ? 5 : -1) },',
        '    async $disconnect() {} };',
      ].join('\n'),
    });
    // A Prisma 7 client is present but must not be constructed by stack tooling.
    await writePrismaClientPackage(serverDir, '7.10.1', 'export class PrismaClient { constructor() { throw new Error("adapter required"); } }\n');

    assert.deepEqual(resolveServerDatabaseAccess({ serverDir, provider: 'sqlite' }), { kind: 'owner' });
    const result = await runServerDatabaseTask({
      serverDir, provider: 'sqlite', task: 'account-count', databaseUrl: 'file:/x.sqlite?connection_limit=1',
    });
    assert.deepEqual(result, { accountCount: 5 });
  });
});

test('owner task errors reject with the task error', async () => {
  await withServerDir(async (serverDir) => {
    await writeFakeServerDatabaseOwner({
      serverDir,
      createClientSource: '  throw Object.assign(new Error("The table `main.Account` does not exist"), { code: "P2021" });',
    });
    await assert.rejects(
      runServerDatabaseTask({ serverDir, provider: 'postgresql', task: 'list-accounts', databaseUrl: 'postgresql://db/x' }),
      (error) => error.code === 'P2021' && /does not exist/.test(error.message),
    );
  });
});

test('LEGACY(Prisma 6): a server directory without the owner constructs its Prisma 6 client from DATABASE_URL', async () => {
  await withServerDir(async (serverDir) => {
    await writePrismaClientPackage(serverDir, '6.19.2', [
      'export class PrismaClient {',
      '  constructor() { this.account = { count: async () => (process.env.DATABASE_URL === "postgresql://db/legacy" ? 3 : -1) }; }',
      '  async $disconnect() {}',
      '}',
      '',
    ].join('\n'));

    const access = resolveServerDatabaseAccess({ serverDir, provider: 'postgres' });
    assert.equal(access.kind, 'legacy-prisma6');
    const result = await runServerDatabaseTask({
      serverDir, provider: 'postgres', task: 'account-count', databaseUrl: 'postgresql://db/legacy', env: { ...process.env, DATABASE_URL: '' },
    });
    assert.deepEqual(result, { accountCount: 3 });
  });
});

test('a Prisma 7 directory without the server owner fails closed instead of constructing a client', async () => {
  await withServerDir(async (serverDir) => {
    await writePrismaClientPackage(serverDir, '7.10.1', 'export class PrismaClient {}\n');
    assert.throws(
      () => resolveServerDatabaseAccess({ serverDir, provider: 'postgres' }),
      (error) => error.code === 'ESERVERDBOWNERUNAVAILABLE',
    );
  });
});
