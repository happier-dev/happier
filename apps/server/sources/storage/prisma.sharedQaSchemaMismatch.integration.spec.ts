import Fastify from 'fastify';
import { io as ioClient } from 'socket.io-client';
import { Server } from 'socket.io';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '@/app/auth/auth';
import { startSocket } from '@/app/api/socket';
import type { Fastify as AppFastify } from '@/app/api/types';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { logger } from '@/utils/logging/log';
import { db } from './prisma';

describe('shared QA schema errors at the Prisma and socket boundaries', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-shared-schema-',
            initAuth: true,
            env: { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev-test' },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each([
        { code: 'P2021', change: 'ALTER TABLE "Machine" RENAME TO "MissingMachine"', restore: 'ALTER TABLE "MissingMachine" RENAME TO "Machine"' },
        { code: 'P2022', change: 'ALTER TABLE "Machine" RENAME COLUMN "installationPublicKey" TO "missingInstallationPublicKey"', restore: 'ALTER TABLE "Machine" RENAME COLUMN "missingInstallationPublicKey" TO "installationPublicKey"' },
    ])('preserves $code while making query, transaction and handshake errors actionable', async ({ code, change, restore }) => {
        harness.resetEnv({ HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev-test', AUTH_REQUIRED_LOGIN_PROVIDERS: undefined });
        const account = await db.account.create({ data: { publicKey: `schema-${code}` } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (typeof address !== 'object' || address === null) throw new Error('Missing test server address');
        await db.$executeRawUnsafe(change);
        const query = () => db.machine.findFirst({ select: { id: true, installationPublicKey: true } });
        const socket = ioClient(`http://127.0.0.1:${address.port}`, {
            autoConnect: false,
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: { token, clientType: 'machine-scoped', machineId: 'fixture-machine' },
        });
        try {
            for (const execute of [
                query,
                () => db.$transaction(tx => tx.machine.findFirst({ select: { id: true, installationPublicKey: true } })),
                () => db.$transaction([query()]),
            ]) {
                const error = await execute().then(() => { throw new Error('Query unexpectedly succeeded'); }, error => error);
                expect(error).toMatchObject({ code });
                expect(String(error)).toMatch(/QA snapshot.*current shared dev schema.*reload a newer snapshot/i);
            }
            harness.resetEnv({ HAPPIER_STACK_SHARED_DB_SOURCE_STACK: undefined });
            const ordinaryError = await query().then(() => null, error => error);
            expect(ordinaryError).toMatchObject({ code });
            expect(String(ordinaryError)).not.toContain('reload a newer snapshot');
            harness.resetEnv({ HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev-test' });
            const rejected = new Promise<Error & { data?: unknown }>((resolve, reject) => {
                socket.once('connect_error', resolve);
                socket.once('connect', () => reject(new Error('Incompatible socket unexpectedly connected')));
            });
            socket.connect();
            const error = await rejected;
            expect(error.data).toMatchObject({ error: 'shared_qa_schema_mismatch', statusCode: 503 });
            expect(error.message).toMatch(/QA snapshot.*current shared dev schema.*reload a newer snapshot/i);
        } finally {
            socket.close();
            await db.$executeRawUnsafe(restore);
            await app.close();
        }
    });

    it('keeps unrelated Prisma failures unchanged on a shared QA server', async () => {
        harness.resetEnv();
        await db.account.create({ data: { publicKey: 'duplicate-schema-fixture' } });
        const error = await db.account.create({ data: { publicKey: 'duplicate-schema-fixture' } })
            .then(() => null, error => error);
        expect(error).toMatchObject({ code: 'P2002' });
        expect(String(error)).not.toContain('reload a newer snapshot');
    });

    it('reports a socket event query failure through its existing log while preserving its acknowledgement', async () => {
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: undefined });
        const account = await db.account.create({ data: { publicKey: 'event-schema-fixture' } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        const io = app.machineDaemonPresence;
        if (!(io instanceof Server)) throw new Error('Missing socket test server');
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (typeof address !== 'object' || address === null) throw new Error('Missing test server address');
        const socket = ioClient(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, auth: { token },
        });
        let changedSchema = false;
        // Pino is the log-output boundary; preserve all real socket and domain logic.
        const output = vi.spyOn(logger, 'error');
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
            });
            // Client connect precedes asynchronous server admission. Observe
            // the real transport's installed handler before sending the query.
            await vi.waitFor(() => expect(io.sockets.sockets.get(socket.id!)?.listeners('access-key-get').length).toBe(1));
            await db.$executeRawUnsafe('ALTER TABLE "Machine" RENAME TO "EventMissingMachine"');
            changedSchema = true;
            const response = await socket.timeout(5_000).emitWithAck('access-key-get', {
                sessionId: 'fixture-session', machineId: 'fixture-machine',
            });
            expect(response).toEqual({ ok: false, error: 'Internal error' });
            expect(output.mock.calls.some(call => String(call[1]).includes('reload a newer snapshot'))).toBe(true);
        } finally {
            output.mockRestore();
            socket.close();
            if (changedSchema) await db.$executeRawUnsafe('ALTER TABLE "EventMissingMachine" RENAME TO "Machine"');
            await app.close();
        }
    });

    it('exits startup with the same actionable diagnostic when its real database query fails', () => {
        const result = spawnSync(process.execPath, [
            './scripts/runTsx.mjs', '--tsconfig', './tsconfig.json',
            './sources/main.light.ts', '--claim-home-owner=missing-fixture-account',
        ], {
            cwd: process.cwd(),
            env: {
                ...harness.envBase,
                DATABASE_URL: renderPrismaCompatibleSqliteDatabaseUrl({
                    dbPath: join(harness.baseDir, 'startup-missing-schema.sqlite'), platform: process.platform,
                }),
                HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev-test',
                HAPPIER_SQLITE_AUTO_MIGRATE: '0',
                HAPPIER_MANAGED_RELAY_PURPOSE: undefined,
            },
            encoding: 'utf8',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('shared_qa_schema_mismatch');
        expect(result.stderr).toMatch(/QA snapshot.*current shared dev schema.*reload a newer snapshot/i);
    });
});
