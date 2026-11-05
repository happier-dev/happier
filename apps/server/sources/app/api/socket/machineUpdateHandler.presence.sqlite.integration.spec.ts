import { encodeAutomationRunCause } from '@/app/automations/automationRunCauseCodec';
import { AutomationRunCauseSchema } from '@happier-dev/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Socket } from 'socket.io';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { setAccountStatusInTx } from '@/app/home/governance/accountLifecycle';
import { eventRouter } from '@/app/events/connectionEventRouter';
import type { ClientConnection } from '@/app/events/eventPayloadTypes';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { activityCache } from '@/app/presence/sessionCache';
import { markMachinePresenceInactive, persistMachinePresence } from '@/app/presence/persistMachinePresence';
import { createMachinePresenceDeadlineOwner, createSessionPresenceDeadlineOwner, startLocalMachinePresenceTimeout, stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { TransactionDeadlineExceededError } from '@/storage/transactionErrors';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from './machineSocketInstallationProof';
import { machineUpdateHandler, observeMachineAliveFromSocket } from './machineUpdateHandler';
import { machinesRoutes } from '../routes/machines/machinesRoutes';
import { withAuthenticatedTestApp } from '../testkit/sqliteFastify';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import * as logging from '@/utils/logging/log';
import { resolveRedisAdapterValidationRedisUrl } from '../../../../scripts/resolveRedisAdapterValidationRedisUrl';
import { publishMachineAlive, startPresenceRedisWorker } from '@/app/presence/presenceRedisQueue';

const redisBoundary = vi.hoisted(() => ({ client: null as Redis | null }));
vi.mock('@/storage/redis/redis', () => ({
    // Separate test cases represent separate server processes, each with its
    // own real isolated Redis transport rather than the module singleton.
    getRedisClient: () => {
        if (!redisBoundary.client) throw new Error('Redis test transport not initialized');
        return redisBoundary.client;
    },
}));

describe('Machine presence through current C41 recipients (real SQLite)', () => {
    let harness: LightSqliteHarness;
    let redisMemory: Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>['redisMemory'] = null;
    let redisClient: Redis | null = null;
    beforeEach(() => harness.resetEnv());
    afterEach(async () => {
        await stopLocalMachinePresenceTimeout();
        redisClient?.disconnect();
        redisClient = null;
        redisBoundary.client = null;
        await redisMemory?.stop();
        redisMemory = null;
    });
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-presence-audience-', initAuth: true,
            env: { HANDY_MASTER_SECRET: 'machine-presence-audience-secret', AUTH_REQUIRED_LOGIN_PROVIDERS: '', SERVER_ROLE: 'all',
                TZ: 'Europe/Amsterdam', HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function createMachine(accountId: string) {
        return await db.machine.create({ data: {
            id: randomUUID(), accountId, installationId: 'presence-installation', active: false,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
    }

    it('replays missed guest Workflow wakes only to the admitted installation on reconnect, without polling or private content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const other = await createMachine(owner.id);
        const automation = await db.automation.create({ data: { accountId: guest.id, name: 'Guest schedule',
            templateCiphertext: 'private definition', triggers: { create: { kind: 'schedule', scheduleKind: 'interval', everyMs: 60_000 } } },
            select: { id: true, triggers: { select: { id: true } } } });
        const triggerId = automation.triggers[0]!.id;
        const now = new Date();
        const queued = await db.automationRun.create({ data: { accountId: guest.id, automationId: automation.id,
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId,
                triggerKind: 'schedule', triggerRevision: 0, occurredAt: now.getTime(),
                occurrenceKey: createHash('sha256').update(randomUUID()).digest('base64url'),
                evidence: { scheduledFor: now.getTime() } })),
            workflowCustodyState: 'pending', state: 'queued', scheduledAt: now, dueAt: now,
            executionInputEnvelope: 'private definition must never be replayed',
            assignments: { create: { machineId: machine.id, admittedMachineInstallationId: machine.installationId } },
        } });
        const running = await db.automationRun.create({ data: { accountId: guest.id, originKind: 'direct',
            causeKind: null, workflowAcceptedSnapshotEnvelope: 'private accepted snapshot',
            workflowCustodyState: 'pending', state: 'running', scheduledAt: new Date(), dueAt: new Date(),
            assignments: { create: { machineId: machine.id, admittedMachineInstallationId: machine.installationId } },
        } });
        for (const [state, custody, installationId] of [
            ['succeeded', 'pending', machine.installationId],
            ['queued', 'settled', machine.installationId],
            ['queued', 'pending', 'retired-installation'],
        ] as const) await db.automationRun.create({ data: { accountId: guest.id, originKind: 'direct',
            causeKind: null, workflowAcceptedSnapshotEnvelope: 'private accepted snapshot',
            workflowCustodyState: custody, state, scheduledAt: new Date(), dueAt: new Date(),
            assignments: { create: { machineId: machine.id, admittedMachineInstallationId: installationId } },
        } });
        const publisher = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } });
        const foreign = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: other.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: other.installationId } });
        const wakes = () => publisher.emit.mock.calls.filter(([event, payload]) =>
            event === 'update' && payload?.body?.t === 'automation-run-updated').map(([, payload]) => payload.body);
        let assignmentReads = 0;
        const stopObserving = observeSqliteRequests({ before: request => {
            if (request.model === 'AutomationRunAssignment' && request.action === 'findMany') assignmentReads += 1;
        } });
        try {
        await observeMachineAliveFromSocket({ userId: owner.id, socket: foreign as unknown as Socket,
            timestamp: Date.now(), continuingBeat: false });
        expect(foreign.emit.mock.calls.filter(([event]) => event === 'update')).toEqual([]);
        assignmentReads = 0;
        await observeMachineAliveFromSocket({ userId: owner.id, socket: publisher as unknown as Socket,
            timestamp: Date.now(), continuingBeat: false });
        expect(wakes().map(body => body.runId).sort()).toEqual([queued.id, running.id].sort());
        expect(assignmentReads).toBe(1);
        expect(wakes()).toEqual(expect.arrayContaining([
            expect.objectContaining({ runId: queued.id, targetMachineId: machine.id,
                requesterScope: { kind: 'workflow_trigger', id: triggerId } }),
            expect.objectContaining({ runId: running.id, targetMachineId: machine.id,
                requesterScope: { kind: 'workflow_trigger', id: running.id } }),
        ]));
        expect(JSON.stringify(wakes())).not.toContain('private definition');
        expect(Object.keys(wakes()[0]).sort()).toEqual(['t', 'runId', 'automationId', 'state', 'scheduledAt',
            'startedAt', 'finishedAt', 'updatedAt', 'machineId', 'attempt', 'targetMachineId', 'requesterScope'].sort());
        await observeMachineAliveFromSocket({ userId: owner.id, socket: publisher as unknown as Socket,
            timestamp: Date.now(), continuingBeat: true });
        expect(wakes()).toHaveLength(2);
        expect(assignmentReads).toBe(1);
        } finally { stopObserving(); }
    });

    it('expires one shared Machine once at its observation fence without editing content clocks', async () => {
        const account = () => db.account.create({ data: { publicKey: `deadline-${randomUUID()}`, encryptionMode: 'plain' } });
        const [owner, viewer] = await Promise.all([account(), account()]);
        const machine = await createMachine(owner.id);
        const runner = await createMachine(owner.id);
        await db.machine.update({ where: { id: runner.id }, data: { kind: 'ephemeral_session_runner' } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: viewer.id }, level: 'view' }));
        const observedAt = new Date(Date.now() - 60_000);
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: observedAt, updatedAt: contentAt } });
        await db.machine.update({ where: { id: runner.id }, data: { active: true, lastActiveAt: observedAt, updatedAt: contentAt } });
        // A scanned fence cannot expire a newer admitted observation.
        expect(await markMachinePresenceInactive(db, { accountId: owner.id, machineId: machine.id,
            lastActiveAt: new Date(observedAt.getTime() - 1) })).toBe(0);
        const beforeAccounts = await db.account.findMany({ where: { id: { in: [owner.id, viewer.id] } },
            select: { id: true, seq: true }, orderBy: { id: 'asc' } });
        const readers = [owner, viewer].map(account => {
            const socket = createFakeSocket({ id: `deadline-reader-${account.id}`, data: { clientType: 'user-scoped' } });
            const connection: ClientConnection = { userId: account.id, connectionType: 'user-scoped', socket: socket as unknown as Socket };
            eventRouter.addConnection(account.id, connection);
            return { socket, connection };
        });
        try {
            const deadlines = createMachinePresenceDeadlineOwner();
            try {
                await deadlines.start();
                await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: runner.id } })).active).toBe(false));
            } finally { await deadlines.stop(); }
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt: observedAt, updatedAt: contentAt });
            for (const reader of readers) expect(reader.socket.emit.mock.calls.filter(([event, payload]) =>
                event === 'ephemeral' && payload?.type === 'machine-activity').map(([, payload]) => payload))
                .toEqual([{ type: 'machine-activity', id: machine.id, active: false, activeAt: observedAt.getTime() }]);
            expect(await db.machine.findUniqueOrThrow({ where: { id: runner.id }, select: { active: true, updatedAt: true } }))
                .toEqual({ active: false, updatedAt: contentAt });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { metadata: true, metadataVersion: true, daemonState: true, daemonStateVersion: true } }))
                .toEqual({ metadata: machine.metadata, metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState, daemonStateVersion: machine.daemonStateVersion });
            for (const account of beforeAccounts) {
                const change = await db.accountChange.findUniqueOrThrow({ where: {
                    accountId_kind_entityId: { accountId: account.id, kind: 'machine', entityId: machine.id },
                } });
                expect(change.cursor).toBeGreaterThan(account.seq);
            }
        } finally {
            for (const reader of readers) eventRouter.removeConnection(reader.connection.userId, reader.connection);
        }
    });

    it('recovers committed inactive presence through the canonical current-state read after a lost publication', async () => {
        const owner = await db.account.create({ data: { publicKey: `presence-reconnect-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const observedAt = new Date(Date.now() - 70_000);
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: observedAt } });
        const reader = createFakeSocket({ id: `lost-presence-reader-${owner.id}`, data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        reader.emit.mockImplementationOnce(() => { throw new Error('simulated loss before transport delivery'); });
        eventRouter.addConnection(owner.id, connection);
        const deadlines = createMachinePresenceDeadlineOwner();
        try {
            await deadlines.start();
            await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false));
        } finally {
            await deadlines.stop();
            eventRouter.removeConnection(owner.id, connection);
        }
        expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral'
            && payload?.type === 'machine-activity')).toHaveLength(1);
        // A fresh owner after the lost delivery bootstraps committed state;
        // reconnect reads do not depend on the former process's timer memory.
        await startLocalMachinePresenceTimeout();
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/machines', headers: {
                authorization: `Bearer ${token}`,
                ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject([{ id: machine.id, active: false, activeAt: observedAt.getTime() }]);
        }, { authentication: 'real' });
    });

    it.each([50_000, 60_000, 120_000])('keeps current authenticated socket heartbeats online with %i ms daemon clock lag', async lag => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const publisher = Object.assign(createFakeSocket({ data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        const reader = createFakeSocket({ data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const base = Date.now();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            // The real connect path observes the server clock before daemon beats.
            await observeMachineAliveFromSocket({ userId: owner.id, socket: publisher as unknown as Socket,
                timestamp: base, continuingBeat: false });
            const verifications = vi.spyOn(auth, 'verifyTokenForRoute');
            const content = await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { updatedAt: true, metadataVersion: true, daemonStateVersion: true } });
            const changes = await db.accountChange.count({ where: { accountId: owner.id } });
            const alive = getSocketHandler(publisher, 'machine-alive');
            for (let elapsed = 20_000; elapsed <= 180_000; elapsed += 20_000) {
                await vi.advanceTimersByTimeAsync(20_000);
                await alive({ machineId: machine.id, time: base + elapsed - lag });
                expect.soft(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                    select: { active: true, lastActiveAt: true } }))
                    .toEqual({ active: true, lastActiveAt: new Date(base + elapsed) });
            }
            expect.soft(verifications.mock.calls.length).toBe(0);
            const activity = () => reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && value?.type === 'machine-activity').map(([, value]) => value);
            // Owner ruling 2026-11-04: steady beats do not publish presence.
            expect.soft(activity()).toEqual([{ type: 'machine-activity', id: machine.id, active: true, activeAt: base, reconnected: true }]);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { updatedAt: true, metadataVersion: true, daemonStateVersion: true } })).toEqual(content);
            expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(changes);
            await alive({ machineId: machine.id, time: base + 180_000 - lag, workSummaryChanged: true });
            expect(activity()).toHaveLength(1);
            expect(reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && value?.type === 'machine-work-summary-changed').map(([, value]) => value))
                .toEqual([{ type: 'machine-work-summary-changed', machineId: machine.id }]);
            await observeMachineAliveFromSocket({ userId: owner.id, socket: publisher as unknown as Socket,
                timestamp: base + 180_000, continuingBeat: false });
            expect(activity()).toHaveLength(1);
            expect(verifications.mock.calls.length).toBe(0);
            expect(reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && value?.type === 'machine-activity' && value.active === false)).toEqual([]);
            await vi.advanceTimersByTimeAsync(59_999);
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false));
        } finally {
            await stopLocalMachinePresenceTimeout();
            eventRouter.removeConnection(owner.id, connection);
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('checks peer-renewed Machine deadlines with one read and expires once after beats stop', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const base = Date.now();
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: new Date(base) } });
        const deadlines = createMachinePresenceDeadlineOwner();
        const transaction = db.$transaction;
        let transactions = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            transactions++;
            return Reflect.apply(target, receiver, args);
        } });
        const findUnique = db.machine.findUnique;
        let reads = 0;
        let settledReads = 0;
        db.machine.findUnique = new Proxy(findUnique, { apply(target, receiver, args) {
            reads++;
            return Promise.resolve(Reflect.apply(target, receiver, args)).finally(() => { settledReads++; });
        } });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            // A peer starts with the committed observation but does not receive
            // every subsequent beat; those writes renew only their local owner.
            deadlines.schedule({ accountId: owner.id, machineId: machine.id, lastActiveAt: new Date(base) });
            for (let elapsed = 20_000; elapsed <= 300_000; elapsed += 20_000) {
                await vi.advanceTimersByTimeAsync(20_000);
                // Native database IO can outlive a fake timer callback. Settle
                // each due read before advancing another observation window.
                if (elapsed >= 60_000) await vi.waitFor(() => expect(settledReads)
                    .toBe(Math.floor((elapsed - 60_000) / 40_000) + 1));
                await persistMachinePresence(db, { accountId: owner.id, machineId: machine.id, timestamp: base + elapsed });
            }
            expect(transactions).toBe(0);
            expect(reads).toBe(7);
            await vi.advanceTimersByTimeAsync(60_000);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base + 300_000) }));
            expect(transactions).toBe(1);
        } finally {
            db.$transaction = transaction;
            db.machine.findUnique = findUnique;
            await deadlines.stop();
            vi.useRealTimers();
        }
    });

    it('reuses semantic publication admission for presence without another Machine read', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        await db.machine.update({ where: { id: machine.id }, data: { active: true } });
        const publisher = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } });
        writeAccountStoredContentCompatibilityForSocket(publisher as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: { v: 1, protocolVersion: 4 } }));
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const transaction = db.$transaction;
        let presenceReads = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Parameters<Parameters<typeof inTx>[0]>[0]) => callback(
                new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'machine') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.machine, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findUnique') return operation;
                        return (...queryArgs: Parameters<typeof tx.machine.findUnique>) => {
                            if (queryArgs[0]?.select?.lastActiveAt) presenceReads++;
                            return Reflect.apply(operation, delegate, queryArgs);
                        };
                    } });
                } }),
            ), ...args.slice(1)]);
        } });
        const callback = vi.fn();
        const daemonState = encodePlainMachineStoredContent({ status: 'offline' });
        try {
            await getSocketHandler(publisher, 'machine-update-state')({ machineId: machine.id, daemonState,
                expectedVersion: machine.daemonStateVersion, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, callback);
            expect(callback).toHaveBeenCalledWith({ result: 'success', version: machine.daemonStateVersion + 1, daemonState });
            expect(presenceReads).toBe(0);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true, daemonState: true } }))
                .toEqual({ active: true, daemonState });
        } finally { db.$transaction = transaction; }
    });

    it('delivers real continuing observations only to legacy clients with current Machine access', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: guest.id }, level: 'view' }));
        const readers = [
            { account: owner, current: false }, { account: owner, current: true },
            { account: guest, current: false }, { account: stranger, current: false },
        ].map(({ account, current }) => {
            const socket = Object.assign(createFakeSocket(), { data: { clientType: 'user-scoped' } });
            writeAccountStoredContentCompatibilityForSocket(socket,
                evaluateAccountStoredContentSocketCompatibility(current
                    ? { accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } : {}));
            const connection: ClientConnection = { userId: account.id, connectionType: 'user-scoped', socket: socket as unknown as Socket };
            eventRouter.addConnection(account.id, connection);
            return { socket, connection };
        });
        const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }), { connected: true });
        const activity = (index: number) => readers[index]!.socket.emit.mock.calls.filter(([event, payload]) =>
            event === 'ephemeral' && payload?.type === 'machine-activity').map(([, payload]) => payload);
        try {
            const observedAt = Date.now() - 1_000;
            await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: new Date(observedAt) } });
            await observeMachineAliveFromSocket({ userId: owner.id, socket: publisher as unknown as Socket,
                machineId: machine.id, timestamp: observedAt, continuingBeat: true, isCurrent: async () => true });
            const saved = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            const expected = [{ type: 'machine-activity', id: machine.id, active: true, activeAt: saved.lastActiveAt.getTime() }];
            expect.soft(activity(0)).toEqual(expected);
            expect.soft(activity(1)).toEqual([]);
            expect.soft(activity(2)).toEqual(expected);
            expect.soft(activity(3)).toEqual([]);
            expect(saved.lastActiveAt.getTime()).toBeGreaterThan(observedAt);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                principal: { kind: 'account', accountId: guest.id } }));
            for (const reader of readers) reader.socket.emit.mockClear();
            await observeMachineAliveFromSocket({ userId: owner.id, socket: publisher as unknown as Socket,
                machineId: machine.id, timestamp: Date.now(), continuingBeat: true, isCurrent: async () => true });
            expect(activity(0)).toHaveLength(1);
            expect(activity(1)).toEqual([]);
            expect(activity(2)).toEqual([]);
            expect(activity(3)).toEqual([]);
        } finally {
            for (const { connection } of readers) eventRouter.removeConnection(connection.userId, connection);
        }
    });

    it('does not query expiry while locally committed Machine observations renew the deadline', async () => {
        const owner = await db.account.create({ data: { publicKey: `presence-renewal-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }), { connected: true });
        const isCurrent = vi.fn(async () => true);
        const reader = Object.assign(createFakeSocket(), { data: { clientType: 'user-scoped' } });
        writeAccountStoredContentCompatibilityForSocket(reader,
            evaluateAccountStoredContentSocketCompatibility({ accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION }));
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        }, isMachineSocketCurrent: isCurrent });
        const base = Date.now();
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: new Date(base - 1_000) } });
        const transaction = db.$transaction;
        let transactions = 0;
        let machineAcquisitions = 0;
        let renewals = 0;
        let audiences = 0;
        const stopObserving = observeSqliteRequests({ before(request) {
            if (request.action === 'executeRaw') renewals++;
            if (request.action === 'queryRaw') audiences++;
        } });
        // Count all real transactions, including admitted beat writes, so async
        // database work remains measured after a fake timer callback returns.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            transactions++;
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Parameters<Parameters<typeof inTx>[0]>[0]) => callback(
                new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'machine') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.machine, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findUnique') return operation;
                        return (...queryArgs: Parameters<typeof tx.machine.findUnique>) => {
                            machineAcquisitions++;
                            return Reflect.apply(operation, delegate, queryArgs);
                        };
                    } });
                } }),
            ), ...args.slice(1)]);
        } });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        const advance = (elapsed: number) => vi.advanceTimersByTimeAsync(elapsed);
        try {
            const alive = getSocketHandler(publisher, 'machine-alive');
            await alive({ time: base });
            for (let elapsed = 20_000; elapsed <= 300_000; elapsed += 20_000) {
                await advance(20_000);
                await alive({ time: base + elapsed });
            }
            // Owner ruling 2026-11-04: steady beats only renew the deadline.
            expect(transactions).toBe(0);
            expect(machineAcquisitions).toBe(0);
            expect(renewals).toBe(16);
            expect.soft(audiences).toBe(0);
            expect.soft(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity')).toHaveLength(0);
            isCurrent.mockResolvedValue(false);
            const beforeRefused = renewals;
            await advance(20_000);
            await alive({ time: base + 320_000 });
            expect(renewals).toBe(beforeRefused);
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).lastActiveAt)
                .toEqual(new Date(base + 300_000));
            await advance(40_000);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base + 300_000) }));
            expect(transactions).toBe(1);
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity').map(([, payload]) => payload))
                .toEqual([{ type: 'machine-activity', id: machine.id, active: false, activeAt: base + 300_000 }]);
            isCurrent.mockResolvedValue(true);
            await alive({ time: base + 360_000 });
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity')).toHaveLength(2);
        } finally {
            eventRouter.removeConnection(owner.id, connection);
            stopObserving();
            db.$transaction = transaction;
            await stopLocalMachinePresenceTimeout();
            activityCache.invalidateMachine(machine.id);
            vi.useRealTimers();
        }
    });

    it.each(['all', 'api-memory', 'api-redis', 'all-redis'] as const)('commits each admitted observation before returning and expires at its actual 60-second deadline (%s)', async mode => {
        const redis = mode.endsWith('redis') ? await resolveRedisAdapterValidationRedisUrl({ env: {} }) : null;
        redisMemory = redis?.redisMemory ?? null;
        harness.resetEnv({ SERVER_ROLE: mode.startsWith('all') ? 'all' : 'api',
            HAPPIER_SOCKET_ADAPTER: redis ? 'redis-streams' : 'memory', REDIS_URL: redis?.redisUrl ?? '' });
        if (redis) { redisClient = redisBoundary.client = new Redis(redis.redisUrl); await redisClient.ping(); }
        const owner = await db.account.create({ data: { publicKey: `presence-deadline-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const base = Date.now();
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        await db.machine.update({ where: { id: machine.id }, data: {
            active: false, lastActiveAt: new Date(base - 70_000), updatedAt: contentAt,
        } });
        const reader = createFakeSocket({ id: `deadline-viewer-${owner.id}`, data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        const publisher = Object.assign(createFakeSocket({ id: `deadline-publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const activities = () => reader.emit.mock.calls.filter(([event, value]) =>
            event === 'ephemeral' && value?.type === 'machine-activity').map(([, value]) => value);
        const peerDeadlines = createMachinePresenceDeadlineOwner();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            const alive = getSocketHandler(publisher, 'machine-alive');
            await alive({ machineId: machine.id, time: base });
            expect.soft(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: true, lastActiveAt: new Date(base), updatedAt: contentAt });
            expect(activities()).toEqual([{ type: 'machine-activity', id: machine.id, active: true, activeAt: base }]);
            await peerDeadlines.start();
            reader.emit.mockClear();
            for (const time of [Number.NaN, Number.POSITIVE_INFINITY]) await alive({ machineId: machine.id, time });
            expect(activities()).toEqual([]);
            await vi.advanceTimersByTimeAsync(20_000);
            await alive({ machineId: machine.id, time: base + 20_000, workSummaryChanged: true });
            expect(activities()).toEqual([]);
            expect(reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && value?.type === 'machine-work-summary-changed').map(([, value]) => value))
                .toEqual([{ type: 'machine-work-summary-changed', machineId: machine.id }]);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { metadata: true, metadataVersion: true, daemonState: true, daemonStateVersion: true } }))
                .toEqual({ metadata: machine.metadata, metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState, daemonStateVersion: machine.daemonStateVersion });
            reader.emit.mockClear();
            for (let elapsed = 40_000; elapsed <= 300_000; elapsed += 20_000) {
                await vi.advanceTimersByTimeAsync(20_000);
                await alive({ machineId: machine.id, time: base + elapsed });
                expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true } }))
                    .toEqual({ active: true });
                expect(activities().filter(value => value.active === false)).toEqual([]);
            }
            reader.emit.mockClear();
            await vi.advanceTimersByTimeAsync(59_999);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true } }))
                .toEqual({ active: true });
            expect(activities()).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base + 300_000), updatedAt: contentAt }));
            await vi.waitFor(() => expect(activities()).toEqual([
                { type: 'machine-activity', id: machine.id, active: false, activeAt: base + 300_000 },
            ]));
        } finally {
            eventRouter.removeConnection(owner.id, connection);
            activityCache.invalidateMachine(machine.id);
            await peerDeadlines.stop();
            await stopLocalMachinePresenceTimeout();
            vi.useRealTimers();
        }
    });

    it('enrolls an already-running empty headless worker after the all producer consumes and ACKs recovery', async () => {
        const redis = await resolveRedisAdapterValidationRedisUrl({ env: {} });
        redisMemory = redis.redisMemory;
        harness.resetEnv({ SERVER_ROLE: 'all', HAPPIER_SOCKET_ADAPTER: 'redis-streams', REDIS_URL: redis.redisUrl });
        const producerRedis = redisClient = redisBoundary.client = new Redis(redis.redisUrl);
        const producer = startPresenceRedisWorker({ consumerName: 'all-producer', readBlockMs: 1 });
        const survivorRedis = new Redis(redis.redisUrl);
        let releaseGroupRead!: () => void;
        const groupGate = new Promise<void>(resolve => { releaseGroupRead = resolve; });
        // Hold only this worker's group-read transport. Its broadcast reader
        // must receive independently even when another consumer ACKs the wake.
        const originalRead = survivorRedis.xreadgroup.bind(survivorRedis);
        vi.spyOn(survivorRedis, 'xreadgroup').mockImplementation(async (...args) => {
            await groupGate;
            return originalRead(...args);
        });
        redisBoundary.client = survivorRedis;
        const machines = createMachinePresenceDeadlineOwner();
        const sessions = createSessionPresenceDeadlineOwner();
        const enrolled: string[] = [];
        const survivor = startPresenceRedisWorker({ consumerName: 'headless-survivor', readBlockMs: 1,
            onDeadline: observation => {
                enrolled.push(observation.id);
                if (observation.kind === 'machine') machines.schedule({ accountId: observation.accountId,
                    machineId: observation.id, lastActiveAt: new Date(observation.activeAt) });
                else sessions.schedule(new Date(observation.activeAt));
            } });
        await survivor.ready;
        await Promise.all([machines.start(), sessions.start()]); // Empty census before either activation.
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', active: false } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'fixture' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } }, disconnect: vi.fn() });
        const reader = createFakeSocket({ data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const base = Date.now();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            redisBoundary.client = producerRedis;
            await getSocketHandler(publisher, 'machine-alive')({ time: base, machineId: machine.id });
            expect(await createSessionPublisherPresence().registerPublisher({ socket: {},
                binding: { accountId: owner.id, machineId: machine.id, sessionId: session.id },
                completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
            await vi.waitFor(async () => expect((await producerRedis.xpending('presence:alive:v1', 'presence-worker'))[0]).toBe(2));
            await vi.advanceTimersByTimeAsync(5_000);
            await vi.waitFor(async () => expect((await producerRedis.xpending('presence:alive:v1', 'presence-worker'))[0]).toBe(0));
            await producer.stop();
            await stopLocalMachinePresenceTimeout(); // Producer loss after consuming/ACKing both wakes.
            await vi.advanceTimersByTimeAsync(55_000);
            await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false));
            await vi.advanceTimersByTimeAsync(60_000);
            await vi.waitFor(async () => expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).active).toBe(false));
            expect(enrolled).toEqual(expect.arrayContaining([machine.id, session.id]));
            const falsePackets = reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && (value?.type === 'machine-activity' || value?.type === 'activity') && value.active === false);
            expect(falsePackets.map(([, value]) => value.id).sort()).toEqual([machine.id, session.id].sort());
        } finally {
            releaseGroupRead();
            await Promise.all([producer.stop(), survivor.stop(), machines.stop(), sessions.stop(), stopLocalMachinePresenceTimeout()]);
            survivorRedis.disconnect();
            eventRouter.removeConnection(owner.id, connection);
            vi.useRealTimers();
        }
    });

    it('expires a released Redis producer observation through the deadline owner without a scan', async () => {
        const redis = await resolveRedisAdapterValidationRedisUrl({ env: {} });
        redisMemory = redis.redisMemory;
        harness.resetEnv({ SERVER_ROLE: 'worker', HAPPIER_SOCKET_ADAPTER: 'redis-streams', REDIS_URL: redis.redisUrl });
        redisClient = redisBoundary.client = new Redis(redis.redisUrl);
        await redisClient.ping();
        const owner = await db.account.create({ data: { publicKey: `legacy-deadline-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const base = Date.now();
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        await db.machine.update({ where: { id: machine.id }, data: {
            active: false, lastActiveAt: new Date(base - 70_000), updatedAt: contentAt,
        } });
        const reader = createFakeSocket({ data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        // Keep the real blocking Redis connection responsive to ACKs in this
        // fake-clock probe; persistence still uses the canonical 5 s cadence.
        const worker = startPresenceRedisWorker({ readBlockMs: 1 });
        const workerRedis = redisClient;
        // A blocking worker read and an API producer are separate processes.
        redisClient = redisBoundary.client = new Redis(redis.redisUrl);
        try {
            // A released API producer writes the existing stream shape, not a
            // current process-local scheduling hook. The worker must own it.
            await vi.waitFor(async () => expect(await redisClient!.xinfo('GROUPS', 'presence:alive:v1')).not.toEqual([]));
            await publishMachineAlive({ accountId: owner.id, machineId: machine.id, timestamp: base });
            await vi.waitFor(async () => {
                const pending = await redisClient!.xpending('presence:alive:v1', 'presence-worker');
                expect(Array.isArray(pending) ? pending[0] : null).toBe(1);
            });
            await vi.advanceTimersByTimeAsync(5_000);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: true, lastActiveAt: new Date(base), updatedAt: contentAt }));
            await vi.advanceTimersByTimeAsync(54_999);
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base), updatedAt: contentAt }));
            expect(reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && value?.type === 'machine-activity' && value.id === machine.id).map(([, value]) => value))
                .toEqual([{ type: 'machine-activity', id: machine.id, active: false, activeAt: base }]);
            await publishMachineAlive({ accountId: owner.id, machineId: machine.id, timestamp: base });
            await vi.waitFor(async () => {
                const pending = await redisClient!.xpending('presence:alive:v1', 'presence-worker');
                expect(Array.isArray(pending) ? pending[0] : null).toBe(1);
            });
            await vi.advanceTimersByTimeAsync(5_000);
            // A delayed released-producer entry is consumed, never a recovery.
            await vi.waitFor(async () => {
                const pending = await redisClient!.xpending('presence:alive:v1', 'presence-worker');
                expect(Array.isArray(pending) ? pending[0] : null).toBe(0);
            });
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false);
            const offlineChange = await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: owner.id, kind: 'machine', entityId: machine.id },
            } });
            // A fresh released observation recovers the same committed fact
            // and must wake an already-running Event observer, not only cold reads.
            const recoveredAt = Date.now();
            await publishMachineAlive({ accountId: owner.id, machineId: machine.id, timestamp: recoveredAt });
            await vi.waitFor(async () => expect((await redisClient!.xpending('presence:alive:v1', 'presence-worker'))[0]).toBe(1));
            await vi.advanceTimersByTimeAsync(5_000);
            await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(true));
            const recovered = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            expect(JSON.parse(recovered.presenceTransitions!)).toMatchObject({ revision: 2,
                online: { revision: 2 } });
            const recoveredChange = await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: owner.id, kind: 'machine', entityId: machine.id },
            } });
            expect(recoveredChange.cursor).toBeGreaterThan(offlineChange.cursor);
        } finally {
            await worker.stop();
            workerRedis.disconnect();
            eventRouter.removeConnection(owner.id, connection);
            await stopLocalMachinePresenceTimeout();
            vi.useRealTimers();
        }
    });

    it('keeps released 40-second enqueue traffic online after a consumer crashes before its five-second flush', async () => {
        const redis = await resolveRedisAdapterValidationRedisUrl({ env: {} });
        redisMemory = redis.redisMemory;
        harness.resetEnv({ SERVER_ROLE: 'worker', HAPPIER_SOCKET_ADAPTER: 'redis-streams', REDIS_URL: redis.redisUrl });
        const control = redisClient = redisBoundary.client = new Redis(redis.redisUrl);
        await control.xgroup('CREATE', 'presence:alive:v1', 'presence-worker', '0', 'MKSTREAM');
        const crashedConsumer = new Redis(redis.redisUrl);
        const survivorRedis = new Redis(redis.redisUrl);
        let releaseRead!: () => void;
        const gate = new Promise<void>(resolve => { releaseRead = resolve; });
        const originalRead = survivorRedis.xreadgroup.bind(survivorRedis);
        vi.spyOn(survivorRedis, 'xreadgroup').mockImplementation(async (...args) => { await gate; return originalRead(...args); });
        redisBoundary.client = survivorRedis;
        const survivor = startPresenceRedisWorker({ consumerName: 'legacy-survivor', readBlockMs: 1 });
        await survivor.ready;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const base = Date.now();
        await persistMachinePresence(db, { accountId: owner.id, machineId: machine.id, timestamp: base });
        const reader = createFakeSocket({ data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            await startLocalMachinePresenceTimeout();
            await vi.advanceTimersByTimeAsync(40_000);
            redisBoundary.client = control;
            await publishMachineAlive({ accountId: owner.id, machineId: machine.id, timestamp: base + 40_000 });
            // Exact Redis boundary state after the worker's XREADGROUP, before
            // its first five-second SQL flush. Disconnect leaves real PEL custody.
            const consumed = await crashedConsumer.xreadgroup('GROUP', 'presence-worker', 'crashed-before-flush',
                'COUNT', 1, 'STREAMS', 'presence:alive:v1', '>') as [string, [string, string[]][]][];
            const entryId = consumed[0][1][0][0];
            crashedConsumer.disconnect();
            releaseRead();
            for (const elapsed of [45_000, 50_000, 55_000]) {
                // Redis has a real clock while the deadline harness is virtual.
                // Set only this disposable PEL entry's elapsed idle age to match.
                await control.xclaim('presence:alive:v1', 'presence-worker', 'crashed-before-flush', 0,
                    entryId, 'IDLE', elapsed - 40_000, 'JUSTID');
                await vi.advanceTimersByTimeAsync(base + elapsed - Date.now());
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            // Let the real blocking Redis read settle inside the recovery
            // window before advancing the virtual Machine deadline to 60 s.
            await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).lastActiveAt)
                .toEqual(new Date(base + 40_000)));
            await vi.advanceTimersByTimeAsync(base + 60_000 - Date.now());
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true } }))
                .toEqual({ active: true, lastActiveAt: new Date(base + 40_000) }));
            expect(reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
                && value?.type === 'machine-activity' && value.active === false)).toEqual([]);
        } finally {
            releaseRead();
            await survivor.stop();
            survivorRedis.disconnect();
            crashedConsumer.disconnect();
            await stopLocalMachinePresenceTimeout();
            eventRouter.removeConnection(owner.id, connection);
            vi.useRealTimers();
        }
    });

    it('bootstraps a stored future observation without repair, then recovers only from a fresh admitted beat', async () => {
        const owner = await db.account.create({ data: { publicKey: `presence-future-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const base = Date.now();
        const future = base + 3_600_000;
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        await db.machine.update({ where: { id: machine.id }, data: { active: true,
            lastActiveAt: new Date(future), updatedAt: contentAt } });
        const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const deadlines = createMachinePresenceDeadlineOwner();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            await deadlines.start();
            const alive = getSocketHandler(publisher, 'machine-alive');
            await alive({ machineId: machine.id, time: base });
            await vi.advanceTimersByTimeAsync(3_659_999);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: true, lastActiveAt: new Date(future), updatedAt: contentAt });
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(future), updatedAt: contentAt }));
            await alive({ machineId: machine.id, time: Date.now() });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: true, lastActiveAt: new Date(Date.now()), updatedAt: contentAt });
        } finally {
            await deadlines.stop();
            await stopLocalMachinePresenceTimeout();
            activityCache.invalidateMachine(machine.id);
            vi.useRealTimers();
        }
    });

    it.each(['armed', 'late-bootstrap'] as const)('does not let a retired row future deadline hide a newly admitted Machine lifetime (%s)', async timing => {
        const previousOwner = await db.account.create({ data: { publicKey: `presence-prior-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(previousOwner.id);
        const base = Date.now();
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: new Date(base + 3_600_000) } });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        const findMany = db.machine.findMany;
        let releaseBootstrap!: () => void;
        let capturedBootstrap!: () => void;
        const released = new Promise<void>(resolve => { releaseBootstrap = resolve; });
        const captured = new Promise<void>(resolve => { capturedBootstrap = resolve; });
        let bootstrap: ReturnType<typeof startLocalMachinePresenceTimeout> | undefined;
        try {
            if (timing === 'late-bootstrap') {
                // Hold only the real DB census result after it captured the old
                // row. The new public admission can commit before it is armed.
                db.machine.findMany = new Proxy(findMany, { apply(target, receiver, args: unknown[]) {
                    return Promise.resolve(Reflect.apply(target, receiver, args)).then(async rows => {
                        capturedBootstrap();
                        await released;
                        return rows;
                    });
                } });
                bootstrap = startLocalMachinePresenceTimeout();
                await captured;
                db.machine.findMany = findMany;
            } else await startLocalMachinePresenceTimeout();
            // A deleted row is not the installation identity of a subsequent
            // registration, even when a caller reuses its public Machine id.
            await db.machine.delete({ where: { id: machine.id } });
            const owner = await db.account.create({ data: { publicKey: `presence-next-${randomUUID()}`, encryptionMode: 'plain' } });
            await db.machine.create({ data: { id: machine.id, accountId: owner.id, installationId: 'next-installation',
                metadata: machine.metadata, daemonState: machine.daemonState, dataEncryptionKey: machine.dataEncryptionKey,
                active: false, lastActiveAt: new Date(base) } });
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: 'next-installation' } }),
                { handshake: { auth: { token } }, disconnect: vi.fn() });
            machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            } });
            await getSocketHandler(publisher, 'machine-alive')({ time: base });
            releaseBootstrap();
            await bootstrap;
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true, lastActiveAt: true } }))
                .toEqual({ active: true, lastActiveAt: new Date(base) });
            await vi.advanceTimersByTimeAsync(60_000);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true } })).toEqual({ active: false, lastActiveAt: new Date(base) }));
        } finally {
            db.machine.findMany = findMany;
            releaseBootstrap();
            await bootstrap;
            await stopLocalMachinePresenceTimeout();
            activityCache.invalidateMachine(machine.id);
            vi.useRealTimers();
        }
    });

    it('retains failed SQL deadline custody until the existing timeout cadence can settle it', async () => {
        const owner = await db.account.create({ data: { publicKey: `presence-retry-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const base = Date.now();
        await db.machine.update({ where: { id: machine.id }, data: { active: true, lastActiveAt: new Date(base) } });
        const reader = createFakeSocket({ id: `retry-viewer-${owner.id}`, data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        const deadlines = createMachinePresenceDeadlineOwner();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        const transaction = db.$transaction;
        let transactionCalls = 0;
        // The exported client is a routing Proxy, not a spy-able own method.
        // Fail only its real database transaction boundary, then restore it.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            transactionCalls++;
            if (transactionCalls === 1) return Promise.reject(new Error('transient database boundary unavailable'));
            return Reflect.apply(target, receiver, args);
        } });
        try {
            deadlines.schedule({ accountId: owner.id, machineId: machine.id, lastActiveAt: new Date(base) });
            await vi.advanceTimersByTimeAsync(60_000);
            await vi.waitFor(() => expect(transactionCalls).toBe(1));
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true } }))
                .toEqual({ active: true });
            await vi.advanceTimersByTimeAsync(60_000);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true } })).toEqual({ active: false, lastActiveAt: new Date(base) }));
            await vi.waitFor(() => expect(reader.emit.mock.calls.filter(([event, payload]) =>
                event === 'ephemeral' && payload?.type === 'machine-activity')).toHaveLength(1));
            const settled = transactionCalls;
            await vi.advanceTimersByTimeAsync(120_000);
            expect(transactionCalls).toBe(settled);
        } finally {
            db.$transaction = transaction;
            await deadlines.stop();
            eventRouter.removeConnection(owner.id, connection);
            vi.useRealTimers();
        }
    });


    it.each(['current', 'future'] as const)('admits a genuine daemon state publication through the same presence deadline (%s)', async observation => {
        const owner = await db.account.create({ data: { publicKey: `presence-state-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const base = Date.now();
        const priorObservation = observation === 'future' ? base + 3_600_000 : base - 70_000;
        await db.machine.update({ where: { id: machine.id }, data: { active: observation === 'future',
            lastActiveAt: new Date(priorObservation), updatedAt: new Date('2025-01-01T00:00:00.000Z') } });
        const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const daemonState = encodePlainMachineStoredContent({ status: 'running', pid: 42 });
        writeAccountStoredContentCompatibilityForSocket(publisher as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({
                accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            }));
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            const reply = vi.fn();
            await getSocketHandler(publisher, 'machine-update-state')({ machineId: machine.id, daemonState,
                expectedVersion: machine.daemonStateVersion, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, reply);
            expect(reply).toHaveBeenCalledWith({ result: 'success', version: machine.daemonStateVersion + 1, daemonState });
            const changed = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            expect(changed.daemonState).toBe(daemonState);
            expect(changed.daemonStateVersion).toBe(machine.daemonStateVersion + 1);
            expect(changed.lastActiveAt).toEqual(new Date(observation === 'future' ? priorObservation : base));
            if (observation === 'future') return;
            const changesAfterContent = await db.accountChange.count({ where: { accountId: owner.id } });
            await vi.advanceTimersByTimeAsync(60_000);
            await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true, daemonState: true, daemonStateVersion: true } }))
                .toEqual({ active: false, lastActiveAt: new Date(base), updatedAt: changed.updatedAt,
                    daemonState, daemonStateVersion: machine.daemonStateVersion + 1 }));
            expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(changesAfterContent);
        } finally {
            await stopLocalMachinePresenceTimeout();
            activityCache.invalidateMachine(machine.id);
            vi.useRealTimers();
        }
    });

    it.each([
        { event: 'machine-update-metadata', deadline: false },
        { event: 'machine-update-state', deadline: false },
        { event: 'machine-update-state', deadline: true },
    ] as const)('keeps $event storage failures structural (deadline: $deadline) after actual current-protocol admission', async ({ event, deadline }) => {
        const owner = await db.account.create({ data: { publicKey: `presence-error-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const publisher = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } }, disconnect: vi.fn() });
        writeAccountStoredContentCompatibilityForSocket(publisher as unknown as Socket,
            evaluateAccountStoredContentSocketCompatibility({
                accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            }));
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        const transaction = db.$transaction;
        const sentinel = { message: 'database-secret-message', path: '/Users/alice/private/machine.db', token: 'TOKEN_SECRET' };
        db.$transaction = new Proxy(transaction, { apply() { return Promise.reject(deadline
            ? new TransactionDeadlineExceededError(sentinel, 'machine-daemon-state') : sentinel); } });
        const logs = vi.spyOn(logging, 'log');
        const callback = vi.fn();
        try {
            await getSocketHandler(publisher, event)({ machineId: machine.id,
                expectedVersion: event === 'machine-update-state' ? machine.daemonStateVersion : machine.metadataVersion,
                expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                ...(event === 'machine-update-state' ? { daemonState: machine.daemonState! } : { metadata: machine.metadata }),
            }, callback);
            const errorCode = deadline ? 'database_transaction_timeout' : 'internal_error';
            expect(callback).toHaveBeenCalledWith({ result: 'error', message: deadline ? errorCode : 'Internal error' });
            expect(logs).toHaveBeenCalledWith({ module: 'websocket', level: 'error', event, errorCode }, expect.any(String));
            const outward = JSON.stringify({ logs: logs.mock.calls, responses: callback.mock.calls });
            for (const secret of Object.values(sentinel)) expect(outward).not.toContain(secret);
        } finally { db.$transaction = transaction; logs.mockRestore(); }
    });

    it('keeps 137 Machines renewing for 300 seconds out of content clocks and Account changes', async () => {
        const owner = await db.account.create({ data: { publicKey: `presence-clocks-${randomUUID()}`, encryptionMode: 'plain' } });
        const machines: Awaited<ReturnType<typeof createMachine>>[] = [];
        for (let index = 0; index < 137; index++) machines.push(await createMachine(owner.id));
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        const base = Date.now() - 300_000;
        await db.machine.updateMany({ where: { accountId: owner.id }, data: {
            active: true, lastActiveAt: new Date(base), updatedAt: contentAt,
        } });
        const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
        const changesBefore = await db.accountChange.count({ where: { accountId: owner.id } });

        for (let elapsed = 20_000; elapsed <= 300_000; elapsed += 20_000) {
            await inTx(async tx => {
                for (const machine of machines) await persistMachinePresence(tx, {
                    accountId: owner.id, machineId: machine.id, timestamp: base + elapsed,
                });
            }, { transactionClass: 'presence-clock-contract' });
        }

        expect(await db.machine.count({ where: { accountId: owner.id, updatedAt: { not: contentAt } } }))
            .toBe(0);
        expect(await db.machine.count({ where: { accountId: owner.id, active: true, lastActiveAt: new Date(base + 300_000) } }))
            .toBe(137);
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual(before);
        expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(changesBefore);

        // A real content writer still advances its clock. A later presence write
        // must retain that committed value, rather than restoring an old sample.
        const changed = await db.machine.update({ where: { id: machines[0]!.id }, data: { metadata: 'changed-content' } });
        expect(changed.updatedAt.getTime()).toBeGreaterThan(contentAt.getTime());
        await persistMachinePresence(db, { accountId: owner.id, machineId: changed.id, timestamp: base + 320_000 });
        expect(await db.machine.findUniqueOrThrow({ where: { id: changed.id }, select: { metadata: true, updatedAt: true, lastActiveAt: true } }))
            .toEqual({ metadata: changed.metadata, updatedAt: changed.updatedAt, lastActiveAt: new Date(base + 320_000) });
    });

    it.each(['custodian', 'revoked', 'replaced', 'newer-observation'] as const)(
        'does not revive a queued Machine after its %s fence changes', async loss => {
            const owner = await db.account.create({ data: { publicKey: `presence-fence-${randomUUID()}`, encryptionMode: 'plain' } });
            const machine = await createMachine(owner.id);
            const base = Date.now() - 100_000;
            await db.machine.update({ where: { id: machine.id }, data: { lastActiveAt: new Date(base) } });
            if (loss === 'custodian') {
                const nextOwner = await db.account.create({ data: { publicKey: `presence-next-${randomUUID()}`, encryptionMode: 'plain' } });
                await db.machine.update({ where: { id: machine.id }, data: { accountId: nextOwner.id } });
            } else if (loss === 'revoked') {
                await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            } else if (loss === 'replaced') {
                const replacement = await createMachine(owner.id);
                await db.machine.update({ where: { id: machine.id }, data: { replacedByMachineId: replacement.id } });
            } else {
                await db.machine.update({ where: { id: machine.id }, data: { lastActiveAt: new Date(base + 80_000) } });
            }
            const select = { active: true, lastActiveAt: true, updatedAt: true } as const;
            const before = await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select });
            await persistMachinePresence(db, { accountId: owner.id, machineId: machine.id, timestamp: base + 40_000 });
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select })).toEqual(before);
        },
    );

    it.each(['installation', 'custodian', 'revoked', 'scope', 'private_payload'] as const)(
        'admits content-free usage source settlement only while publisher authority is current (%s)', async loss => {
            const owner = await db.account.create({ data: { publicKey: `usage-${randomUUID()}`, encryptionMode: 'plain' } });
            const machine = await createMachine(owner.id);
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const reader = Object.assign(createFakeSocket({ id: `usage-reader-${randomUUID()}`, data: { clientType: 'user-scoped' } }),
                { disconnect: vi.fn() });
            const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
            eventRouter.addConnection(owner.id, connection);
            const publisher = Object.assign(createFakeSocket({ data: {
                clientType: 'machine-scoped', machineId: machine.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
            } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
            machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            } });
            const payload = { type: 'usage-sources-invalidated', machineId: machine.id, installationId: machine.installationId };
            const wakes = () => reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral' && value?.type === payload.type)
                .map(([, value]) => value);
            try {
                const invalidate = getSocketHandler(publisher, payload.type);
                await invalidate(payload);
                expect(wakes()).toEqual([payload]);
                reader.emit.mockClear();
                if (loss === 'installation') await db.machine.update({ where: { id: machine.id }, data: { installationId: 'replacement' } });
                if (loss === 'custodian') {
                    const next = await db.account.create({ data: { publicKey: `usage-next-${randomUUID()}`, encryptionMode: 'plain' } });
                    await db.machine.update({ where: { id: machine.id }, data: { accountId: next.id } });
                }
                if (loss === 'revoked') await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
                if (loss === 'scope') publisher.data!.clientType = 'user-scoped';
                await invalidate(loss === 'private_payload' ? { ...payload, root: '/private/source' } : payload);
                expect(wakes()).toEqual([]);
            } finally { eventRouter.removeConnection(owner.id, connection); }
        },
    );

    it('publishes only safe Machine liveness to owner, Manage and Use, excluding outsiders and retired grants', async () => {
        const account = () => db.account.create({ data: { publicKey: `presence-${randomUUID()}`, encryptionMode: 'plain' } });
        const [owner, manager, user, outsider] = await Promise.all([account(), account(), account(), account()]);
        const machine = await createMachine(owner.id);
        for (const [recipient, level] of [[manager, 'admin'], [user, 'view']] as const) {
            expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                principal: { kind: 'account', accountId: recipient.id }, level }))).toMatchObject({ kind: 'saved' });
        }
        await db.session.create({ data: { accountId: user.id, tag: randomUUID(), metadata: 'private-requester-title-and-content' } });
        const connections: ClientConnection[] = [];
        // Only the Socket.IO adapter is replaced. EventRouter, authentication,
        // C41 grants/membership and the presence cache execute their real owners.
        const recipients = [owner, manager, user, outsider].map(account => {
            const socket = Object.assign(createFakeSocket({ id: `presence-${account.id}`, data: { clientType: 'user-scoped' } }),
                { disconnect: vi.fn() });
            const connection: ClientConnection = { userId: account.id, connectionType: 'user-scoped', socket: socket as unknown as Socket };
            eventRouter.addConnection(account.id, connection);
            connections.push(connection);
            return { accountId: account.id, socket, activities: () => socket.emit.mock.calls
                .filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity')
                .map(([, payload]) => payload) };
        });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const publisher = Object.assign(createFakeSocket({ id: `publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        const publisherConnection: ClientConnection = { userId: owner.id, connectionType: 'machine-scoped', machineId: machine.id,
            socket: publisher as unknown as Socket };
        eventRouter.addConnection(owner.id, publisherConnection);
        connections.push(publisherConnection);
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        try {
            vi.useFakeTimers({ toFake: ['Date'] });
            const timestamp = Date.now();
            await getSocketHandler(publisher, 'machine-alive')({ time: timestamp });
            const expected = { type: 'machine-activity', id: machine.id, active: true, activeAt: timestamp };
            for (const recipient of recipients.slice(0, 3)) expect(recipient.activities()).toEqual([expected]);
            expect(recipients[3].activities()).toEqual([]);
            expect(publisher.emit.mock.calls.filter(([event]) => event === 'ephemeral')).toEqual([]);
            for (const recipient of recipients.slice(0, 3)) {
                expect(Object.keys(recipient.activities()[0]).sort()).toEqual(['active', 'activeAt', 'id', 'type']);
                expect(JSON.stringify(recipient.activities())).not.toContain('private-requester-title-and-content');
            }
            // Only a real transition resolves the new audience after grant changes.
            expect(await markMachinePresenceInactive(db, { accountId: owner.id, machineId: machine.id,
                lastActiveAt: new Date(timestamp) })).toBe(1);
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                principal: { kind: 'account', accountId: manager.id } }))).toMatchObject({ kind: 'removed' });
            await db.account.update({ where: { id: user.id }, data: { status: 'suspended' } });
            for (const recipient of recipients) recipient.socket.emit.mockClear();
            const nextTimestamp = timestamp + 1;
            vi.setSystemTime(nextTimestamp);
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: nextTimestamp });
            expect(recipients[0].activities()).toEqual([{ ...expected, activeAt: nextTimestamp }]);
            for (const recipient of recipients.slice(1)) expect(recipient.activities()).toEqual([]);
        } finally {
            for (const connection of connections) eventRouter.removeConnection(connection.userId, connection);
            activityCache.invalidateMachine(machine.id);
            vi.useRealTimers();
        }
    });

    it.each(['installation', 'replacement'] as const)('keeps the stale installed publisher fence when the Machine loses its %s', async loss => {
        const owner = await db.account.create({ data: { publicKey: `publisher-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const reader = Object.assign(createFakeSocket({ id: `reader-${randomUUID()}`, data: { clientType: 'user-scoped' } }),
            { disconnect: vi.fn() });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        const publisher = Object.assign(createFakeSocket({ id: `publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        try {
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: Date.now() });
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity'))
                .toHaveLength(1);
            reader.emit.mockClear();
            if (loss === 'installation') {
                await db.machine.update({ where: { id: machine.id }, data: { installationId: 'replacement-installation' } });
            } else {
                const replacement = await createMachine(owner.id);
                await db.machine.update({ where: { id: machine.id }, data: { replacedByMachineId: replacement.id } });
            }
            // Installation/replacement remains a write fence, independent of credential admission.
            expect(publisher.connected).toBe(true);
            const beforeDeniedBeat = await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } });
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: Date.now() });
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity'))
                .toEqual([]);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } })).toEqual(beforeDeniedBeat);
        } finally {
            eventRouter.removeConnection(owner.id, connection);
            activityCache.invalidateMachine(machine.id);
        }
    });

    it('preserves an authenticated custodian heartbeat for a genuinely uninstalled predecessor Machine', async () => {
        const owner = await db.account.create({ data: { publicKey: `legacy-presence-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await createMachine(owner.id);
        await db.machine.update({ where: { id: machine.id }, data: { installationId: null } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const reader = Object.assign(createFakeSocket({ id: `legacy-reader-${randomUUID()}`, data: { clientType: 'user-scoped' } }),
            { disconnect: vi.fn() });
        const connection: ClientConnection = { userId: owner.id, connectionType: 'user-scoped', socket: reader as unknown as Socket };
        eventRouter.addConnection(owner.id, connection);
        const publisher = Object.assign(createFakeSocket({ id: `legacy-publisher-${machine.id}`, data: {
            clientType: 'machine-scoped', machineId: machine.id,
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, publisher as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        try {
            const timestamp = Date.now();
            await getSocketHandler(publisher, 'machine-alive')({ machineId: machine.id, time: timestamp });
            const receivedAt = Date.now();
            const stored = await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { lastActiveAt: true } });
            const serverTimestamp = stored.lastActiveAt.getTime();
            expect(reader.emit.mock.calls.filter(([event, payload]) => event === 'ephemeral' && payload?.type === 'machine-activity')
                .map(([, payload]) => payload))
                .toEqual([{ type: 'machine-activity', id: machine.id, active: true, activeAt: serverTimestamp }]);
            expect(serverTimestamp).toBeGreaterThanOrEqual(timestamp);
            expect(serverTimestamp).toBeLessThanOrEqual(receivedAt);
        } finally {
            eventRouter.removeConnection(owner.id, connection);
            activityCache.invalidateMachine(machine.id);
        }
    });
});
