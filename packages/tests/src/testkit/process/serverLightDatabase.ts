import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRootDir } from '../paths';

export type ServerLightQueryableDbProvider = 'sqlite' | 'postgres' | 'mysql';

type ServerLightDatabaseClient = Readonly<{
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
