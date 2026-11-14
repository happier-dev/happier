import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedFakeSocket } from '@/app/api/testkit/socketHarness';
import { eventRouter } from '@/app/events/eventRouter';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { assertKeepaliveRealtimeFreshness } from './sessionUpdateHandler.presence.testkit';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Retained legacy Session keepalive durability on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { eventRouter.clearIo(); await shutdownDbClient(); });
    it('delivers two minute-spaced realtime heartbeats to owner and shared viewer with no Account cursor',
        assertKeepaliveRealtimeFreshness);

    it('retains committed content while a legacy durable heartbeat waits behind its writer', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket({ id: randomUUID() });
        const registration = await presence.registerPublisher({ socket,
            binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        expect(registration.status).toBe('registered');
        if (registration.status !== 'registered') throw new Error('Fixture publisher was not admitted');
        let releaseWriter!: () => void;
        const mayCommit = new Promise<void>(resolve => { releaseWriter = resolve; });
        let writerReady!: (value: { pid: number; updatedAt: Date }) => void;
        const contentHeld = new Promise<{ pid: number; updatedAt: Date }>(resolve => { writerReady = resolve; });
        // A genuine competing database writer holds the Session row. Presence
        // retains its actual lock, authorization, retry and Prisma write path.
        const writer = db.$transaction(async tx => {
            const content = await tx.session.update({ where: { id: session.id },
                data: { metadata: '{"path":"/concurrent-content"}', metadataVersion: { increment: 1 } },
                select: { updatedAt: true } });
            const [backend] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
            writerReady({ pid: backend!.pid, updatedAt: content.updatedAt });
            await mayCommit;
            return content;
        });
        const writerOutcome = Promise.allSettled([writer]);
        let heartbeatOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof presence.touchPublisher>>>[]> | undefined;
        try {
            const held = await Promise.race([contentHeld, writer.then(() => {
                throw new Error('Content writer completed before the lock barrier');
            })]);
            const observedAt = new Date(registration.committedFence.getTime() + 60_000);
            heartbeatOutcome = Promise.allSettled([presence.touchPublisher({ socket, observedAt })]);
            await vi.waitFor(async () => {
                const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting', held.pid);
                expect(row?.waiting).toBe(true);
            });
            releaseWriter();
            await expect(writer).resolves.toEqual({ updatedAt: held.updatedAt });
            const [result] = await heartbeatOutcome;
            if (result!.status === 'rejected') throw result!.reason;
            expect(result!.value).toMatchObject({ status: 'touched',
                recipientCursors: [], activeAt: observedAt });
            const retained = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                metadata: true, metadataVersion: true, updatedAt: true, lastActiveAt: true,
            } });
            expect(retained).toMatchObject({ metadata: '{"path":"/concurrent-content"}', metadataVersion: 1,
                lastActiveAt: observedAt });
            expect(retained.updatedAt.getTime()).toBeGreaterThanOrEqual(held.updatedAt.getTime());
        } finally {
            releaseWriter();
            await writerOutcome;
            await heartbeatOutcome;
            await presence.forgetDisconnectedPublisher({ socket });
        }
    });
});
