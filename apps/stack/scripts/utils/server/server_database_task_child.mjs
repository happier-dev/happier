// Child entry for `runServerDatabaseTask` (server_database_task.mjs). It runs with
// cwd = the server directory, reads one JSON request on stdin, opens that server's
// database, runs one task and prints one marked JSON line. Never run it directly.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RESULT_KEY = 'happierServerDatabaseTask';
const serverDir = process.cwd();
const requireFromServer = createRequire(join(serverDir, 'package.json'));

async function importFromServer(specifier) {
  if (/^[a-z]+:/i.test(specifier)) return await import(specifier);
  return await import(pathToFileURL(requireFromServer.resolve(specifier)).href);
}

async function createClient({ access, provider, databaseUrl }) {
  if (access.kind === 'owner') {
    // The server's client-construction owner picks the driver adapter. It is the slim module
    // beside storage/prisma.ts, so a task does not load the server graph.
    const { createDbMaintenanceClient } = await import(pathToFileURL(join(serverDir, 'sources', 'storage', 'prismaClientConstruction.ts')).href);
    return await createDbMaintenanceClient(provider, databaseUrl);
  }
  // LEGACY(Prisma 6): `resolveServerDatabaseAccess` selects this only for a server
  // directory without the owner whose Prisma client is < 7; such a client reads
  // DATABASE_URL itself. Remove with that branch.
  process.env.DATABASE_URL = databaseUrl;
  const mod = await importFromServer(access.clientImport);
  const PrismaClient = mod?.PrismaClient ?? mod?.default?.PrismaClient;
  if (!PrismaClient) throw new Error(`PrismaClient export not found in ${access.clientImport}`);
  return new PrismaClient();
}

async function openDatabase(request, spec, cleanups) {
  let databaseUrl = spec.databaseUrl;
  if (spec.provider === 'pglite') {
    if (spec.pgliteLockPurpose) {
      const { acquirePgliteDirLock } = await import('../pglite_lock.mjs');
      const releaseLock = await acquirePgliteDirLock(spec.pgliteDbDir, { purpose: spec.pgliteLockPurpose });
      cleanups.unshift(() => releaseLock());
    }
    const { PGlite } = await importFromServer('@electric-sql/pglite');
    const { FramedPgliteSocketServer } = await import(pathToFileURL(join(serverDir, 'sources', 'storage', 'pgliteFramedSocketServer.mjs')).href);
    const pglite = new PGlite(spec.pgliteDbDir);
    cleanups.unshift(() => pglite.close());
    await pglite.waitReady;
    const socketServer = new FramedPgliteSocketServer({ db: pglite, host: '127.0.0.1', port: 0 });
    await socketServer.start();
    cleanups.unshift(() => socketServer.stop());
    const raw = socketServer.getServerConn();
    const url = (() => {
      try {
        return new URL(raw);
      } catch {
        return new URL(`postgresql://postgres@${raw}/postgres?sslmode=disable`);
      }
    })();
    // PGlite serves one connection.
    url.searchParams.set('connection_limit', '1');
    databaseUrl = url.toString();
  }
  if (!databaseUrl) throw new Error(`Missing database URL for ${spec.provider} database task`);
  const db = await createClient({ access: request.access, provider: spec.provider, databaseUrl });
  cleanups.unshift(() => db.$disconnect());
  return db;
}

async function withDatabases(request, specs, run) {
  const cleanups = [];
  try {
    const dbs = [];
    for (const spec of specs) dbs.push(await openDatabase(request, spec, cleanups));
    return await run(...dbs);
  } finally {
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        // Cleanup cannot change the task outcome.
      }
    }
  }
}

async function insertAccounts(db, accounts) {
  return await db.$transaction(async (tx) => {
    let insertedCount = 0;
    for (const a of accounts) {
      const existingById = await tx.account.findUnique({ where: { id: a.id }, select: { id: true, publicKey: true } });
      if (existingById) {
        if (existingById.publicKey !== a.publicKey) {
          throw new Error('account conflict: target Account id has a different public key');
        }
        continue;
      }
      if (a.publicKey != null) {
        const existingByPublicKey = await tx.account.findUnique({ where: { publicKey: a.publicKey }, select: { id: true } });
        if (existingByPublicKey) {
          throw new Error('account conflict: target public key belongs to a different Account');
        }
      }
      await tx.account.create({ data: { id: a.id, publicKey: a.publicKey } });
      insertedCount += 1;
    }
    return { sourceCount: accounts.length, insertedCount };
  });
}

async function copyLightToServer(sourceDb, targetDb, { force }) {
  // Fail fast unless the target is empty.
  const existingSessions = await targetDb.session.count();
  const existingMessages = await targetDb.sessionMessage.count();
  if (!force && (existingSessions > 0 || existingMessages > 0)) {
    throw new Error(
      `[migrate] target database is not empty (sessions=${existingSessions}, messages=${existingMessages}).\n`
        + 'Pass --force to attempt a merge (skipDuplicates), or migrate into a fresh stack.',
    );
  }
  const copyAll = async (model) => {
    const rows = await sourceDb[model].findMany();
    if (rows.length) await targetDb[model].createMany({ data: rows, skipDuplicates: true });
    return rows.length;
  };
  const accounts = await copyAll('account');
  const machines = await copyAll('machine');
  const accessKeys = await copyAll('accessKey');
  const sessions = await copyAll('session');
  // Messages: stream in batches to avoid high memory.
  let messages = 0;
  const batchSize = 1000;
  let cursor = null;
  while (true) {
    const page = await sourceDb.sessionMessage.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    await targetDb.sessionMessage.createMany({ data: page, skipDuplicates: true });
    messages += page.length;
    if (messages % (batchSize * 20) === 0) process.stderr.write(`[migrate] migrated ${messages} messages...\n`);
  }
  await copyAll('sessionPendingMessage');
  return { accounts, sessions, messages, machines, accessKeys };
}

const TASKS = {
  'account-count': async (request) => await withDatabases(request, [request],
    async db => ({ accountCount: await db.account.count() })),
  'list-accounts': async (request) => await withDatabases(request, [request],
    async db => await db.account.findMany({ select: { id: true, publicKey: true }, orderBy: { id: 'asc' } })),
  'insert-accounts': async (request) => await withDatabases(request, [request],
    async db => await insertAccounts(db, Array.isArray(request.accounts) ? request.accounts : [])),
  'migration-ledger': async (request) => await withDatabases(request, [request], async (db) => {
    const { readPrismaMigrationLedger } = await import('@happier-dev/cli-common/firstPartyRuntime/server');
    const rows = await readPrismaMigrationLedger(sql => db.$queryRawUnsafe(sql));
    // Only the admission facts cross the process boundary.
    return rows.map(row => ({
      migration_name: row.migration_name,
      finished_at: row.finished_at == null ? null : String(row.finished_at),
      rolled_back_at: row.rolled_back_at == null ? null : String(row.rolled_back_at),
    }));
  }),
  'copy-light-to-server': async (request) => await withDatabases(request, [request.source, request.target],
    async (sourceDb, targetDb) => await copyLightToServer(sourceDb, targetDb, { force: request.force === true })),
};

try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const task = TASKS[request.task];
  if (!task) throw new Error(`Unknown server database task: ${request.task}`);
  const result = await task(request);
  process.stdout.write(`\n${JSON.stringify({ [RESULT_KEY]: { ok: true, result } })}\n`);
  process.exit(0);
} catch (e) {
  process.stdout.write(`\n${JSON.stringify({ [RESULT_KEY]: { ok: false, error: { name: e?.name, message: e?.message, code: e?.code } } })}\n`);
  process.exit(1);
}
