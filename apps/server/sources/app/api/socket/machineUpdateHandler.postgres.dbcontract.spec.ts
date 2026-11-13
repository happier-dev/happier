import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

import type { Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
    MachineUpdateStateResponseSchema,
    encodePlainMachineStoredContent,
} from "@happier-dev/protocol";
import { auth } from "@/app/auth/auth";
import {
    evaluateAccountStoredContentSocketCompatibility,
    writeAccountStoredContentCompatibilityForSocket,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { lockMachinePresenceInTx, markMachinePresenceInactive, persistMachinePresence } from "@/app/presence/persistMachinePresence";
import { createMachinePresenceDeadlineOwner, recordMachineDisconnect } from "@/app/presence/timeout";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import * as privacyKit from "privacy-kit";

import { createFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from "../testkit/socketHarness";
import { machineUpdateHandler, observeMachineAliveFromSocket } from "./machineUpdateHandler";
import { createMachineSocketOwnershipRegistry } from './machineSocketOwnershipRegistry';
import { acquireMachinePublicationLocksInTx } from "./machinePublication";
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from "./machineSocketInstallationProof";
import { withAuthenticatedTestApp } from "../testkit/sqliteFastify";
import { currentAccountStoredContentCompatibilityHeaders } from "../testkit/accountStoredContentCompatibility";
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { machinesRoutes } from "../routes/machines/machinesRoutes";
import { MachinePublishedRowV1Schema } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";

const HANDLER_OPTIONS = {
    operationSocketBatchLimits: {
        ok: true as const,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
    },
};

const PUBLISHED_METADATA = {
    host: "publication-host",
    platform: "linux",
    happyCliVersion: "0.3.0",
    homeDir: "/home/publication",
    happyHomeDir: "/home/publication/.happier",
};

async function createMachineFixture(accountId?: string) {
    const account = accountId ? { id: accountId } : await db.account.create({ data: { encryptionMode: "plain" } });
    const installationId = randomUUID();
    const machine = await db.machine.create({
        data: {
            id: randomUUID(),
            accountId: account.id,
            metadata: encodePlainMachineStoredContent(PUBLISHED_METADATA),
            daemonState: encodePlainMachineStoredContent({ status: "offline" }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId,
        },
    });
    const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
    const socket = Object.assign(createFakeSocket({ data: {
        clientType: "machine-scoped",
        machineId: machine.id,
        [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId,
    } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
    writeAccountStoredContentCompatibilityForSocket(
        socket as unknown as Socket,
        evaluateAccountStoredContentSocketCompatibility({
            accountStoredContentCompatibility: { v: 1, protocolVersion: 4 },
        }),
    );
    machineUpdateHandler(account.id, socket as unknown as Socket, HANDLER_OPTIONS);
    return { accountId: account.id, machineId: machine.id, socket };
}

/**
 * Advance a genuine same-Account publisher at the last point before the Machine
 * writer fences publication. Older writers have no fence, so the peer advances
 * immediately before their Machine CAS and creates the PostgreSQL SSI pivot.
 */
function beforeMachinePublicationLock(machineId: string, accountId: string) {
    const transaction = db.$transaction;
    let advanced = false;
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let addressed = false;
            const advancePeer = async () => {
                if (advanced) return;
                advanced = true;
                await inTx(async (peerTx) => {
                    await markAccountChanged(peerTx, { accountId, kind: "account", entityId: accountId });
                }, { isolationLevel: "ReadCommitted", transactionClass: "machine-publication-test-peer" });
            };
            return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                    if (addressed && query.includes('FROM "Account"') && query.includes("FOR ")) await advancePeer();
                    return inner.$queryRawUnsafe(query, ...values);
                };
                if (property !== "machine") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.machine, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method === "findFirst") return (...queryArgs: Parameters<typeof tx.machine.findFirst>) => {
                        if (queryArgs[0]?.where?.id === machineId) addressed = true;
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                    if (method === "findUnique") return (...queryArgs: Parameters<typeof tx.machine.findUnique>) => {
                        if (queryArgs[0]?.where?.id === machineId) addressed = true;
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                    if (method !== "updateMany") return operation;
                    return async (...queryArgs: Parameters<typeof tx.machine.updateMany>) => {
                        if (queryArgs[0]?.where?.id === machineId) await advancePeer();
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                } });
            } }));
        }, ...args.slice(1)]);
    } });
    return () => {
        db.$transaction = transaction;
        return advanced;
    };
}

async function publishUnderContention(event: string, payload: unknown) {
    const fixture = await createMachineFixture();
    const restore = beforeMachinePublicationLock(fixture.machineId, fixture.accountId);
    const callback = vi.fn();
    let advanced = false;
    try {
        await getSocketHandler(fixture.socket, event)(payload instanceof Function ? payload(fixture) : payload, callback);
    } finally {
        advanced = restore();
    }
    return { ...fixture, callback, advanced };
}

async function withNonUtcPresenceTx<T>(run: (tx: Tx) => Promise<T>): Promise<ResolvedTransactionResult<T>> {
    return inTx(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
        expect(await tx.$queryRaw<Array<{ timeZone: string }>>`SELECT current_setting('TimeZone') AS "timeZone"`)
            .toEqual([{ timeZone: 'Asia/Kolkata' }]);
        return run(tx);
    }, { isolationLevel: 'ReadCommitted', transactionClass: 'presence-clock-contract' });
}

async function observeDaemonStateSql(run: () => Promise<void>) {
    const observer = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    const measured = { statements: 0, contentWrites: 0, publications: 0, lockStatements: 0, lockDurationMs: 0,
        machineAcquisitions: 0, presenceAcquisitions: 0, admissionReads: 0, contentReads: 0 };
    observer.$on('query', (event: Prisma.QueryEvent) => {
        const query = event.query.trimStart();
        measured.statements++;
        if (/^SELECT\b/i.test(query) && /FROM "(?:public"\.")?Machine"/.test(query)) {
            measured.machineAcquisitions++;
            if (query.includes('"operationProtocolCapabilitiesRevision"')) measured.admissionReads++;
            else if (query.includes('"daemonStateVersion"') && query.includes('"lastActiveAt"')) measured.contentReads++;
            if (query.includes('"lastActiveAt"') && /FOR UPDATE\b/.test(query)) measured.presenceAcquisitions++;
        }
        if (/^UPDATE\b/i.test(event.query) && event.query.includes('"Machine"')
            && event.query.includes('"daemonStateVersion"')) measured.contentWrites++;
        if (/INSERT INTO "(?:public"\.")?AccountChange"/.test(event.query)) measured.publications++;
        if (/FOR (?:NO KEY UPDATE|KEY SHARE|UPDATE)/i.test(event.query)) {
            measured.lockStatements++;
            measured.lockDurationMs += event.duration;
        }
    });
    await observer.$connect();
    const transaction = db.$transaction;
    // Observe genuine Prisma/PostgreSQL transport, keeping internal owners real.
    db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
        return Reflect.apply(observer.$transaction, observer, args);
    } });
    try { await run(); }
    finally { db.$transaction = transaction; await observer.$disconnect(); }
    return measured;
}

async function measureMachineAccountWrites(run: () => Promise<void>) {
    const measured = { accountWriterLocks: 0, accountAdmissionLocks: 0, accountCursorWrites: 0, publications: 0 };
    // Observe SQL at the real Prisma/Postgres transport without replacing raw
    // methods: transaction clients inherit those methods from their root client.
    const stop = observePrismaRequests(db, { before(request) {
        if (request.action !== 'queryRaw' && request.action !== 'executeRaw') return;
        const args = request.args;
        const sql = args && typeof args === 'object' && 'query' in args && typeof args.query === 'string'
            ? args.query : null;
        if (sql === null) throw new Error('Missing SQL at the Prisma transport boundary');
        if (/FROM "Account"[\s\S]*?FOR (?:NO KEY UPDATE|UPDATE)\b/.test(sql)) measured.accountWriterLocks++;
        if (/FROM "Account"[\s\S]*?FOR (?:KEY SHARE|SHARE)\b/.test(sql)) measured.accountAdmissionLocks++;
        if (/UPDATE "(?:public"\.")?Account"[\s\S]*?"seq"/.test(sql)) measured.accountCursorWrites++;
        if (/INSERT INTO "(?:public"\.")?AccountChange"/.test(sql)) measured.publications++;
    } });
    try { await run(); } finally { stop(); }
    return measured;
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "Machine writes under PostgreSQL publication contention",
    () => {
        let connected = false;
        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            vi.stubEnv("HANDY_MASTER_SECRET", "machine-publication-postgres-secret");
            vi.stubEnv("AUTH_REQUIRED_LOGIN_PROVIDERS", "");
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            initDbPostgres();
            await db.$connect();
            await auth.init();
            connected = true;
        });
        afterAll(async () => {
            if (connected) await db.$disconnect();
            vi.unstubAllEnvs();
        });

        it.each([false, true])('admits socket ownership before acquiring a recovery transaction (continuing=%s)', async continuingBeat => {
            const fixture = await createMachineFixture();
            await db.machine.update({ where: { id: fixture.machineId }, data: { active: false } });
            const transaction = db.$transaction;
            let transactions = 0;
            const transactionsAtOwnershipRead: number[] = [];
            let ownerSocketId = fixture.socket.id;
            let disconnectDuringOwnershipRead = false;
            // Only Redis and Socket.IO are substituted; publisher admission,
            // presence transitions, and PostgreSQL execute their real owners.
            const registry = createMachineSocketOwnershipRegistry({
                io: createSocketRoomDiscoveryHarness(async () => []),
                config: { enabled: true, instanceId: 'presence-admission' },
                redis: {
                    eval: vi.fn(),
                    hmget: vi.fn(async () => {
                        transactionsAtOwnershipRead.push(transactions);
                        if (disconnectDuringOwnershipRead) fixture.socket.connected = false;
                        return [ownerSocketId, null, null, null, null, null, null];
                    }),
                },
            });
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args) {
                transactions++;
                return Reflect.apply(target, receiver, args);
            } });
            const observe = () => observeMachineAliveFromSocket({
                userId: fixture.accountId, machineId: fixture.machineId,
                socket: fixture.socket as unknown as Socket, timestamp: Date.now(), continuingBeat,
                isCurrent: async () => (await registry.readOwner({ accountId: fixture.accountId,
                    machineId: fixture.machineId }))?.socketId === fixture.socket.id,
            });
            try {
                await observe();
                expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                    select: { active: true } })).toEqual({ active: true });
                expect(transactionsAtOwnershipRead).toEqual([0]);
                expect(transactions).toBe(1);

                ownerSocketId = 'superseding-socket';
                transactions = 0;
                transactionsAtOwnershipRead.length = 0;
                const beforeDenied = await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                    select: { active: true, lastActiveAt: true } });
                await observe();
                expect(transactionsAtOwnershipRead).toEqual([0]);
                expect(transactions).toBe(0);
                expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                    select: { active: true, lastActiveAt: true } })).toEqual(beforeDenied);

                ownerSocketId = fixture.socket.id;
                disconnectDuringOwnershipRead = true;
                transactionsAtOwnershipRead.length = 0;
                await observe();
                expect(transactionsAtOwnershipRead).toEqual([0]);
                expect(transactions).toBe(0);
                expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                    select: { active: true, lastActiveAt: true } })).toEqual(beforeDenied);
            } finally { db.$transaction = transaction; }
        });

        it('renews admitted present Machines without repeated admission or transaction setup', async () => {
            const fixture = await createMachineFixture();
            await db.machine.update({ where: { id: fixture.machineId }, data: { active: true, lastActiveAt: new Date(Date.now() - 1_000) } });
            const measured = { attempts: 0, reads: 0, writes: 0, transactions: 0 };
            const transaction = db.$transaction;
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args) {
                measured.transactions++;
                return Reflect.apply(target, receiver, args);
            } });
            const stopObserving = observePrismaRequests(db, { before(request) {
                measured.attempts++;
                if (request.action === 'queryRaw' || request.action.startsWith('find')) measured.reads++;
                if (request.action === 'executeRaw') measured.writes++;
            } });
            try {
                for (let beat = 0; beat < 3; beat++) {
                    await getSocketHandler(fixture.socket, 'machine-alive')({ time: Date.now() });
                }
            } finally { stopObserving(); db.$transaction = transaction; }
            console.info('MACHINE_ALIVE_DB_COST', JSON.stringify({ beats: 3, ...measured }));
            expect(measured.transactions).toBe(0);
            expect(measured.writes).toBe(3);
            expect(measured.reads).toBe(0);
            // No legacy consumer: each tick is only its conditional renewal.
            expect(measured.attempts).toBe(3);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId }, select: { active: true } }))
                .toEqual({ active: true });
        });

        it('publishes Account changes only for real changes across 19 daemon publishers', async () => {
            const first = await createMachineFixture();
            const fixtures = [first];
            for (let daemon = 1; daemon < 19; daemon++) fixtures.push(await createMachineFixture(first.accountId));
            await db.machine.update({ where: { id: first.machineId }, data: { active: false } });
            const initialOnline = await measureMachineAccountWrites(async () => observeMachineAliveFromSocket({ userId: first.accountId,
                socket: first.socket as unknown as Socket, timestamp: Date.now(), continuingBeat: true }));
            await db.machine.updateMany({ where: { accountId: first.accountId }, data: {
                active: true, lastActiveAt: new Date(Date.now() - 1_000),
            } });
            const baseline = await db.account.findUniqueOrThrow({ where: { id: first.accountId }, select: { seq: true } });
            const unchanged = await measureMachineAccountWrites(async () => {
                for (let tick = 0; tick < 3; tick++) for (const fixture of fixtures) {
                    await getSocketHandler(fixture.socket, 'machine-alive')({ time: Date.now() });
                    const ack = vi.fn();
                    await getSocketHandler(fixture.socket, 'machine-update-state')({ machineId: fixture.machineId,
                        daemonState: encodePlainMachineStoredContent({ status: 'offline' }), expectedVersion: 0,
                        expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, ack);
                    expect(ack).toHaveBeenCalledWith({ result: 'success', version: 0,
                        daemonState: encodePlainMachineStoredContent({ status: 'offline' }) });
                }
            });
            console.info('MACHINE_ACCOUNT_NOOP_COST', JSON.stringify({ daemons: 19, heartbeats: 57, equalStates: 57, ...unchanged }));
            expect(unchanged.accountWriterLocks).toBe(0);
            expect(unchanged.accountAdmissionLocks).toBe(0);
            expect(unchanged.accountCursorWrites).toBe(0);
            expect(unchanged.publications).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: first.accountId }, select: { seq: true } })).toEqual(baseline);
            const disconnect = () => recordMachineDisconnect({ accountId: first.accountId, machineId: first.machineId },
                async () => true, async () => undefined);
            const offline = await measureMachineAccountWrites(disconnect);
            const online = await measureMachineAccountWrites(async () => observeMachineAliveFromSocket({ userId: first.accountId,
                socket: first.socket as unknown as Socket, timestamp: Date.now(), continuingBeat: true }));
            const state = encodePlainMachineStoredContent({ status: 'running' });
            const changed = await measureMachineAccountWrites(async () => {
                const ack = vi.fn();
                await getSocketHandler(first.socket, 'machine-update-state')({ machineId: first.machineId,
                    daemonState: state, expectedVersion: 0, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, ack);
                expect(ack).toHaveBeenCalledWith({ result: 'success', version: 1, daemonState: state });
            });
            await disconnect();
            const recoveredState = encodePlainMachineStoredContent({ status: 'shutting-down' });
            const recovery = await measureMachineAccountWrites(async () => {
                const ack = vi.fn();
                await getSocketHandler(first.socket, 'machine-update-state')({ machineId: first.machineId,
                    daemonState: recoveredState, expectedVersion: 1, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, ack);
                expect(ack).toHaveBeenCalledWith({ result: 'success', version: 2, daemonState: recoveredState });
            });
            console.info('MACHINE_ACCOUNT_TRANSITION_COST', JSON.stringify({ initialOnline, offline, online, changed, recovery }));
            for (const measurement of [initialOnline, offline, online, changed, recovery]) {
                expect(measurement.accountWriterLocks).toBe(1);
                expect(measurement.accountCursorWrites).toBe(1);
                expect(measurement.publications).toBe(1);
            }
            expect(await db.account.findUniqueOrThrow({ where: { id: first.accountId }, select: { seq: true } }))
                .toEqual({ seq: baseline.seq + 5 });
            expect(await db.machine.findUniqueOrThrow({ where: { id: first.machineId }, select: { active: true, daemonStateVersion: true } }))
                .toEqual({ active: true, daemonStateVersion: 2 });
        });

        it('reuses the semantic publisher row acquisition for its presence write', async () => {
            const fixture = await createMachineFixture();
            const callback = vi.fn();
            const daemonState = encodePlainMachineStoredContent({ status: 'running' });
            const measured = await observeDaemonStateSql(async () => {
                await getSocketHandler(fixture.socket, 'machine-update-state')({ machineId: fixture.machineId,
                    daemonState, expectedVersion: 0, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }, callback);
            });
            expect(callback).toHaveBeenCalledWith({ result: 'success', version: 1, daemonState });
            console.info('MACHINE_SEMANTIC_PRESENCE_SQL_COST', JSON.stringify(measured));
            expect(measured.presenceAcquisitions).toBe(0);
        });

        it('reads a peer-renewed Machine deadline once without transaction setup and preserves real expiry', async () => {
            const fixture = await createMachineFixture();
            const base = Date.now();
            await db.machine.update({ where: { id: fixture.machineId }, data: { active: true, lastActiveAt: new Date(base) } });
            const observer = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
            let statements = 0;
            let transactions = 0;
            let settledDatabaseOperations = 0;
            observer.$on('query', () => { statements++; });
            await observer.$connect();
            const transaction = db.$transaction;
            const findUnique = db.machine.findUnique;
            db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
                transactions++;
                return Reflect.apply(observer.$transaction, observer, args)
                    .finally(() => { settledDatabaseOperations++; });
            } });
            // Both paths use the real PostgreSQL transport so the count includes
            // transaction setup/locks, rather than just Prisma delegate calls.
            db.machine.findUnique = new Proxy(findUnique, { apply(_target, _receiver, args) {
                return Promise.resolve(Reflect.apply(observer.machine.findUnique, observer.machine, args))
                    .finally(() => { settledDatabaseOperations++; });
            } });
            const deadlines = createMachinePresenceDeadlineOwner(60_000);
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            vi.setSystemTime(base);
            try {
                deadlines.schedule({ accountId: fixture.accountId, machineId: fixture.machineId,
                    lastActiveAt: new Date(base - 60_000) });
                await vi.advanceTimersByTimeAsync(0);
                await vi.waitFor(() => expect(settledDatabaseOperations).toBe(1));
                expect(statements).toBe(1);
                expect(transactions).toBe(0);
                await vi.advanceTimersByTimeAsync(60_000);
                await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                    select: { active: true, lastActiveAt: true } }))
                    .toEqual({ active: false, lastActiveAt: new Date(base) }));
                expect(transactions).toBe(1);
            } finally {
                await deadlines.stop();
                vi.useRealTimers();
                db.$transaction = transaction;
                db.machine.findUnique = findUnique;
                await observer.$disconnect();
            }
        });

        it.each(['metadata', 'state'] as const)('keeps %s publication Machine/grant graph SQL constant as the recipient audience grows and changes', async kind => {
            const fixture = await createMachineFixture();
            await db.machine.update({ where: { id: fixture.machineId }, data: { active: true, lastActiveAt: new Date() } });
            const people = [];
            // Seed outside measurement without opening one pool slot per person.
            for (let person = 0; person < 123; person++) {
                people.push(await db.account.create({ data: { encryptionMode: 'plain' } }));
            }
            const [direct, member, newcomer] = people;
            const team = await db.team.create({ data: { name: 'Machine publication recipients' } });
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: fixture.machineId, accountId: direct!.id,
                accessLevel: 'view', createdByAccountId: fixture.accountId } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: member!.id, role: 'member' } });
            await db.machineGrant.create({ data: { principalKind: 'team', machineId: fixture.machineId, teamId: team.id,
                accessLevel: 'view', createdByAccountId: fixture.accountId } });

            const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
            let selects = 0;
            let statements = 0;
            let graphReads = 0;
            let publicationStatements = 0;
            client.$on('query', (event: Prisma.QueryEvent) => {
                statements++;
                if (/INSERT INTO "(?:public"\.")?AccountChange"/.test(event.query)) publicationStatements++;
                if (!/^SELECT\b/i.test(event.query)) return;
                selects++;
                if (/FROM "(?:public"\.")?(?:Machine|MachineGrant|MachineGrant|Team|TeamMembership|TeamGroup|TeamGroupMembership)"(?:\s|$)/.test(event.query)) graphReads++;
            });
            await client.$connect();
            const transaction = db.$transaction;
            // Observe engine-emitted SQL at the genuine Prisma/PG transport.
            // Admission, readiness, publication and transaction ownership stay real.
            db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
                return Reflect.apply(client.$transaction, client, args);
            } });
            const changes = async () => new Map((await db.accountChange.findMany({
                where: { kind: 'machine', entityId: fixture.machineId }, select: { accountId: true, cursor: true },
            })).map(row => [row.accountId, row.cursor]));
            const publish = async (expectedVersion: number) => {
                selects = 0; statements = 0; graphReads = 0; publicationStatements = 0;
                const callback = vi.fn();
                const value = encodePlainMachineStoredContent(kind === 'metadata'
                    ? { ...PUBLISHED_METADATA, host: `publication-${expectedVersion}` } : { status: `state-${expectedVersion}` });
                await getSocketHandler(fixture.socket, `machine-update-${kind}`)({ machineId: fixture.machineId,
                    expectedVersion, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    ...(kind === 'metadata' ? { metadata: value } : { daemonState: value }),
                }, callback);
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: 'success', version: expectedVersion + 1 }));
                return { statements, selects, graphReads, publicationStatements };
            };
            try {
                const small = await publish(0);
                expect([...(await changes()).keys()].sort()).toEqual([fixture.accountId, direct!.id, member!.id].sort());
                const added = people.slice(3);
                await db.machineGrant.createMany({ data: added.slice(0, 60).map(person => ({ principalKind: 'account',
                    machineId: fixture.machineId, accountId: person.id, accessLevel: 'view', createdByAccountId: fixture.accountId,
                })) });
                await db.teamMembership.createMany({ data: added.slice(60).map(person => ({
                    teamId: team.id, accountId: person.id, role: 'member',
                })) });
                const large = await publish(1);
                const beforeChange = await changes();
                expect([...beforeChange.keys()].sort()).toEqual([fixture.accountId, direct!.id, member!.id, ...added.map(person => person.id)].sort());

                await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: fixture.machineId, accountId: direct!.id } } });
                await db.machineGrant.create({ data: { principalKind: 'account', machineId: fixture.machineId, accountId: newcomer!.id,
                    accessLevel: 'view', createdByAccountId: fixture.accountId } });
                const changed = await publish(2);
                const afterChange = await changes();
                expect(afterChange.get(direct!.id)).toBe(beforeChange.get(direct!.id));
                expect(afterChange.has(newcomer!.id)).toBe(true);
                for (const accountId of [fixture.accountId, member!.id, ...added.map(person => person.id)]) {
                    expect(afterChange.get(accountId)!).toBeGreaterThan(beforeChange.get(accountId)!);
                }
                console.info('MACHINE_PUBLICATION_ACCESS_SQL', JSON.stringify({ kind, smallRecipients: 3, largeRecipients: 123, small, large, changed }));
                expect.soft(large.graphReads).toBe(small.graphReads);
                expect.soft(changed.graphReads).toBe(small.graphReads);
                // Publication stays set-oriented while every current recipient
                // still gets its own durable cursor (asserted above).
                expect.soft(large.publicationStatements).toBe(small.publicationStatements);
            } finally {
                db.$transaction = transaction;
                await client.$disconnect();
            }
        });

        it.each(['equal', 'stale', 'changed'] as const)('bounds an 18-request concurrent %s daemon-state burst by real content changes', async kind => {
            const fixture = await createMachineFixture();
            const initial = await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } });
            const daemonState = kind === 'equal' ? initial.daemonState!
                : encodePlainMachineStoredContent({ status: 'running' });
            const callbacks = Array.from({ length: 18 }, () => vi.fn());
            const measured = await observeDaemonStateSql(async () => {
                await Promise.all(callbacks.map(callback => getSocketHandler(fixture.socket, 'machine-update-state')({
                    machineId: fixture.machineId, daemonState,
                    expectedVersion: kind === 'stale' ? initial.daemonStateVersion + 1 : initial.daemonStateVersion,
                    expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }, callback)));
            });
            const responses = callbacks.map(callback => {
                expect(callback).toHaveBeenCalledTimes(1);
                return MachineUpdateStateResponseSchema.parse(callback.mock.calls[0]?.[0]);
            });
            const changes = kind === 'changed' ? 1 : 0;
            console.info('MACHINE_DAEMON_STATE_CONVOY', JSON.stringify({ kind, requests: 18, ...measured }));
            expect.soft(measured.contentWrites).toBe(changes);
            expect.soft(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } }))
                .toEqual({ seq: changes });
            expect.soft(await db.accountChange.count({ where: { accountId: fixture.accountId, kind: 'machine', entityId: fixture.machineId } }))
                .toBe(changes);
            const stored = await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } });
            expect.soft(stored.daemonStateVersion).toBe(initial.daemonStateVersion + changes);
            expect.soft(stored.daemonState).toBe(changes ? daemonState : initial.daemonState);
            if (kind !== 'changed') {
                expect.soft(measured.admissionReads).toBe(callbacks.length);
                expect.soft(measured.contentReads).toBe(callbacks.length);
                expect.soft(measured.lockStatements).toBe(0);
                expect.soft(stored.updatedAt).toEqual(initial.updatedAt);
                expect.soft(responses.every(response => 'result' in response && response.result === (kind === 'stale' ? 'version-mismatch' : 'success'))).toBe(true);
            } else {
                expect(responses.filter(response => 'result' in response && response.result === 'success')).toHaveLength(1);
                expect(responses.filter(response => 'result' in response && response.result === 'version-mismatch')).toHaveLength(17);
            }
        });

        it.each(['equal', 'changed', 'legacy-lock-reference'] as const)(
            'measures exclusive Account writer admission behind 18 %s daemon-state requests and a held Machine row', async kind => {
            const fixture = await createMachineFixture();
            const initial = await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } });
            const requests = 18;
            let releaseMachine!: () => void;
            const machineHeld = new Promise<void>(resolve => { releaseMachine = resolve; });
            let announceMachineLock!: () => void;
            const machineLocked = new Promise<void>(resolve => { announceMachineLock = resolve; });
            let machineReleased = false;
            const root = inTx(async tx => {
                await tx.$queryRawUnsafe('SELECT "id" FROM "Machine" WHERE "id" = $1 FOR NO KEY UPDATE', fixture.machineId);
                announceMachineLock();
                await machineHeld;
            }, { isolationLevel: 'ReadCommitted', transactionClass: 'machine-convoy-test-root' });
            void root.catch(() => undefined);
            const transaction = db.$transaction;
            let pendingRequests: Promise<unknown[]> | undefined;
            let accountWriter: Promise<void> | undefined;
            let machineLockAttempts = 0;
            let requestsCompleted = 0;
            let accountWriterSettled = false;
            let accountWriterBlockedBeforeRelease = false;
            let accountWriterCompletedBeforeRelease = false;
            let accountLockMs = 0;
            let requestsCompletedBeforeRelease = 0;
            let machineLockAttemptsBeforeRelease = 0;
            const callbacks = Array.from({ length: requests }, () => vi.fn());
            let announceMachineWaiters!: () => void;
            const machineWaiters = new Promise<void>(resolve => { announceMachineWaiters = resolve; });
            try {
                await machineLocked;
                // Observe actual Prisma transport entry, after the canonical Account
                // admission has completed. No domain decision or SQL result is mocked.
                db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                    const run = args[0];
                    if (typeof run !== 'function') return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => run(new Proxy(tx, {
                        get(inner, property, innerReceiver) {
                            if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                            return async (query: string, ...values: unknown[]) => {
                                if (query.includes('FROM "Machine"') && query.includes('FOR NO KEY UPDATE')) {
                                    if (++machineLockAttempts === requests) announceMachineWaiters();
                                }
                                return inner.$queryRawUnsafe(query, ...values);
                            };
                        },
                    })), ...args.slice(1)]);
                } });
                pendingRequests = Promise.all(callbacks.map(async callback => {
                    if (kind === 'legacy-lock-reference') {
                        // Construct only the old admission/lock topology using its
                        // current canonical owner; this is not the old full handler.
                        await inTx(tx => acquireMachinePublicationLocksInTx(tx, fixture.machineId), {
                            isolationLevel: 'ReadCommitted', transactionClass: 'machine-convoy-test-lock-reference',
                        });
                    } else {
                        await getSocketHandler(fixture.socket, 'machine-update-state')({
                            machineId: fixture.machineId,
                            daemonState: kind === 'equal' ? initial.daemonState! : encodePlainMachineStoredContent({ status: 'running' }),
                            expectedVersion: initial.daemonStateVersion,
                            expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                        }, callback);
                    }
                    requestsCompleted++;
                }));
                void pendingRequests.catch(() => undefined);
                const first = await Promise.race([
                    pendingRequests.then(() => 'completed' as const),
                    machineWaiters.then(() => 'machine-waiters' as const),
                ]);
                expect(first).toBe(kind === 'equal' ? 'completed' : 'machine-waiters');

                let announceAccountWriter!: (pid: number) => void;
                const accountWriterStarted = new Promise<number>(resolve => { announceAccountWriter = resolve; });
                accountWriter = inTx(async tx => {
                    const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
                    announceAccountWriter(pid);
                    const started = performance.now();
                    await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', fixture.accountId);
                    accountLockMs = performance.now() - started;
                    accountWriterCompletedBeforeRelease = !machineReleased;
                }, { isolationLevel: 'ReadCommitted', transactionClass: 'machine-convoy-test-account-writer' })
                    .finally(() => { accountWriterSettled = true; });
                void accountWriter.catch(() => undefined);
                const accountWriterPid = await accountWriterStarted;
                if (kind === 'equal') {
                    await accountWriter;
                    expect(accountWriterCompletedBeforeRelease).toBe(true);
                    expect(machineLockAttempts).toBe(0);
                } else {
                    // Query the disposable PG lock graph until the submitted writer
                    // is actually waiting or has settled; no timing cutoff decides it.
                    while (!accountWriterSettled) {
                        const [{ blocked }] = await db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
                            'SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked', accountWriterPid,
                        );
                        if (blocked) { accountWriterBlockedBeforeRelease = true; break; }
                    }
                    expect(accountWriterBlockedBeforeRelease).toBe(true);
                    expect(requestsCompleted).toBe(0);
                }
                requestsCompletedBeforeRelease = requestsCompleted;
                machineLockAttemptsBeforeRelease = machineLockAttempts;
                machineReleased = true;
                releaseMachine();
                await Promise.all([root, pendingRequests, accountWriter]);
            } finally {
                machineReleased = true;
                releaseMachine();
                db.$transaction = transaction;
                await Promise.allSettled([root, ...(pendingRequests ? [pendingRequests] : []), ...(accountWriter ? [accountWriter] : [])]);
            }
            console.info('MACHINE_CONVOY_ACCOUNT_WRITER', JSON.stringify({
                kind, requests, requestsCompletedBeforeRelease, machineLockAttemptsBeforeRelease,
                accountWriterBlockedBeforeRelease, accountWriterCompletedBeforeRelease, accountLockMs,
            }));
            const changed = kind === 'changed' ? 1 : 0;
            expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } }))
                .toEqual({ seq: changed });
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId }, select: { daemonStateVersion: true } }))
                .toEqual({ daemonStateVersion: initial.daemonStateVersion + changed });
            if (kind !== 'legacy-lock-reference') {
                const responses = callbacks.map(callback => {
                    expect(callback).toHaveBeenCalledTimes(1);
                    return MachineUpdateStateResponseSchema.parse(callback.mock.calls[0]?.[0]);
                });
                expect(responses.filter(response => 'result' in response && response.result === 'success'))
                    .toHaveLength(kind === 'equal' ? requests : 1);
                if (kind === 'changed') expect(responses.filter(response => 'result' in response && response.result === 'version-mismatch'))
                    .toHaveLength(requests - 1);
            }
        });

        it('publishes 18 genuinely changed concurrent daemon states with one publication statement per committed version', async () => {
            const fixture = await createMachineFixture();
            const viewers = await Promise.all(Array.from({ length: 17 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
            await db.machineGrant.createMany({ data: viewers.map(viewer => ({ principalKind: 'account',
                machineId: fixture.machineId, accountId: viewer.id, accessLevel: 'view', createdByAccountId: fixture.accountId,
            })) });
            const versions: number[] = [];
            let attempts = 0;
            const measured = await observeDaemonStateSql(async () => {
                await Promise.all(Array.from({ length: 18 }, async (_, index) => {
                    const daemonState = encodePlainMachineStoredContent({ status: `concurrent-change-${index}` });
                    let expectedVersion = 0;
                    // A real client rebases on the server's CAS response; the
                    // distinct desired states require 18 actual content commits.
                    for (;;) {
                        attempts++;
                        const callback = vi.fn();
                        await getSocketHandler(fixture.socket, 'machine-update-state')({
                            machineId: fixture.machineId, daemonState, expectedVersion,
                            expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                        }, callback);
                        expect(callback).toHaveBeenCalledTimes(1);
                        const response = MachineUpdateStateResponseSchema.parse(callback.mock.calls[0]?.[0]);
                        if ('result' in response && response.result === 'success') { versions.push(response.version); return; }
                        if ('result' in response && response.result === 'version-mismatch') { expectedVersion = response.version; continue; }
                        throw new Error('Concurrent daemon-state change did not settle through its CAS contract');
                    }
                }));
            });
            console.info('MACHINE_DAEMON_STATE_DISTINCT_CONVOY', JSON.stringify({ requests: 18, recipients: 18, attempts, ...measured }));
            expect(versions.sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
            expect(measured.contentWrites).toBe(18);
            expect(measured.publications).toBe(18);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId }, select: { daemonStateVersion: true } }))
                .toEqual({ daemonStateVersion: 18 });
            expect(await db.accountChange.count({ where: { kind: 'machine', entityId: fixture.machineId, cursor: 18 } })).toBe(18);
        });

        it.each(['revoked', 'reinstalled'] as const)('admits an equal daemon-state request once and observes %s authority on the next request', async kind => {
            const fixture = await createMachineFixture();
            const initial = await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } });
            const request = {
                machineId: fixture.machineId, daemonState: initial.daemonState!,
                expectedVersion: initial.daemonStateVersion,
                expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            };
            const callback = vi.fn();
            const admitted = await observeDaemonStateSql(async () => {
                await getSocketHandler(fixture.socket, 'machine-update-state')(request, callback);
            });
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith({ result: 'success', version: initial.daemonStateVersion,
                daemonState: initial.daemonState });
            expect.soft(admitted.admissionReads).toBe(1);
            expect.soft(admitted.contentReads).toBe(1);
            expect.soft(admitted.machineAcquisitions).toBe(2);

            await db.machine.update({ where: { id: fixture.machineId }, data: kind === 'revoked'
                ? { revokedAt: new Date() } : { installationId: randomUUID() } });
            const nextCallback = vi.fn();
            const refused = await observeDaemonStateSql(async () => {
                await getSocketHandler(fixture.socket, 'machine-update-state')(request, nextCallback);
            });
            expect(nextCallback).toHaveBeenCalledTimes(1);
            expect(nextCallback).toHaveBeenCalledWith(expect.objectContaining({ result: 'error' }));
            expect(refused.admissionReads).toBe(1);
            expect(refused.contentReads).toBe(0);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId }, select: { daemonStateVersion: true } }))
                .toEqual({ daemonStateVersion: initial.daemonStateVersion });
            expect(await db.accountChange.count({ where: { accountId: fixture.accountId } })).toBe(0);
            console.info('MACHINE_DAEMON_STATE_SINGLE_ADMISSION', JSON.stringify({ kind, admitted, refused }));
        });

        it('expires only the exact current observation without changing UTC last-seen or content clocks in a non-UTC session', async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
            const lastActiveAt = new Date('2026-10-25T00:59:59.123Z');
            const contentAt = new Date('2025-01-01T00:00:00.456Z');
            const [current, stale, revoked, replaced, wrongAccount] = await Promise.all(
                Array.from({ length: 5 }, () => db.machine.create({ data: {
                    id: randomUUID(), accountId: owner.id, active: true, lastActiveAt, updatedAt: contentAt, metadata: 'presence-content',
                } })),
            );
            await db.machine.update({ where: { id: revoked!.id }, data: { revokedAt: new Date(), updatedAt: contentAt } });
            await db.machine.update({ where: { id: replaced!.id }, data: { replacedByMachineId: current!.id, updatedAt: contentAt } });
            await withNonUtcPresenceTx(async tx => {
                expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: current!.id, lastActiveAt })).toBe(1);
                expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: current!.id, lastActiveAt })).toBe(0);
                expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: stale!.id,
                    lastActiveAt: new Date(lastActiveAt.getTime() - 1) })).toBe(0);
                for (const machine of [revoked!, replaced!]) {
                    expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: machine.id, lastActiveAt })).toBe(0);
                }
                expect(await markMachinePresenceInactive(tx, { accountId: stranger.id, machineId: wrongAccount!.id, lastActiveAt })).toBe(0);
            });
            const rows = await db.machine.findMany({ where: { accountId: owner.id },
                select: { id: true, active: true, lastActiveAt: true, updatedAt: true, metadata: true } });
            expect(rows).toHaveLength(5);
            for (const row of rows) expect(row).toEqual({ id: row.id, active: row.id !== current!.id,
                lastActiveAt, updatedAt: contentAt, metadata: 'presence-content' });
            expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual({ seq: 0 });
            expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(0);
        });

        it('allows exactly one concurrent inactive CAS winner in non-UTC sessions', async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const lastActiveAt = new Date('2026-10-25T01:00:00.789Z');
            const contentAt = new Date('2025-01-01T00:00:00.456Z');
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: owner.id, active: true, lastActiveAt, updatedAt: contentAt, metadata: 'presence-content',
            } });
            let release!: () => void;
            const ready = new Promise<void>(resolve => { release = resolve; });
            let entrants = 0;
            const results = await Promise.all(Array.from({ length: 2 }, () => withNonUtcPresenceTx(async tx => {
                if (++entrants === 2) release();
                await ready;
                return markMachinePresenceInactive(tx, { accountId: owner.id, machineId: machine.id, lastActiveAt });
            })));
            expect(results.sort()).toEqual([0, 1]);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: false, lastActiveAt, updatedAt: contentAt });
        });

        it('waits for an admitted renewal row lock before rejecting an old deadline observation', async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const scannedAt = new Date(Date.now() - 60_000);
            const renewedAt = new Date(scannedAt.getTime() + 59_999);
            const contentAt = new Date('2025-01-01T00:00:00.456Z');
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: owner.id, active: true, lastActiveAt: scannedAt, updatedAt: contentAt, metadata: 'presence-content',
            } });
            let pending: Promise<number> | undefined;
            await withNonUtcPresenceTx(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${machine.id} FOR UPDATE`;
                expect(await persistMachinePresence(tx, { accountId: owner.id, machineId: machine.id, timestamp: renewedAt.getTime() })).toBe(1);
                let settled = false;
                pending = withNonUtcPresenceTx(async peer => {
                    const observed = await lockMachinePresenceInTx(peer, machine.id);
                    expect(observed?.lastActiveAt).toEqual(renewedAt);
                    expect(await persistMachinePresence(peer, { accountId: owner.id, machineId: machine.id,
                        timestamp: scannedAt.getTime() })).toBe(0);
                    return markMachinePresenceInactive(peer, { accountId: owner.id, machineId: machine.id, lastActiveAt: scannedAt });
                }).finally(() => { settled = true; });
                void pending.catch(() => undefined);
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) break;
                }
                expect(settled).toBe(false);
            });
            expect(await pending).toBe(0);
            expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                select: { active: true, lastActiveAt: true, updatedAt: true } }))
                .toEqual({ active: true, lastActiveAt: renewedAt, updatedAt: contentAt });
        });

        it('keeps 137 Machines renewing for 300 seconds out of content clocks and Account changes', async () => {
            const fixture = await createMachineFixture();
            const machineIds = [fixture.machineId, ...Array.from({ length: 136 }, () => randomUUID())];
            await db.machine.createMany({ data: machineIds.slice(1).map(id => ({
                id, accountId: fixture.accountId, metadata: encodePlainMachineStoredContent(PUBLISHED_METADATA),
            })) });
            const contentAt = new Date('2025-01-01T00:00:00.000Z');
            const base = Date.now() - 300_000;
            await db.machine.updateMany({ where: { accountId: fixture.accountId }, data: {
                active: true, lastActiveAt: new Date(base), updatedAt: contentAt,
            } });
            const before = await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } });
            const changesBefore = await db.accountChange.count({ where: { accountId: fixture.accountId } });
            for (let elapsed = 20_000; elapsed <= 300_000; elapsed += 20_000) {
                await inTx(async tx => {
                    // Production may use a non-UTC database session; Prisma DateTime remains UTC.
                    await tx.$executeRaw`SET LOCAL TIME ZONE 'Europe/Amsterdam'`;
                    for (const machineId of machineIds) await persistMachinePresence(tx, {
                        accountId: fixture.accountId, machineId, timestamp: base + elapsed,
                    });
                }, { transactionClass: 'presence-clock-contract' });
            }
            expect(await db.machine.count({ where: { accountId: fixture.accountId, updatedAt: { not: contentAt } } })).toBe(0);
            expect(await db.machine.count({ where: { accountId: fixture.accountId, active: true, lastActiveAt: new Date(base + 300_000) } })).toBe(137);
            expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } })).toEqual(before);
            expect(await db.accountChange.count({ where: { accountId: fixture.accountId } })).toBe(changesBefore);

            let pending: Promise<number> | undefined;
            const semantic = await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                const changed = await peer.machine.update({ where: { id: fixture.machineId }, data: { metadata: 'concurrent-content' } });
                let settled = false;
                pending = persistMachinePresence(db, { accountId: fixture.accountId, machineId: fixture.machineId, timestamp: base + 320_000 })
                    .finally(() => { settled = true; });
                void pending.catch(() => undefined);
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) break;
                }
                expect(settled).toBe(false);
                return changed;
            });
            await pending;
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId }, select: { metadata: true, updatedAt: true, lastActiveAt: true } }))
                .toEqual({ metadata: semantic.metadata, updatedAt: semantic.updatedAt, lastActiveAt: new Date(base + 320_000) });
        });

        it.each(["equal", "changed"] as const)("ACKs both concurrent %s capability publications from one revision", async kind => {
            const fixture = await createMachineFixture();
            const handler = getSocketHandler(fixture.socket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1);
            const capabilities = { sessionSpawn: { protocolVersions: [1] } };
            const nextCapabilities = kind === "equal" ? capabilities : { sessionSpawn: { protocolVersions: [1, 2] } };
            const callbacks = [vi.fn(), vi.fn()];
            const pending: Promise<unknown>[] = [];
            // Both real handlers read revision null before reaching this held
            // resource row. The second publisher must read again under its lock.
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await peer.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${fixture.machineId} FOR NO KEY UPDATE`;
                for (const [index, projection] of [capabilities, nextCapabilities].entries()) {
                    pending.push(Promise.resolve(handler({ machineId: fixture.machineId, capabilities: projection }, callbacks[index])));
                }
                while (true) {
                    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
                        WITH RECURSIVE blocked AS (
                            SELECT pid FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
                            UNION
                            SELECT activity.pid FROM pg_stat_activity activity
                            JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
                            WHERE activity.datname = current_database()
                        ) SELECT count(*)::int AS waiting FROM blocked
                    `;
                    if (waiting === 2) break;
                    if (callbacks.some(callback => callback.mock.calls.length > 0)) {
                        throw new Error("Capability publication settled before reaching the held Machine row");
                    }
                }
            });
            await Promise.all(pending);
            const responses = callbacks.map(callback => {
                expect(callback).toHaveBeenCalledTimes(1);
                return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(callback.mock.calls[0]?.[0]);
            });
            expect(responses.every(response => response.result === "success")).toBe(true);
            expect(responses.map(response => response.result === "success" ? response.revision : null).sort())
                .toEqual(kind === "equal" ? [1, 1] : [1, 2]);
            const stored = await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                select: { operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true } });
            expect(stored.operationProtocolCapabilitiesRevision).toBe(kind === "equal" ? 1 : 2);
            expect([capabilities, nextCapabilities]).toContainEqual(stored.operationProtocolCapabilities);
            expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } }))
                .toEqual({ seq: kind === "equal" ? 1 : 2 });
        });

        it("ACKs a database failure once and can publish after the database recovers", async () => {
            const fixture = await createMachineFixture();
            const handler = getSocketHandler(fixture.socket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1);
            const constraint = `capability_failure_${fixture.machineId.replaceAll("-", "")}`;
            // A genuine database rejection after admission, scoped to this row
            // in the disposable harness. No internal service is mocked.
            await db.$executeRawUnsafe(`ALTER TABLE "Machine" ADD CONSTRAINT "${constraint}"
                CHECK ("id" <> '${fixture.machineId}' OR "operationProtocolCapabilitiesRevision" IS NULL)`);
            const request = { machineId: fixture.machineId, capabilities: { sessionSpawn: { protocolVersions: [1] } } };
            const failed = vi.fn();
            try {
                await handler(request, failed);
                expect(failed).toHaveBeenCalledTimes(1);
                expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(failed.mock.calls[0]?.[0]))
                    .toEqual({ v: 1, result: "error", code: "internal_error" });
                expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId },
                    select: { operationProtocolCapabilitiesRevision: true } }))
                    .toEqual({ operationProtocolCapabilitiesRevision: null });
                expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } }))
                    .toEqual({ seq: 0 });
            } finally {
                await db.$executeRawUnsafe(`ALTER TABLE "Machine" DROP CONSTRAINT "${constraint}"`);
            }
            const recovered = vi.fn();
            await handler(request, recovered);
            expect(recovered).toHaveBeenCalledTimes(1);
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(recovered.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "success", revision: 1 });
        });

        it("commits operation capabilities while another writer publishes the Account", async () => {
            const fixture = await publishUnderContention(
                MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
                (current: Awaited<ReturnType<typeof createMachineFixture>>) => ({
                    machineId: current.machineId,
                    capabilities: { sessionSpawn: { protocolVersions: [1] } },
                }),
            );
            expect(fixture.callback).toHaveBeenCalledWith({ v: 1, result: "success", revision: 1 });
            expect(fixture.advanced).toBe(true);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ operationProtocolCapabilitiesRevision: 1 });
        });

        it.each(["equal", "changed"] as const)("a %s capabilities refresh joins Account publication only when it changes storage", async kind => {
            const fixture = await createMachineFixture();
            const capabilities = { sessionSpawn: { protocolVersions: [1] } };
            const handler = getSocketHandler(fixture.socket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1);
            const initial = vi.fn();
            await handler({ machineId: fixture.machineId, capabilities }, initial);
            expect(initial).toHaveBeenCalledWith({ v: 1, result: "success", revision: 1 });
            const before = await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } });
            const callback = vi.fn();
            const nextCapabilities = kind === "equal" ? capabilities : { sessionSpawn: { protocolVersions: [1, 2] } };
            let pending: Promise<unknown> | undefined;
            let blocked = false;
            let waits: Array<{ wait_event_type: string | null; wait_event: string | null; account_statement: boolean }> = [];
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await peer.account.update({ where: { id: fixture.accountId }, data: { seq: { increment: 1 } } });
                let settled = false;
                pending = Promise.resolve(handler({ machineId: fixture.machineId, capabilities: nextCapabilities }, callback))
                    .finally(() => { settled = true; });
                void pending.catch(() => undefined);
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) {
                        blocked = true;
                        waits = await db.$queryRaw`SELECT wait_event_type, wait_event, query LIKE '%Account%' AS account_statement
                            FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
                        break;
                    }
                }
            });
            await pending;
            console.info("FIX99 Machine publication wait", { kind, blocked, waits });
            if (kind === "changed") {
                console.info("FIX99 Account publication plan", JSON.stringify(await db.$queryRawUnsafe(
                    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
                    [fixture.accountId],
                )));
            }
            expect(blocked, "Only a changed projection needs the Account publication row").toBe(kind === "changed");
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(callback.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "success", revision: kind === "equal" ? 1 : 2 });
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ operationProtocolCapabilities: nextCapabilities,
                    operationProtocolCapabilitiesRevision: kind === "equal" ? 1 : 2 });
            expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } }))
                .toEqual({ seq: before.seq + (kind === "equal" ? 1 : 2) });
            await db.machine.update({ where: { id: fixture.machineId }, data: { revokedAt: new Date() } });
            const revoked = vi.fn();
            await handler({ machineId: fixture.machineId, capabilities: nextCapabilities }, revoked);
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(revoked.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "error", code: "machine_unavailable" });
        });

        it.each(["revoked", "reinstalled"] as const)("readmits an equal capabilities refresh after its Machine is %s", async kind => {
            const fixture = await createMachineFixture();
            const capabilities = { sessionSpawn: { protocolVersions: [1] } };
            const handler = getSocketHandler(fixture.socket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1);
            await handler({ machineId: fixture.machineId, capabilities }, vi.fn());
            const transaction = db.$transaction;
            let changed = false;
            // Advance genuine durable authority after the first database
            // snapshot closes. Neither admission nor the socket handler is mocked.
            db.$transaction = new Proxy(transaction, { async apply(target, receiver, args: unknown[]) {
                const result: unknown = await Reflect.apply(target, receiver, args);
                const transactionResult = result && typeof result === "object" && "result" in result ? result.result : null;
                const captured = transactionResult && typeof transactionResult === "object" && "value" in transactionResult
                    ? transactionResult.value : null;
                if (!changed && captured && typeof captured === "object" && "kind" in captured && captured.kind === "unchanged") {
                    changed = true;
                    await db.machine.update({ where: { id: fixture.machineId }, data: kind === "revoked"
                        ? { revokedAt: new Date() } : { installationId: randomUUID() } });
                }
                return result;
            } });
            const callback = vi.fn();
            try { await handler({ machineId: fixture.machineId, capabilities }, callback); }
            finally { db.$transaction = transaction; }
            expect(changed).toBe(true);
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(callback.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "error", code: "machine_unavailable" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ operationProtocolCapabilitiesRevision: 1 });
        });

        it("commits metadata while another writer publishes the Account", async () => {
            const metadata = encodePlainMachineStoredContent({ ...PUBLISHED_METADATA, host: "publication-host-after" });
            const fixture = await publishUnderContention(
                "machine-update-metadata",
                (current: Awaited<ReturnType<typeof createMachineFixture>>) => ({
                    machineId: current.machineId,
                    metadata,
                    expectedVersion: 0,
                    expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }),
            );
            expect(fixture.callback).toHaveBeenCalledWith({ result: "success", version: 1, metadata });
            expect(fixture.advanced).toBe(true);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ metadata, metadataVersion: 1 });
        });

        it("commits daemon state while another writer publishes the Account", async () => {
            const daemonState = encodePlainMachineStoredContent({ status: "running" });
            const fixture = await publishUnderContention(
                "machine-update-state",
                (current: Awaited<ReturnType<typeof createMachineFixture>>) => ({
                    machineId: current.machineId,
                    daemonState,
                    expectedVersion: 0,
                    expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }),
            );
            expect(fixture.callback).toHaveBeenCalledWith({ result: "success", version: 1, daemonState });
            expect(MachineUpdateStateResponseSchema.parse(fixture.callback.mock.calls[0]?.[0]))
                .toEqual({ result: "success", version: 1, daemonState });
            expect(fixture.advanced).toBe(true);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ daemonState, daemonStateVersion: 1 });
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const read = await app.inject({ method: "GET", url: `/v1/machines/${fixture.machineId}`,
                    headers: { "x-test-user-id": fixture.accountId, ...currentAccountStoredContentCompatibilityHeaders } });
                expect(read.statusCode).toBe(200);
                expect(MachinePublishedRowV1Schema.parse(read.json().machine))
                    .toMatchObject({ daemonState, daemonStateVersion: 1 });
            });

            const other = await createMachineFixture();
            const before = await db.machine.findUniqueOrThrow({ where: { id: other.machineId } });
            const crossedMachine = vi.fn();
            await getSocketHandler(fixture.socket, "machine-update-state")({
                machineId: other.machineId, daemonState, expectedVersion: 0,
                expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            }, crossedMachine);
            expect(MachineUpdateStateResponseSchema.parse(crossedMachine.mock.calls[0]?.[0]))
                .toMatchObject({ result: "error" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: other.machineId } })).toEqual(before);
        });
    },
);
