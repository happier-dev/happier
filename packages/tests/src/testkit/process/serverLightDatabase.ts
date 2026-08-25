import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRootDir } from '../paths';

export type ServerLightQueryableDbProvider = 'sqlite' | 'postgres' | 'mysql';

type ServerLightDatabaseTransaction = Readonly<{
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}>;

type ServerLightDatabaseClient = Readonly<{
  account: Readonly<{
    findUnique(args: unknown): Promise<unknown>;
  }>;
  session: Readonly<{
    findUnique(args: unknown): Promise<unknown>;
  }>;
  sessionPendingMessage: Readonly<{
    count(args: unknown): Promise<number>;
  }>;
  sessionTurn: Readonly<{
    count(args: unknown): Promise<number>;
  }>;
  sessionSystemRecord: Readonly<{
    findMany(args: unknown): Promise<unknown[]>;
  }>;
  voiceSessionLease: Readonly<{
    findUnique(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<number>;
  }>;
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $transaction<T>(
    callback: (tx: ServerLightDatabaseTransaction) => Promise<T>,
    options?: Readonly<{
      isolationLevel?: 'Serializable';
      maxWait?: number;
      timeout?: number;
    }>,
  ): Promise<T>;
  $disconnect(): Promise<void>;
}>;

type ServerLightDatabaseClientConstructor = new (options: Readonly<{
  datasources: Readonly<{ db: Readonly<{ url: string }> }>;
}>) => ServerLightDatabaseClient;

async function loadServerLightDatabaseClientConstructor(
  provider: ServerLightQueryableDbProvider,
): Promise<ServerLightDatabaseClientConstructor> {
  if (provider === 'postgres') {
    const requireFromServer = createRequire(resolve(repoRootDir(), 'apps', 'server', 'package.json'));
    const module = requireFromServer('@prisma/client') as { PrismaClient?: unknown };
    if (typeof module.PrismaClient !== 'function') {
      throw new Error('Invalid generated PostgreSQL Prisma client for server-light inspection.');
    }
    // Prisma is a genuine database boundary; generated constructors share this structural test contract.
    return module.PrismaClient as ServerLightDatabaseClientConstructor;
  }

  const entrypoint = resolve(
    repoRootDir(),
    'apps',
    'server',
    'generated',
    `${provider}-client`,
    'index.js',
  );
  const module = await import(pathToFileURL(entrypoint).href) as { PrismaClient?: unknown };
  if (typeof module.PrismaClient !== 'function') {
    throw new Error(`Invalid generated ${provider} Prisma client for server-light inspection.`);
  }
  // Prisma is a genuine database boundary; generated constructors share this structural test contract.
  return module.PrismaClient as ServerLightDatabaseClientConstructor;
}

export async function readServerLightMaterializationRows(params: Readonly<{
  provider: ServerLightQueryableDbProvider;
  databaseUrl: string;
  sessionId: string;
  operationId: string;
}>): Promise<Readonly<{
  session: unknown;
  pendingMessageCount: number;
  turnCount: number;
  historicalRows: unknown[];
}>> {
  const PrismaClient = await loadServerLightDatabaseClientConstructor(params.provider);
  const database = new PrismaClient({
    datasources: { db: { url: params.databaseUrl } },
  });

  try {
    const [session, pendingMessageCount, turnCount, historicalRows] = await Promise.all([
      database.session.findUnique({
        where: { id: params.sessionId },
        select: {
          materializationPublicationId: true,
          materializedThroughSourceAt: true,
          publishedThroughServerSeq: true,
        },
      }),
      database.sessionPendingMessage.count({
        where: { sessionId: params.sessionId },
      }),
      database.sessionTurn.count({
        where: { sessionId: params.sessionId },
      }),
      database.sessionSystemRecord.findMany({
        where: {
          sessionId: params.sessionId,
          namespace: 'external_sessions',
          kind: 'historical_import',
          localId: `historical-import:${params.operationId}`,
        },
        select: { content: true },
      }),
    ]);

    return {
      session,
      pendingMessageCount,
      turnCount,
      historicalRows,
    };
  } finally {
    await database.$disconnect();
  }
}

export async function resolveServerLightAccountId(params: Readonly<{
  provider: ServerLightQueryableDbProvider;
  databaseUrl: string;
  publicKey: string;
}>): Promise<string> {
  const PrismaClient = await loadServerLightDatabaseClientConstructor(params.provider);
  const database = new PrismaClient({
    datasources: { db: { url: params.databaseUrl } },
  });

  try {
    const account = await database.account.findUnique({
      where: { publicKey: params.publicKey },
      select: { id: true },
    });
    const accountId = typeof account === 'object' && account !== null
      && typeof (account as { id?: unknown }).id === 'string'
      ? (account as { id: string }).id
      : null;
    if (!accountId) {
      throw new Error('Expected a persisted Account for the authenticated public key.');
    }
    return accountId;
  } finally {
    await database.$disconnect();
  }
}

export async function readServerLightVoiceLeaseRows(params: Readonly<{
  provider: ServerLightQueryableDbProvider;
  databaseUrl: string;
  leaseId: string;
  expectedAccountId: string;
}>): Promise<Readonly<{
  lease: unknown;
  accountLeaseCount: number;
}>> {
  const PrismaClient = await loadServerLightDatabaseClientConstructor(params.provider);
  const database = new PrismaClient({
    datasources: { db: { url: params.databaseUrl } },
  });

  try {
    const lease = await database.voiceSessionLease.findUnique({
      where: { id: params.leaseId },
      select: { accountId: true, sessionId: true },
    });
    const accountLeaseCount = await database.voiceSessionLease.count({
      where: { accountId: params.expectedAccountId },
    });

    return { lease, accountLeaseCount };
  } finally {
    await database.$disconnect();
  }
}

const VOICE_MINT_ADVISORY_LOCK_QUERY =
  'SELECT pg_advisory_xact_lock(hashtextextended($2, $1::bigint))';
const VOICE_MINT_ADVISORY_LOCK_SEED = 0x766f6963;

function rawCount(value: unknown, label: string): number {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`Expected one ${label} row.`);
  }
  const row = value[0];
  const count = typeof row === 'object' && row !== null
    ? (row as { count?: unknown }).count
    : null;
  if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) return count;
  if (typeof count === 'bigint') {
    const asNumber = Number(count);
    if (Number.isSafeInteger(asNumber) && asNumber >= 0) return asNumber;
  }
  throw new Error(`Expected a non-negative ${label} count.`);
}

export async function countServerLightPostgresVoiceMintLockWaiters(params: Readonly<{
  databaseUrl: string;
  accountId: string;
}>): Promise<number> {
  const PrismaClient = await loadServerLightDatabaseClientConstructor('postgres');
  const database = new PrismaClient({
    datasources: { db: { url: params.databaseUrl } },
  });

  try {
    const rows = await database.$queryRawUnsafe(
      `WITH voice_lock_key AS (
         SELECT hashtextextended($2, $1::bigint) AS key
       )
       SELECT count(*)::int AS count
       FROM pg_locks AS locks
       CROSS JOIN voice_lock_key
       WHERE locks.locktype = 'advisory'
         AND locks.granted = false
         AND locks.classid = (((voice_lock_key.key >> 32) & 4294967295)::oid)
         AND locks.objid = ((voice_lock_key.key & 4294967295)::oid)
         AND locks.objsubid = 1`,
      VOICE_MINT_ADVISORY_LOCK_SEED,
      params.accountId,
    );
    return rawCount(rows, 'PostgreSQL Voice advisory-lock waiter');
  } finally {
    await database.$disconnect();
  }
}

export type HeldServerLightPostgresVoiceMintLock = Readonly<{
  release(): Promise<void>;
}>;

export async function acquireServerLightPostgresVoiceMintLock(params: Readonly<{
  databaseUrl: string;
  accountId: string;
}>): Promise<HeldServerLightPostgresVoiceMintLock> {
  const PrismaClient = await loadServerLightDatabaseClientConstructor('postgres');
  const database = new PrismaClient({
    datasources: { db: { url: params.databaseUrl } },
  });
  let releaseHold: (() => void) | null = null;
  let acquiredResolve: (() => void) | null = null;
  let acquiredReject: ((error: unknown) => void) | null = null;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const transaction = database.$transaction(async (tx) => {
    try {
      await tx.$executeRawUnsafe(
        VOICE_MINT_ADVISORY_LOCK_QUERY,
        VOICE_MINT_ADVISORY_LOCK_SEED,
        params.accountId,
      );
      acquiredResolve?.();
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
    } catch (error) {
      acquiredReject?.(error);
      throw error;
    }
  }, {
    isolationLevel: 'Serializable',
    maxWait: 10_000,
    timeout: 30_000,
  });
  void transaction.catch(() => {});

  try {
    await acquired;
  } catch (error) {
    await transaction.catch(() => {});
    await database.$disconnect();
    throw error;
  }

  return {
    release: async () => {
      if (!releaseHold) throw new Error('PostgreSQL Voice advisory lock was not acquired.');
      const release = releaseHold;
      releaseHold = null;
      release();
      try {
        await transaction;
      } finally {
        await database.$disconnect();
      }
    },
  };
}
