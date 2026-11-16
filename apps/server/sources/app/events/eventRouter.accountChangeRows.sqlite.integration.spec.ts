import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { readAccountChangeRowsDemandV1 } from '@happier-dev/protocol/changes';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { getAccountChangeRowsSocketRoom, getAccountStoredContentV3SocketRoom } from '@/app/api/socketRooms';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { eventRouter } from './connectionEventRouter';

type Wake = Readonly<{ seq: number; body: Readonly<{ t: string; rows?: Readonly<{ after: number; page: Readonly<{
    changes: readonly Readonly<{ cursor: number; entityId: string; hint?: unknown }>[]; nextCursor: number;
    sessionAccessWitness?: Readonly<{ entries: readonly Readonly<{ sessionId: string; status: string }>[] }> }> }> }> }>;

// The Account wake is the authority's fan-out: each row-demand socket receives the page the feed
// owner reads for that socket's own credential, once; other sockets keep the content-free wake.
describe('Account wake with per-socket authorized change rows (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1');
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-account-change-rows-', initAuth: false,
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' } });
    }, 180_000);
    afterAll(async () => {
        await harness?.close();
        vi.unstubAllEnvs();
    });

    it('pushes each socket only the rows its credential may see, and stops delivering a revoked Session', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', publicKey: `owner-${crypto.randomUUID()}` } });
        const binding = createSignedAccountContentBinding();
        const member = await db.account.create({ data: { encryptionMode: 'e2ee', publicKey: binding.publicKey,
            contentPublicKey: Buffer.from(binding.contentPublicKey), contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
        const team = await db.team.create({ data: { name: 'Engineering',
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }] } } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: member.id, role: 'member' },
        ] });
        const teamSession = await db.session.create({ data: { accountId: owner.id, tag: 'team', encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: teamSession.id, teamId: team.id,
            accessLevel: 'view', effectiveAt: new Date(0) } });
        const ownSession = await db.session.create({ data: { accountId: member.id, tag: 'own', encryptionMode: 'plain', metadata: '{}' } });

        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            // Authentication is the external boundary: stamp the verified facts socket admission stamps.
            const auth = socket.handshake.auth as { test: { machineId: string; evidence: unknown[] } };
            Object.assign(socket.data, { userId: member.id, clientType: 'machine-scoped', machineId: auth.test.machineId,
                authAuthority: 'present_user', authTokenAuthenticationEvidence: auth.test.evidence });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            const demand = readAccountChangeRowsDemandV1(socket.handshake.auth);
            const rooms = [getAccountStoredContentV3SocketRoom(member.id)];
            if (demand) {
                socket.data.accountChangeRows = { kinds: demand.kinds };
                rooms.push(getAccountChangeRowsSocketRoom(member.id));
            }
            void socket.join(rooms);
            socket.emit('joined');
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const keyChallenge = [{ kind: 'home_method', methodId: 'key_challenge' }];
        const open = (machineId: string, evidence: unknown[], rows: boolean) => connect(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { test: { machineId, evidence },
                accountStoredContentCompatibility: { v: 1, protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION },
                ...(rows ? { accountChangeRows: { v: 1, kinds: ['session', 'share'] } } : {}) },
        });
        const qualified = open('qualified', keyChallenge, true);
        const unqualified = open('unqualified', [], true);
        const bare = open('bare', keyChallenge, false);
        const clients = [qualified, unqualified, bare];
        const received = new Map<ClientSocket, Wake[]>(clients.map(client => [client, []]));
        for (const client of clients) client.on('update', (wake: Wake) => received.get(client)!.push(wake));
        const pagesOf = (client: ClientSocket) => received.get(client)!.flatMap(wake => wake.body.rows ? [wake.body.rows] : []);
        try {
            await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
                client.once('joined', () => resolve()); client.once('connect_error', reject);
            })));

            await inTx(tx => markAccountChanged(tx, { accountId: member.id, kind: 'session', entityId: teamSession.id }));
            await vi.waitFor(() => clients.forEach(client => expect(received.get(client)).toHaveLength(1)));
            const [toQualified] = pagesOf(qualified);
            const [toUnqualified] = pagesOf(unqualified);
            expect(toQualified?.page.changes).toEqual([
                expect.objectContaining({ entityId: teamSession.id, hint: expect.objectContaining({ pendingExecutionRunIds: [] }) })]);
            expect(toQualified?.page.sessionAccessWitness?.entries).toEqual([
                expect.objectContaining({ sessionId: teamSession.id, status: 'available' })]);
            // No access: the row is only the access-loss event, with none of the Session's facts.
            expect(toUnqualified?.page.changes).toEqual([expect.objectContaining({ entityId: teamSession.id, hint: null })]);
            expect(toUnqualified?.page.sessionAccessWitness?.entries).toEqual([
                expect.objectContaining({ sessionId: teamSession.id, status: 'unavailable' })]);
            expect(received.get(bare)![0]!.body.rows).toBeUndefined();

            // Revocation: the membership goes; the next pages drop the Session's facts for that socket.
            await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: member.id } });
            await inTx(tx => markAccountChanged(tx, { accountId: member.id, kind: 'session', entityId: teamSession.id }));
            await inTx(tx => markAccountChanged(tx, { accountId: member.id, kind: 'session', entityId: ownSession.id }));
            await vi.waitFor(() => expect(received.get(qualified)).toHaveLength(3));
            const later = pagesOf(qualified).slice(1);
            // Each page starts where this socket's previous page ended.
            expect(later.map(page => page.after)).toEqual([toQualified!.page.nextCursor, later[0]!.page.nextCursor]);
            const rows = later.flatMap(page => page.page.changes);
            expect(rows.find(row => row.entityId === teamSession.id)).toEqual(expect.objectContaining({ hint: null }));
            expect(rows.find(row => row.entityId === ownSession.id)).toEqual(expect.objectContaining({ hint: expect.objectContaining({ pendingExecutionRunIds: [] }) }));
            expect(later.flatMap(page => page.page.sessionAccessWitness?.entries ?? [])).toEqual(expect.arrayContaining([
                expect.objectContaining({ sessionId: teamSession.id, status: 'unavailable' }),
                expect.objectContaining({ sessionId: ownSession.id, status: 'available' }),
            ]));
        } finally {
            clients.forEach(client => client.close());
            eventRouter.clearIo();
            await io.close();
        }
    });

    it('reads at most one page in flight and one pending per socket, and still delivers every wake', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', publicKey: `burst-${crypto.randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'burst', encryptionMode: 'plain', metadata: '{}' } });
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            Object.assign(socket.data, { userId: account.id, clientType: 'machine-scoped', machineId: 'burst-machine',
                authAuthority: 'present_user', authTokenAuthenticationEvidence: [] });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            socket.data.accountChangeRows = { kinds: readAccountChangeRowsDemandV1(socket.handshake.auth)!.kinds };
            void socket.join([getAccountStoredContentV3SocketRoom(account.id), getAccountChangeRowsSocketRoom(account.id)]);
            socket.emit('joined');
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const client = connect(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { accountStoredContentCompatibility: { v: 1, protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION },
                accountChangeRows: { v: 1, kinds: ['session'] } } });
        const wakes: Wake[] = [];
        client.on('update', (wake: Wake) => wakes.push(wake));
        // The database is the boundary: hold the first page read until the whole burst has committed.
        let pageReads = 0;
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const stop = observeSqliteRequests({ before: async (request) => {
            const where = (request.args as { where?: { accountId?: string; cursor?: unknown } } | undefined)?.where;
            if (request.model !== 'AccountChange' || request.action !== 'findMany' || where?.accountId !== account.id || !where.cursor) return;
            pageReads += 1;
            if (pageReads === 1) await released;
        } });
        try {
            await new Promise<void>((resolve, reject) => { client.once('joined', () => resolve()); client.once('connect_error', reject); });
            for (let index = 0; index < 5; index += 1) {
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id }));
            }
            await vi.waitFor(() => expect(pageReads).toBe(1));
            release();
            await vi.waitFor(() => expect(wakes).toHaveLength(5));
            const seq = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
            expect(wakes.every(wake => wake.body.rows !== undefined)).toBe(true);
            expect(Math.max(...wakes.map(wake => wake.body.rows!.page.nextCursor))).toBe(seq);
            expect(pageReads).toBe(2);
        } finally {
            stop();
            client.close();
            eventRouter.clearIo();
            await io.close();
        }
    });
});
