import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { PrismaClient, type Prisma } from '@prisma/client';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import type { ClientConnection } from '@/app/events/eventPayloadTypes';
import { eventRouter } from '@/app/events/eventRouter';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { initializeExternalLinkedSessionStorage } from '@/app/session/externalLinkedSessionStorageInitialization';
import { createSessionHumanPresenceService, notifySessionHumanPresenceAccessChanged } from '@/app/session/humanPresence/sessionHumanPresenceService';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { retireSessionConsumptionAfterAccessChange } from './sessionConsumption';
import { resolveSessionScopedSocketBinding } from './sessionScopedBinding';
import { sessionUpdateHandler } from './sessionUpdateHandler';

const events = ['transcript-stream-segment-delta', 'transcript-stream-segment', 'execution-run-updated'] as const;
type PublicationEvent = typeof events[number];

const transport = vi.hoisted(() => ({ read: undefined as ((property: string | symbol) => unknown) | undefined }));
vi.mock('@/storage/db', async importOriginal => {
    const actual = await importOriginal<typeof import('@/storage/db')>();
    // Genuine persistence boundary: every operation still reaches real Prisma/Postgres.
    return { ...actual, db: new Proxy(actual.db, { get(target, property) {
        return transport.read ? transport.read(property) : Reflect.get(target, property);
    } }) };
});

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Current Session publication admission (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    const operations: string[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    let barrier: (() => void) | undefined;
    let presence: ReturnType<typeof createSessionHumanPresenceService>;
    const liveSockets = new Set<Socket>();
    const emit = vi.spyOn(eventRouter, 'emitEphemeral').mockImplementation(() => {});
    const evict = vi.spyOn(eventRouter, 'disconnectMachineAndSessionSockets').mockImplementation(() => {});

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_SHARING_SESSION__ENABLED', '1');
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => {
            if (event.query.includes('streamadmit_barrier')) barrier?.();
            else statements.push(event);
        });
        await client.$connect();
        // The real committed access-change seam, wired as `startSocket` wires it,
        // over a transport that holds only this spec's publisher sockets.
        const room = { fetchSockets: async () => [], emit: () => {} };
        presence = createSessionHumanPresenceService({
            io: { sockets: { sockets: new Map() }, in: () => room, to: () => room } as unknown as Server,
            onSessionAccessChanged: sessionId => retireSessionConsumptionAfterAccessChange(liveSockets, sessionId),
        });
        const traced = client.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
            operations.push(`${model}.${operation}`);
            return query(args);
        } } } });
        // Replace only the real Prisma transport with its query-observing twin.
        // All admission, membership, publication and registered-handler logic stays real.
        transport.read = property => {
            const value: unknown = Reflect.get(traced, property);
            return typeof value === 'function' ? value.bind(traced) : value;
        };
    });
    afterEach(() => { emit.mockClear(); evict.mockClear(); liveSockets.clear(); });
    afterAll(async () => {
        transport.read = undefined;
        presence?.close();
        emit.mockRestore();
        evict.mockRestore();
        vi.unstubAllEnvs();
        await client?.$disconnect();
        await shutdownDbClient();
    });

    async function fixture() {
        const [owner, direct, member, groupMember, newcomer] = await Promise.all(Array.from({ length: 5 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner!.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'stream-admission',
                platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/stream', happyHomeDir: '/home/stream/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const session = await db.session.create({ data: { accountId: owner!.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: owner!.id, machineId: machine.id, sessionId: session.id, data: 'opaque-key' } });
        const share = await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner!.id,
            sharedWithUserId: direct!.id, accessLevel: 'view' } });
        const team = await db.team.create({ data: { name: 'Stream admission team' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Stream admission group', nameKey: randomUUID() } });
        await db.teamMembership.create({ data: { accountId: member!.id, teamId: team.id, role: 'member' } });
        const guest = await db.teamMembership.create({ data: { accountId: groupMember!.id, teamId: team.id, role: 'guest' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: guest.id, nativeContribution: true } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: 'view',
            effectiveAt: new Date() } });
        await db.sessionGroupGrant.create({ data: { sessionId: session.id, teamGroupId: group.id, accessLevel: 'view',
            effectiveAt: new Date() } });
        const socket = createAuthenticatedFakeSocket({ data: { sessionScopedBinding: {
            sessionId: session.id, machineId: machine.id, proof: 'machine-access-key',
        } } });
        const connection: ClientConnection = { connectionType: 'session-scoped', userId: owner!.id,
            sessionId: session.id, socket: socket as unknown as Socket };
        liveSockets.add(socket as unknown as Socket);
        sessionUpdateHandler(owner!.id, socket as unknown as Socket, connection);
        return { owner: owner!, direct: direct!, member: member!, groupMember: groupMember!, newcomer: newcomer!,
            machine, session, share, team, group, socket, connection };
    }

    async function drain() {
        const observed = new Promise<void>(resolve => { barrier = resolve; });
        try { await Promise.all([client.$queryRaw`SELECT 1 AS "streamadmit_barrier"`, observed]); }
        finally { barrier = undefined; }
    }
    async function publish(f: Awaited<ReturnType<typeof fixture>>, event: PublicationEvent, sid = f.session.id, message: Readonly<{ tick?: number }> = {}) {
        await drain();
        statements.length = 0;
        operations.length = 0;
        emit.mockClear();
        await getSocketHandler(f.socket, event)({ sid,
            message: { localId: 'segment', messageRole: 'agent', tick: 2, baseLength: 1,
                content: { t: 'encrypted', c: 'delta' }, createdAt: 1, updatedAt: 2, ...message },
            run: { runId: 'run', callId: 'call', sidechainId: 'side', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                ioMode: 'request_response', retentionPolicy: 'ephemeral', runClass: 'bounded', permissionMode: 'default',
                status: 'running', startedAtMs: 1 },
        });
        await drain();
        const selects = statements.filter(({ query }) => /^SELECT\b/.test(query.trimStart()));
        const reads = (table: string) => selects.filter(({ query }) => new RegExp(`FROM\\s+"(?:public"\\.")?${table}"(?:\\s|$)`).test(query)).length;
        const counts = { event, operations: operations.length, statements: statements.length, selects: selects.length,
            session: reads('Session'), machine: reads('Machine'), accessKey: reads('AccessKey'),
            shares: reads('SessionShare'), teamGrants: reads('SessionTeamGrant'), groupGrants: reads('SessionGroupGrant') };
        console.info('STREAMADMIT_SQL', JSON.stringify(counts));
        return { recipients: emit.mock.calls.map(([input]) => input.userId).sort(), counts };
    }
    const allRecipients = (f: Awaited<ReturnType<typeof fixture>>) => [f.owner.id, f.direct.id, f.member.id, f.groupMember.id].sort();
    /** A committed fact change followed by the owner's push; the push is what the publisher consumes. */
    async function change(f: Awaited<ReturnType<typeof fixture>>, write: () => Promise<unknown>) {
        await write();
        notifySessionHumanPresenceAccessChanged({ sessionId: f.session.id });
    }
    async function privateSession(f: Awaited<ReturnType<typeof fixture>>) {
        await db.sessionShare.deleteMany({ where: { sessionId: f.session.id } });
        await db.sessionTeamGrant.deleteMany({ where: { sessionId: f.session.id } });
        await db.sessionGroupGrant.deleteMany({ where: { sessionId: f.session.id } });
    }

    it.each(events)('reads the audience once per change, never per %s, and fans out to every current recipient', async event => {
        const f = await fixture();
        const first = await publish(f, event);
        expect(first.recipients).toEqual(allRecipients(f));
        expect(first.counts).toMatchObject({ session: 1, machine: 0, accessKey: 0, shares: 1, teamGrants: 1, groupGrants: 1 });
        for (let chunk = 0; chunk < 3; chunk += 1) {
            const later = await publish(f, event);
            expect(later.recipients).toEqual(allRecipients(f));
            expect(later.counts).toMatchObject({ operations: 0, statements: 0 });
        }
    });

    it.each(events)('reads nothing after the first %s of an unshared Session', async event => {
        const f = await fixture();
        await privateSession(f);
        expect((await publish(f, event)).recipients).toEqual([f.owner.id]);
        for (let chunk = 0; chunk < 3; chunk += 1) {
            const later = await publish(f, event);
            expect(later.recipients).toEqual([f.owner.id]);
            expect(later.counts).toMatchObject({ operations: 0, statements: 0 });
        }
    });

    it.each(events)('observes new and revoked direct, Team and Group grants once per change on the next %s', async event => {
        const f = await fixture();
        expect((await publish(f, event)).recipients).toEqual(allRecipients(f));
        const expectNext = async (expected: readonly string[]) => {
            const next = await publish(f, event);
            expect(next.recipients).toEqual([...expected].sort());
            expect(next.counts.session).toBe(1);
            expect((await publish(f, event)).counts).toMatchObject({ operations: 0, statements: 0 });
        };
        await change(f, () => db.sessionShare.create({ data: { sessionId: f.session.id, sharedByUserId: f.owner.id,
            sharedWithUserId: f.newcomer.id, accessLevel: 'view' } }));
        await expectNext([...allRecipients(f), f.newcomer.id]);
        await change(f, () => db.sessionShare.delete({ where: { id: f.share.id } }));
        await expectNext([f.owner.id, f.member.id, f.groupMember.id, f.newcomer.id]);
        await change(f, () => db.sessionTeamGrant.deleteMany({ where: { sessionId: f.session.id } }));
        await expectNext([f.owner.id, f.groupMember.id, f.newcomer.id]);
        await change(f, () => db.sessionGroupGrant.deleteMany({ where: { sessionId: f.session.id } }));
        await expectNext([f.owner.id, f.newcomer.id]);
    });

    it('rereads the audience at each new segment, so a lost push costs at most the rest of that segment', async () => {
        const f = await fixture();
        const [delta, segment] = [events[0], events[1]];
        const withoutDirect = [f.owner.id, f.member.id, f.groupMember.id].sort();
        expect((await publish(f, segment, f.session.id, { tick: 1 })).recipients).toEqual(allRecipients(f));
        // Committed with no push, as when a Redis subscriber misses the publish.
        await db.sessionShare.delete({ where: { id: f.share.id } });
        for (const event of [delta, segment]) {
            const held = await publish(f, event);
            expect(held.recipients).toEqual(allRecipients(f));
            expect(held.counts).toMatchObject({ operations: 0, statements: 0 });
        }
        const next = await publish(f, segment, f.session.id, { tick: 1 });
        expect(next.recipients).toEqual(withoutDirect);
        expect(next.counts).toMatchObject({ session: 1, shares: 1 });
        expect((await publish(f, delta)).counts).toMatchObject({ operations: 0, statements: 0 });
    });

    it('rereads on every checkpoint from a publisher that sends no tick', async () => {
        const f = await fixture();
        const legacy = { tick: undefined };
        expect((await publish(f, events[1], f.session.id, legacy)).recipients).toEqual(allRecipients(f));
        await db.sessionShare.delete({ where: { id: f.share.id } });
        const next = await publish(f, events[1], f.session.id, legacy);
        expect(next.recipients).toEqual([f.owner.id, f.member.id, f.groupMember.id].sort());
        expect(next.counts.session).toBe(1);
    });

    it('keeps a tick-1 delta on the held audience: only a segment snapshot opens a segment', async () => {
        const f = await fixture();
        await publish(f, events[0]);
        expect((await publish(f, events[0], f.session.id, { tick: 1 })).counts).toMatchObject({ operations: 0, statements: 0 });
    });

    it('holds an audience only for its own Session', async () => {
        const f = await fixture();
        expect((await publish(f, events[0])).recipients).toEqual(allRecipients(f));
        await change({ ...f, session: { ...f.session, id: randomUUID() } }, () => db.sessionShare.delete({ where: { id: f.share.id } }));
        expect((await publish(f, events[0])).counts).toMatchObject({ operations: 0, statements: 0 });
    });

    it('retires an audience read the push overtakes, so the next event reads the committed change', async () => {
        const f = await fixture();
        const healthy = transport.read!;
        let release: () => void = () => {};
        let readFinished: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const finished = new Promise<void>(resolve => { readFinished = resolve; });
        // The snapshot closes on real Postgres before the change commits, and its
        // caller sees it only after the push: the one ordering a late store would keep.
        transport.read = property => {
            const value = healthy(property);
            if (property !== '$transaction' || typeof value !== 'function') return value;
            return async (...args: unknown[]) => {
                const result: unknown = await value(...args);
                readFinished();
                await gate;
                return result;
            };
        };
        const first = getSocketHandler(f.socket, events[0])({ sid: f.session.id, message: { localId: 'segment', messageRole: 'agent',
            tick: 2, baseLength: 1, content: { t: 'encrypted', c: 'delta' }, createdAt: 1, updatedAt: 2 } });
        await finished;
        transport.read = healthy;
        await change(f, () => db.sessionShare.delete({ where: { id: f.share.id } }));
        release();
        await first;
        expect((await publish(f, events[0])).recipients).toEqual([f.owner.id, f.member.id, f.groupMember.id].sort());
    });

    it('does not hold a failed read, and delivers nothing until the audience is readable', async () => {
        const f = await fixture();
        const healthy = transport.read;
        transport.read = () => { throw new Error('storage unavailable'); };
        await getSocketHandler(f.socket, events[0])({ sid: f.session.id, message: { localId: 'segment', messageRole: 'agent', tick: 2,
            baseLength: 1, content: { t: 'encrypted', c: 'delta' }, createdAt: 1, updatedAt: 2 } }).catch(() => {});
        transport.read = healthy;
        expect(emit).not.toHaveBeenCalled();
        expect((await publish(f, events[0])).recipients).toEqual(allRecipients(f));
    });

    it.each(events)('refuses foreign targets and unbound sockets, and follows lifecycle and publication on the next %s', async event => {
        const f = await fixture();
        expect((await publish(f, event)).recipients).toEqual(allRecipients(f));
        expect((await publish(f, event, randomUUID())).recipients).toEqual([]);
        f.socket.data!.sessionScopedBinding = { sessionId: f.session.id, machineId: null, proof: 'owner-session' };
        expect((await publish(f, event)).recipients).toEqual([]);
        f.socket.data!.sessionScopedBinding = { sessionId: f.session.id, machineId: f.machine.id, proof: 'machine-access-key' };
        await change(f, () => db.session.update({ where: { id: f.session.id }, data: { currentStorageState: 'external', publishedThroughServerSeq: 0 } }));
        expect((await publish(f, event)).recipients).toEqual([f.owner.id]);
        await change(f, () => db.session.update({ where: { id: f.session.id }, data: { currentStorageState: 'hosted', archivedAt: new Date() } }));
        // Session archival is not access withdrawal (ORCH/Systemic ruling,
        // 2026-10-27). The archive transition remains visible to its audience.
        expect((await publish(f, event)).recipients).toEqual(allRecipients(f));
        await change(f, () => db.account.update({ where: { id: f.direct.id }, data: { status: 'disabled' } }));
        expect((await publish(f, event)).recipients).toEqual([f.owner.id, f.member.id, f.groupMember.id].sort());
        await change(f, async () => {
            await db.accessKey.deleteMany({ where: { sessionId: f.session.id } });
            await db.session.delete({ where: { id: f.session.id } });
        });
        expect((await publish(f, event)).recipients).toEqual([]);
    });

    it.each(events)('withdraws archived Team and Group recipients on the next %s and restores them on reactivation', async event => {
        const f = await fixture();
        expect((await publish(f, event)).recipients).toEqual(allRecipients(f));
        await change(f, () => db.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: new Date() } }));
        expect((await publish(f, event)).recipients).toEqual([f.owner.id, f.direct.id, f.member.id].sort());
        await change(f, () => db.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: null } }));
        expect((await publish(f, event)).recipients).toEqual(allRecipients(f));
        await change(f, () => db.team.update({ where: { id: f.team.id }, data: { archivedAt: new Date() } }));
        expect((await publish(f, event)).recipients).toEqual([f.owner.id, f.direct.id].sort());
        await change(f, () => db.team.update({ where: { id: f.team.id }, data: { archivedAt: null } }));
        expect((await publish(f, event)).recipients).toEqual(allRecipients(f));
    });

    it('stops collaborators when the real external-link writer leaves hosted, and the audience when the real delete commits', async () => {
        const f = await fixture();
        expect((await publish(f, events[0])).recipients).toEqual(allRecipients(f));
        await expect(inTx(async tx => initializeExternalLinkedSessionStorage(tx, await tx.session.findUniqueOrThrow({ where: { id: f.session.id } }), f.owner.id)))
            .resolves.toMatchObject({ ok: true });
        expect((await publish(f, events[0])).recipients).toEqual([f.owner.id]);
        await expect(deleteOwnedSession({ sessionId: f.session.id, ownerAccountId: f.owner.id, reason: 'user_request' }))
            .resolves.toMatchObject({ ok: true });
        expect((await publish(f, events[0])).recipients).toEqual([]);
    });

    it('never binds another Account as publisher of this Session, even holding its own retained key', async () => {
        const f = await fixture();
        await db.accessKey.create({ data: { accountId: f.direct.id, machineId: f.machine.id, sessionId: f.session.id, data: 'recipient-key' } });
        await expect(resolveSessionScopedSocketBinding({ userId: f.direct.id, sessionId: f.session.id, machineId: f.machine.id }))
            .resolves.toMatchObject({ ok: false, error: 'invalid-session-access-key' });
    });

    it('evicts the exact publisher through the Machine revoke owner and refuses its reconnect', async () => {
        const f = await fixture();
        await expect(inTx(tx => revokeMachineInTx(tx, { accountId: f.owner.id, machineId: f.machine.id })))
            .resolves.toMatchObject({ ok: true });
        expect(evict).toHaveBeenCalledWith({ accountId: f.owner.id, machineId: f.machine.id,
            sessionBindings: [{ accountId: f.owner.id, sessionId: f.session.id }] });
        await expect(resolveSessionScopedSocketBinding({ userId: f.owner.id, sessionId: f.session.id, machineId: f.machine.id }))
            .resolves.toMatchObject({ ok: false, error: 'invalid-session-access-key' });
    });

    it('retains an admitted requester publisher when its foreign Machine grant ends and refuses its reconnect', async () => {
        const f = await fixture();
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: f.machine.id }, data: { accountId: custodian.id } });
        await db.machineAccountGrant.create({ data: { machineId: f.machine.id, accountId: f.owner.id,
            accessLevel: 'view', createdByAccountId: custodian.id } });
        await expect(resolveSessionScopedSocketBinding({ userId: f.owner.id, sessionId: f.session.id, machineId: f.machine.id }))
            .resolves.toMatchObject({ ok: true });
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: f.machine.id,
            principal: { kind: 'account', accountId: f.owner.id } }));
        expect(evict).toHaveBeenCalledWith({ accountId: f.owner.id, machineId: f.machine.id,
            sessionBindings: [] });
        await expect(resolveSessionScopedSocketBinding({ userId: f.owner.id, sessionId: f.session.id, machineId: f.machine.id }))
            .resolves.toMatchObject({ ok: false, error: 'invalid-session-access-key' });
    });
});
