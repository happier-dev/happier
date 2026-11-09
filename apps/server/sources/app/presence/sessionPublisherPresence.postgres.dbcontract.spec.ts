import { randomUUID } from 'node:crypto';
import { readSessionFollowReceiverAvailabilityChangedV1, readSessionFollowSourceChangedV1 } from '@happier-dev/protocol/changes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { createSessionPublisherPresence, expireSessionPublisherCandidates } from './sessionPublisherPresence';
import { preparePresenceTimeouts } from './timeout';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine terminal custody (PostgreSQL)', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${randomUUID().replaceAll('-', '')}`);
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    it('persists heartbeat liveness without durable publication and publishes availability recovery', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', active: false } });
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
        await db.accessKey.create({ data: { ...binding, data: 'opaque' } });
        let clock = new Date();
        const presence = createSessionPublisherPresence({ now: () => clock });
        const socket = {};
        const registered = await presence.registerPublisher({ socket, binding,
            completeActivitySnapshot: { state: 'active', activeCount: 1 } });
        if (registered.status !== 'registered') throw new Error('expected registration');
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        await db.session.update({ where: { id: session.id }, data: { updatedAt: contentAt } });
        const readContentClocks = () => db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
            updatedAt: true, metadataVersion: true, agentStateVersion: true, runtimeActivityRevision: true, seq: true,
        } });
        const contentBefore = await readContentClocks();
        const readAccount = () => db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
        const readChange = () => db.accountChange.findMany({
            where: { accountId: owner.id, kind: 'session', entityId: session.id }, select: { accountId: true, cursor: true, kind: true, hint: true } });
        const accountBefore = await readAccount();
        expect(readSessionFollowReceiverAvailabilityChangedV1((await readChange())[0]!, accountBefore.seq - 1)).toBe(true);
        let fence = registered.committedFence;
        const changeBefore = await readChange();
        const publications: number[] = [];
        const heartbeatAudiences: string[][] = [];
        // An active heartbeat extends only the liveness fence; its audience
        // reads activeAt from the realtime heartbeat, not an Account cursor.
        for (let heartbeat = 0; heartbeat < 5; heartbeat += 1) {
            clock = new Date(fence.getTime() + 60_000);
            const touched = await presence.touchPublisher({ socket });
            if (touched.status !== 'touched') throw new Error('expected heartbeat touch');
            publications.push(touched.recipientCursors.length);
            heartbeatAudiences.push([...touched.heartbeatRecipientAccountIds]);
            expect(touched.committedFence.getTime()).toBeGreaterThan(fence.getTime());
            fence = touched.committedFence;
            expect.soft(await readContentClocks()).toEqual(contentBefore);
        }
        expect(await readAccount()).toEqual({ seq: accountBefore.seq });
        expect(publications).toEqual([0, 0, 0, 0, 0]);
        expect(await readChange()).toEqual(changeBefore);
        expect(heartbeatAudiences).toEqual(Array.from({ length: 5 }, () => [owner.id]));
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
            active: true, lastActiveAt: true, publisherGeneration: true, publisherGenerationLastActiveAt: true,
        } })).resolves.toEqual({ active: true, lastActiveAt: fence,
            publisherGeneration: registered.publisherGeneration, publisherGenerationLastActiveAt: fence });
        const [expired] = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: session.id, observedFence: fence }],
        });
        expect(expired?.status).toBe('expired');
        expect.soft(await readContentClocks()).toEqual(contentBefore);
        const accountExpired = await readAccount();
        expect(readSessionFollowReceiverAvailabilityChangedV1((await readChange())[0]!, accountExpired.seq - 1)).toBe(true);
        clock = new Date(fence.getTime() + 60_000);
        const recovered = await presence.touchPublisher({ socket });
        if (recovered.status !== 'touched') throw new Error('expected recovery');
        expect(recovered.recipientCursors).toHaveLength(1);
        expect(await readAccount()).toEqual({ seq: accountExpired.seq + 1 });
        const recoveryChanges = await readChange();
        expect(recoveryChanges.map(({ accountId, cursor }) => ({ accountId, cursor }))).toEqual(recovered.recipientCursors);
        expect(readSessionFollowSourceChangedV1(recoveryChanges[0]!, accountExpired.seq)).toBe(true);
        expect(readSessionFollowReceiverAvailabilityChangedV1(recoveryChanges[0]!, accountExpired.seq)).toBe(true);
        clock = new Date(recovered.committedFence.getTime() + 60_000);
        const touchedAfterRecovery = await presence.touchPublisher({ socket });
        if (touchedAfterRecovery.status !== 'touched') throw new Error('expected heartbeat after recovery');
        expect(touchedAfterRecovery.recipientCursors).toHaveLength(0);
        expect(touchedAfterRecovery.heartbeatRecipientAccountIds).toEqual([owner.id]);
        expect(await readAccount()).toEqual({ seq: accountExpired.seq + 1 });
        expect(await readChange()).toEqual(recoveryChanges);
        const accountBeforeClose = await readAccount();
        expect(await presence.closePublisher({ socket })).toMatchObject({ status: 'closed' });
        expect(readSessionFollowReceiverAvailabilityChangedV1((await readChange())[0]!, accountBeforeClose.seq)).toBe(true);
    });

    it('recovers Machine and Session deadlines at 60 and 120 seconds from committed PostgreSQL presence', async () => {
        const base = Date.now();
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            active: true, lastActiveAt: new Date(base), updatedAt: contentAt } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            active: true, lastActiveAt: new Date(base), updatedAt: contentAt } });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        let deadlines = preparePresenceTimeouts();
        try {
            await deadlines.start();
            await vi.advanceTimersByTimeAsync(59_999);
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base), updatedAt: contentAt }));
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).active).toBe(true);
            await deadlines.stop();
            deadlines = preparePresenceTimeouts();
            await deadlines.start();
            await vi.advanceTimersByTimeAsync(base + 119_999 - Date.now());
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).active).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect(await db.session.findUniqueOrThrow({ where: { id: session.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base), updatedAt: contentAt }));
        } finally {
            await deadlines.stop();
            vi.useRealTimers();
        }
    });

    it('retires the exact foreign publisher after requester grant loss without rereading requester keys', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installationId = randomUUID();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id, installationId,
            metadata: encodePlainMachineStoredContent({ host: 'terminal-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: '{}', active: false } });
        const requesterBinding = { accountId: requester.id, machineId: machine.id, sessionId: session.id };
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        await db.accessKey.create({ data: { ...requesterBinding, data: 'opaque' } });
        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({ socket: {}, binding: requesterBinding,
            completeActivitySnapshot: { state: 'active', activeCount: 1 } });
        expect(registered, JSON.stringify(registered, (_key, value) => typeof value === 'bigint' ? String(value) : value))
            .toMatchObject({ status: 'registered' });
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id } }));

        const originalTransaction = db.$transaction;
        const reads: string[] = [];
        db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const observed = observePrismaReads(tx, ['session', 'accessKey']);
                try { return await callback(observed.tx); } finally { reads.push(...observed.reads); }
            }, ...args.slice(1)]);
        } });
        const captured = await (async () => {
            try {
                return await presence.captureMachineSessionTerminal({
                    binding: { ...requesterBinding, accountId: custodian.id }, installedMachineCustody: { installationId },
                });
            } finally { db.$transaction = originalTransaction; }
        })();
        expect(captured.status).toBe('captured');
        // The narrow process fact reads one exact Session and never reacquires requester keys.
        expect(reads.filter(read => read.startsWith('session.'))).toHaveLength(1);
        expect(reads.some(read => read.startsWith('accessKey.'))).toBe(false);
        if (captured.status !== 'captured') throw new Error('expected installed host capture');
        const beforeRetirement = await db.account.findUniqueOrThrow({ where: { id: requester.id }, select: { seq: true } });
        expect(await presence.finalizeMachineSessionTerminal({ target: captured.target,
            installedMachineCustody: { installationId } })).toMatchObject({ status: 'closed' });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
            active: true, publisherGenerationLastActiveAt: true,
        } })).toEqual({ active: false, publisherGenerationLastActiveAt: null });
        const retiredChange = await db.accountChange.findFirstOrThrow({ where: {
            accountId: requester.id, kind: 'session', entityId: session.id,
        }, select: { kind: true, cursor: true, hint: true } });
        expect(readSessionFollowReceiverAvailabilityChangedV1(retiredChange, beforeRetirement.seq)).toBe(true);
    });
});
