import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ observations: [] as Array<{ kind: string; direct: boolean; pooled: boolean }> }));

const DIRECT_URL = 'postgresql://direct.invalid/happier';
const RUNTIME_URL = 'postgresql://runtime.invalid/happier';

function observe(kind: string, url: string | undefined): void {
    const host = url ? new URL(url).hostname : undefined;
    boundary.observations.push({ kind, direct: host === 'direct.invalid', pooled: host === 'runtime.invalid' });
}

vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    const { EventEmitter } = await import('node:events');
    return { ...original, spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        observe('prisma', options.env.DATABASE_URL);
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0));
        return child;
    } };
});

// The PostgreSQL driver is the network boundary: the maintenance client's pool records its URL.
vi.mock('pg', async (importOriginal) => {
    const original = await importOriginal<typeof import('pg')>();
    class Pool {
        totalCount = 0;
        idleCount = 0;
        waitingCount = 0;
        constructor(config: { connectionString?: string }) { observe('maintenance', config.connectionString); }
        on(): this { return this; }
        async end(): Promise<void> {}
    }
    return { ...original, default: { ...original.default, Pool }, Pool };
});

// The storage owner loads Prisma through CommonJS. Replace the external database
// client there, leaving real ledger, backfill, audit and deployment logic intact.
const require = createRequire(import.meta.url);
const prismaPath = require.resolve('@prisma/client');
const prismaModule: typeof import('@prisma/client') = require(prismaPath);
const prismaCache = require.cache[prismaPath]!;
class MaintenanceClient {
    async $connect(): Promise<void> {}
    async $disconnect(): Promise<void> {}
    async $queryRawUnsafe(): Promise<unknown[]> { return []; }
    async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> { return callback(this); }
    sessionSystemRecord = { findMany: async () => [] };
    account = { findFirst: async () => null };
}
prismaCache.exports = { ...prismaModule, PrismaClient: MaintenanceClient };
afterAll(() => { prismaCache.exports = prismaModule; });
const { runPostgresMigrationDeploy } = await import('./migrate.full.deploy');

describe('Postgres migration deployment composition', () => {
    it.each([[DIRECT_URL, true], [undefined, false], ['', false]])(
        'uses one migration connection for Prisma, ledger and final backfill (case %#)', async (directUrl, usesDirect) => {
            boundary.observations.length = 0;
            const env = { DATABASE_URL: RUNTIME_URL, DIRECT_URL: directUrl };
            await runPostgresMigrationDeploy(env);
            expect(new Set(boundary.observations.map(value => value.kind))).toEqual(new Set(['maintenance', 'prisma']));
            expect(boundary.observations.every(value => value.direct === usesDirect && value.pooled === !usesDirect)).toBe(true);
            expect(env.DATABASE_URL).toBe(RUNTIME_URL);
        },
    );
});
