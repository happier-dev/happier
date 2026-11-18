import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { ACCOUNT_CHANGES_PAGE_LIMIT_V1, readAccountChangeRowsDemandV1 } from '@happier-dev/protocol/changes';
import { buildProviderAccountUsageMaterialChangesV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/providerAccountUsagePrimitives';
import { buildPluginDomainAccountChangeEntityId } from '@happier-dev/protocol/changes/pluginDomain';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { markAccountChanged, markAccountProjectionChanges } from '@/app/changes/markAccountChanged';
import { readAccountChangesPage } from '@/app/changes/readAccountChangesPage';
import { readSessionAccessAuthenticationFromSocket } from '@/app/session/access/sessionAccessAuthentication';
import { getAccountChangeRowsSocketRoom, getAccountStoredContentV3SocketRoom } from '@/app/api/socketRooms';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { eventRouter } from './connectionEventRouter';

type Wake = Readonly<{ seq: number; body: Readonly<{ t: string; rows?: Readonly<{ after: number; page: Readonly<{
    changes: readonly Readonly<{ cursor: number; entityId: string; hint?: unknown }>[]; nextCursor: number; full?: boolean;
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

    it('pushes the rows the write produced: no page read per wake, one access read per credential per wake', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', publicKey: `push-${crypto.randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'push', encryptionMode: 'plain', metadata: '{}' } });
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            const auth = socket.handshake.auth as { test: { machineId: string; evidence: unknown[] } };
            Object.assign(socket.data, { userId: account.id, clientType: 'machine-scoped', machineId: auth.test.machineId,
                authAuthority: 'present_user', authTokenAuthenticationEvidence: auth.test.evidence });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            socket.data.accountChangeRows = { kinds: readAccountChangeRowsDemandV1(socket.handshake.auth)!.kinds };
            void socket.join([getAccountStoredContentV3SocketRoom(account.id), getAccountChangeRowsSocketRoom(account.id)]);
            socket.emit('joined');
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const open = (machineId: string, evidence: unknown[]) => connect(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { test: { machineId, evidence },
                accountStoredContentCompatibility: { v: 1, protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION },
                accountChangeRows: { v: 1, kinds: ['session', 'share', 'account'] } },
        });
        // Two sockets share one credential; the third holds another.
        const keyChallenge = [{ kind: 'home_method', methodId: 'key_challenge' }];
        const clients = [open('m1', []), open('m2', []), open('m3', keyChallenge)];
        const received = new Map<ClientSocket, Wake[]>(clients.map(client => [client, []]));
        for (const client of clients) client.on('update', (wake: Wake) => received.get(client)!.push(wake));
        // The database is the boundary: count the post-commit reads the fan-out issues.
        const counts = { pageReads: 0, floorReads: 0, pendingReads: 0, accessReads: 0 };
        let observing = false;
        const stop = observeSqliteRequests({ before: (request) => {
            if (!observing) return;
            const args = request.args as { where?: Record<string, unknown>; select?: Record<string, unknown> } | undefined;
            if (request.model === 'AccountChange' && request.action === 'findMany' && args?.where?.cursor) counts.pageReads += 1;
            if (request.model === 'Account' && request.action === 'findUnique' && args?.select?.changesFloor) counts.floorReads += 1;
            if (request.model === 'SessionPendingMessage' && request.action === 'findMany') counts.pendingReads += 1;
            if (request.model === 'Session' && request.action === 'findMany') counts.accessReads += 1;
        } });
        const WAKES = 3;
        try {
            await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
                client.once('joined', () => resolve()); client.once('connect_error', reject);
            })));
            observing = true;
            for (let index = 0; index < WAKES; index += 1) {
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
                    hint: { pendingCount: index, pendingVersion: index + 1 } }));
                await vi.waitFor(() => clients.forEach(client => expect(received.get(client)).toHaveLength(index + 1)));
            }
            observing = false;
            expect(counts).toEqual({ pageReads: 0, floorReads: 0, pendingReads: WAKES, accessReads: WAKES * 2 });

            const seq = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
            const serverSockets = await io.fetchSockets();
            for (const client of clients) {
                const pages = received.get(client)!.map(wake => wake.body.rows!);
                // Contiguous: each page starts where this socket's previous page ended, through the Account seq.
                expect(pages.slice(1).map(page => page.after)).toEqual(pages.slice(0, -1).map(page => page.page.nextCursor));
                expect(pages.at(-1)!.page.nextCursor).toBe(seq);
                // Each pushed page is exactly the page the feed owner reads for this credential.
                const serverSocket = serverSockets.find(socket => socket.id === client.id)!;
                for (const pushed of pages) {
                    const read = await readAccountChangesPage({ accountId: account.id, after: pushed.after, limit: 200,
                        kinds: ['session', 'share', 'account'], compatibility: { ...serverSocket.data.accountStoredContentCompatibility },
                        readAuthentication: () => readSessionAccessAuthenticationFromSocket(serverSocket) });
                    if (pushed === pages.at(-1)) expect(read).toEqual({ status: 'ok', page: pushed.page });
                    else expect(pushed.page.changes).toEqual([expect.objectContaining({ cursor: pushed.page.nextCursor, entityId: session.id })]);
                }
            }
        } finally {
            stop();
            clients.forEach(client => client.close());
            eventRouter.clearIo();
            await io.close();
        }
    });

    it('gives a socket its current-view wake\'s page, marked as pushed to that Session, so its cursor never gaps', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', publicKey: `excluded-${crypto.randomUUID()}` } });
        const viewed = await db.session.create({ data: { accountId: account.id, tag: 'viewed', encryptionMode: 'plain', metadata: '{}' } });
        const other = await db.session.create({ data: { accountId: account.id, tag: 'other', encryptionMode: 'plain', metadata: '{}' } });
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            // A session host's Account socket: user-scoped, so a current-view wake excludes it.
            Object.assign(socket.data, { userId: account.id, clientType: 'user-scoped',
                authAuthority: 'present_user', authTokenAuthenticationEvidence: [] });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            socket.data.accountChangeRows = { kinds: readAccountChangeRowsDemandV1(socket.handshake.auth)!.kinds };
            void socket.join([getAccountStoredContentV3SocketRoom(account.id), getAccountChangeRowsSocketRoom(account.id), `user-scoped:${account.id}`]);
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
        client.on('update', (wake: Wake) => { if (wake.body.t === 'account-change') wakes.push(wake); });
        try {
            await new Promise<void>((resolve, reject) => { client.once('joined', () => resolve()); client.once('connect_error', reject); });
            await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: other.id }));
            await vi.waitFor(() => expect(wakes).toHaveLength(1));
            // The bare wake excludes this socket (the Session's current view reaches it); its page still comes,
            // marked so a consumer holding that Session's live socket applies none of its facts twice.
            await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: viewed.id, currentViewSessionId: viewed.id }));
            const viewedCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
            await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: other.id }));
            await vi.waitFor(() => expect(wakes).toHaveLength(3));
            const [first, viewedWake, last] = wakes as [Wake, Wake, Wake];
            expect((viewedWake.body as { rowFactsPushedSessionId?: string }).rowFactsPushedSessionId).toBe(viewed.id);
            expect(viewedWake.body.rows!.page.changes.map(change => change.cursor)).toEqual([viewedCursor]);
            // Each page covers exactly its wake; together they are contiguous.
            expect([viewedWake.body.rows!.after, last.body.rows!.after]).toEqual([first.body.rows!.page.nextCursor, viewedCursor]);
        } finally {
            client.close();
            eventRouter.clearIo();
            await io.close();
        }
    });

    it('cuts a pushed wake page where the feed would, never acknowledging only the global half of a quota pair', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', publicKey: `pair-${crypto.randomUUID()}` } });
        const recordId = buildProviderAccountUsageRecordId({ providerId: 'claude', accountSubjectId: 'account',
            subjectKind: 'account', quotaScope: 'account' });
        const [global, exact] = buildProviderAccountUsageMaterialChangesV1(recordId);
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates' });
        io.on('connection', socket => {
            Object.assign(socket.data, { userId: account.id, clientType: 'user-scoped',
                authAuthority: 'present_user', authTokenAuthenticationEvidence: [] });
            writeAccountStoredContentCompatibilityForSocket(socket, evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            socket.data.accountChangeRows = { kinds: readAccountChangeRowsDemandV1(socket.handshake.auth)!.kinds };
            void socket.join([getAccountStoredContentV3SocketRoom(account.id), getAccountChangeRowsSocketRoom(account.id), `user-scoped:${account.id}`]);
            socket.emit('joined');
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing test address');
        eventRouter.setIo(io);
        const client = connect(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { accountStoredContentCompatibility: { v: 1, protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION },
                accountChangeRows: { v: 1, kinds: ['account', 'machine'] } } });
        const wakes: Wake[] = [];
        client.on('update', (wake: Wake) => { if (wake.body.t === 'account-change') wakes.push(wake); });
        const limit = ACCOUNT_CHANGES_PAGE_LIMIT_V1;
        try {
            await new Promise<void>((resolve, reject) => { client.once('joined', () => resolve()); client.once('connect_error', reject); });
            // One wake: a page's worth of rows whose last two straddle a quota pair.
            await inTx(async tx => {
                await markAccountProjectionChanges(tx, 'machine', new Map(Array.from({ length: limit - 1 },
                    (_, index) => [`machine-${index}`, [account.id]] as const)));
                await markAccountChanged(tx, { accountId: account.id, ...global });
                await markAccountChanged(tx, { accountId: account.id, ...exact });
            });
            await vi.waitFor(() => expect(wakes).toHaveLength(1));
            const pushed = wakes[0]!.body.rows!;
            expect(pushed.page.changes.map(change => change.entityId)).not.toContain(global.entityId);
            expect(pushed.page).toEqual(expect.objectContaining({ full: true, nextCursor: pushed.page.changes.at(-1)!.cursor }));
            // The pushed page is the page the feed owner reads for the same cursor.
            const serverSocket = (await io.fetchSockets())[0]!;
            expect(await readAccountChangesPage({ accountId: account.id, after: pushed.after, limit,
                kinds: ['account', 'machine'], compatibility: { ...serverSocket.data.accountStoredContentCompatibility },
                readAuthentication: () => readSessionAccessAuthenticationFromSocket(serverSocket) }))
                .toEqual({ status: 'ok', page: pushed.page });
        } finally {
            client.close();
            eventRouter.clearIo();
            await io.close();
        }
    });

    it('judges a filtered feed page full on the stored rows, so its reader reads on', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', publicKey: `full-${crypto.randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'full', encryptionMode: 'plain', metadata: '{}' } });
        for (const pluginId of ['test.alpha', 'test.beta']) {
            const hint = { pluginDomain: 'availability', pluginId };
            await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'pluginDomain',
                entityId: buildPluginDomainAccountChangeEntityId(hint), hint }));
        }
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id }));
        const kinds = (await db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: 'asc' } })).map(row => row.kind);
        expect(kinds.slice(0, 2)).toEqual(['pluginDomain', 'pluginDomain']);
        // A V4 reader that cannot consume plugin rows: they are read, then hidden (a released reader is filled in SQL).
        const read = await readAccountChangesPage({ accountId: account.id, after: 0, limit: 2,
            compatibility: { supportsPluginDataProtocol: false, supportsMachinePoolChangeProtocol: true,
                supportsSavedSecretResourceChangeProtocol: true, supportsSessionAccessWitnessProtocol: true } as never,
            readAuthentication: () => { throw new Error('unused'); } });
        expect(read.status === 'ok' && read.page).toEqual(expect.objectContaining({ changes: [], full: true }));
    });
});
