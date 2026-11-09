import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ observations: [] as Array<{ kind: string; direct: boolean; pooled: boolean }> }));

function observe(kind: string, url: string | undefined): void {
    boundary.observations.push({ kind, direct: url === 'direct-connection', pooled: url === 'runtime-connection' });
}

vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    const { EventEmitter } = await import('node:events');
    return { ...original, spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        boundary.observations.push({ kind: 'prisma', direct: options.env.DATABASE_URL === 'direct-connection',
            pooled: options.env.DATABASE_URL === 'runtime-connection' });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0));
        return child;
    } };
});

// The storage owner loads Prisma through CommonJS. Replace the external database
// client there, leaving real ledger, backfill, audit and deployment logic intact.
const require = createRequire(import.meta.url);
const prismaPath = require.resolve('@prisma/client');
const prismaModule: typeof import('@prisma/client') = require(prismaPath);
const prismaCache = require.cache[prismaPath]!;
class MaintenanceClient {
    constructor(options?: { datasources?: { db?: { url?: string } } }) {
        observe('maintenance', options?.datasources?.db?.url);
    }
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
    it.each([['direct-connection', true], [undefined, false], ['', false]])(
        'uses one migration connection for Prisma, ledger and final backfill (case %#)', async (directUrl, usesDirect) => {
            boundary.observations.length = 0;
            const env = { DATABASE_URL: 'runtime-connection', DIRECT_URL: directUrl };
            await runPostgresMigrationDeploy(env);
            expect(new Set(boundary.observations.map(value => value.kind))).toEqual(new Set(['maintenance', 'prisma']));
            expect(boundary.observations.every(value => value.direct === usesDirect && value.pooled === !usesDirect)).toBe(true);
            expect(env.DATABASE_URL === 'runtime-connection').toBe(true);
        },
    );
});
