import { PGlite } from '@electric-sql/pglite';
import { queryObjects } from 'node:v8';
import { expect, it } from 'vitest';

import { FramedPgliteSocketServer } from './pgliteFramedSocketServer.mjs';
import { createDbMaintenanceClient } from './prisma';

it('preserves a fragmented Unicode Bind and the following query', async () => {
    const database = new PGlite();
    await database.waitReady;
    const server = new FramedPgliteSocketServer({ db: database, host: '127.0.0.1', port: 0 });
    await server.start();
    const rawConnection = server.getServerConn();
    const url = new URL(`postgresql://postgres@${rawConnection}/postgres?sslmode=disable`);
    url.searchParams.set('connection_limit', '1');
    const client = await createDbMaintenanceClient('pglite', url.toString());
    try {
        const value = 'é🙂'.repeat(22_000);
        const rows = await client.$queryRaw<Array<{ value: string }>>`SELECT ${value}::text AS value`;
        expect(rows).toEqual([{ value }]);
        const following = await client.$queryRaw<Array<{ value: number }>>`SELECT 7::int AS value`;
        expect(following).toEqual([{ value: 7 }]);
    } finally {
        await client.$disconnect().catch(() => undefined);
        await server.stop();
        await database.close();
    }
}, 30_000);

it('releases completed PostgreSQL row messages across socket queries', async () => {
    const database = new PGlite();
    await database.waitReady;
    const rowConstructor = await (async () => {
        const sql = Buffer.from('SELECT 1\0');
        const frame = Buffer.alloc(5 + sql.length);
        frame[0] = 'Q'.charCodeAt(0);
        frame.writeUInt32BE(4 + sql.length, 1);
        sql.copy(frame, 5);
        const response = await database.execProtocol(frame);
        const row = response.messages.find(message => message.name === 'dataRow');
        if (!row) throw new Error('Expected PostgreSQL row response');
        return row.constructor;
    })();
    const server = new FramedPgliteSocketServer({ db: database, host: '127.0.0.1', port: 0 });
    await server.start();
    const client = await createDbMaintenanceClient('pglite', `postgresql://postgres@${server.getServerConn()}/postgres?sslmode=disable&connection_limit=1`);
    try {
        for (let index = 0; index < 12; index++) {
            await (async () => {
                const rows = await client.$queryRaw<Array<{ value: string }>>`SELECT repeat('row', 1024) AS value`;
                expect(rows).toEqual([{ value: 'row'.repeat(1024) }]);
            })();
        }
        // Collect after the response callback has finished; no completed rows belong to the socket owner.
        await new Promise(resolve => setImmediate(resolve));
        expect(queryObjects(rowConstructor, { format: 'count' })).toBe(0);
    } finally {
        await client.$disconnect().catch(() => undefined);
        await server.stop();
        await database.close();
    }
}, 30_000);

/** Prisma 7 raw-query failure carrying the PostgreSQL SQLSTATE from the driver adapter. */
function rawQueryFailure(sqlState: string) {
    return { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: sqlState } } } };
}

it('forwards database errors and recovers after an aborted transaction', async () => {
    const database = new PGlite();
    await database.waitReady;
    const server = new FramedPgliteSocketServer({ db: database, host: '127.0.0.1', port: 0 });
    await server.start();
    const client = await createDbMaintenanceClient('pglite', `postgresql://postgres@${server.getServerConn()}/postgres?sslmode=disable&connection_limit=1`);
    try {
        await expect(client.$transaction(async tx => {
            await expect(tx.$queryRaw`SELECT 1/0`).rejects.toMatchObject(rawQueryFailure('22012'));
            await tx.$queryRaw`SELECT 2`;
        })).rejects.toMatchObject(rawQueryFailure('25P02'));
        await expect(client.$queryRaw`SELECT 7::int AS value`).resolves.toEqual([{ value: 7 }]);
    } finally {
        await client.$disconnect().catch(() => undefined);
        await server.stop();
        await database.close();
    }
}, 30_000);
