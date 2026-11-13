import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';
import { readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from './sessionRecipients';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session audience inventory bind bounds (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    const membershipResults: Array<{ model: string; rows: number; bytes: number }> = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;
    let originalTransaction: typeof db.$transaction;
    let resolveQueryBarrier: (() => void) | undefined;
    async function drainQueryEvents() {
        const observed = new Promise<void>(resolve => { resolveQueryBarrier = resolve; });
        try {
            // Await both the SQL result and this client's ordered engine event.
            await Promise.all([client!.$queryRaw`SELECT 1 AS "session_publication_cost_barrier"`, observed]);
        } finally { resolveQueryBarrier = undefined; }
    }
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        originalTransaction = db.$transaction;
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => {
            if (event.query.includes('"session_publication_cost_barrier"')) resolveQueryBarrier?.();
            else queries.push(event);
        });
        await client.$connect();
        const traced = client.$extends({ query: { $allModels: { async $allOperations({ model, args, query }) {
            const result = await query(args);
            // Observe native engine results without replacing any query or recipient logic.
            const arrays: unknown[][] = [];
            const visit = (value: unknown): void => {
                if (Array.isArray(value)) {
                    for (const entry of value) visit(entry);
                } else if (value && typeof value === 'object') {
                    for (const [field, entry] of Object.entries(value)) {
                        if (field === 'memberships' && Array.isArray(entry)) arrays.push(entry);
                        else visit(entry);
                    }
                }
            };
            if ((model === 'TeamMembership' || model === 'TeamGroupMembership') && Array.isArray(result)) arrays.push(result);
            else visit(result);
            if (arrays.length > 0) membershipResults.push({ model, rows: arrays.reduce((sum, rows) => sum + rows.length, 0),
                bytes: arrays.reduce((sum, rows) => sum + Buffer.byteLength(JSON.stringify(rows)), 0) });
            return result;
        } } } });
        // Only the persistent transport changes; native SQL, transaction and recipient owners remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });
    afterEach(() => vi.unstubAllEnvs());

    it('reads publication facts once per change while advancing current recipients and excluding a revoked share', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        const share = await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id,
            createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view' } });
        const publicationReads: number[] = [];
        const publish = async (seq: number) => {
            await drainQueryEvents();
            queries.length = 0;
            await inTx(async tx => {
                await tx.session.update({ where: { id: session.id }, data: { seq } });
                await markSessionProjectionRecipientsChanged({ tx, sessionId: session.id,
                    hint: { lastMessageSeq: seq }, followSourceChanged: false });
            });
            await drainQueryEvents();
            publicationReads.push(queries.filter(event => /^SELECT\b/.test(event.query.trimStart())
                && /FROM\s+"public"\."Session"(?:\s|$)/.test(event.query)
                && event.query.includes('"currentStorageState"')).length);
        };
        await publish(1);
        const changes = () => db.accountChange.findMany({ where: { kind: 'session', entityId: session.id },
            select: { accountId: true, cursor: true, hint: true } });
        const first = await changes();
        expect(first).toEqual(expect.arrayContaining([owner, viewer].map(account => expect.objectContaining({
            accountId: account.id, cursor: 1, hint: expect.objectContaining({ lastMessageSeq: 1 }),
        }))));
        expect(first).toHaveLength(2);
        await db.sessionGrant.delete({ where: { principalKind: 'account', id: share.id } });
        await publish(2);
        expect(await changes()).toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: owner.id, cursor: 2, hint: expect.objectContaining({ lastMessageSeq: 2 }) }),
            expect.objectContaining({ accountId: viewer.id, cursor: 1, hint: expect.objectContaining({ lastMessageSeq: 1 }) }),
        ]));
        console.info('SESSION_PUBLICATION_FACT_READS', JSON.stringify({ changes: 2, publicationReads }));
        expect(publicationReads).toEqual([1, 1]);
    });

    function assertBindBudget(name: string) {
        const binds = queries.map(query => (JSON.parse(query.params) as unknown[]).length);
        expect(binds.length).toBeGreaterThan(0);
        expect(Math.max(...binds)).toBeLessThanOrEqual(999);
        console.info('SESSION_AUDIENCE_SQL_BINDS', JSON.stringify({ name, statements: queries.length, maxBinds: Math.max(...binds) }));
    }

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const direct = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { id: `z-${randomUUID()}`, accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: direct.id, accessLevel: 'view' } });
        // Inventory-sized selectors with one real member isolate transport binding from fixture insertion work.
        const ids = Array.from({ length: 35001 }, (_, index) => index === 35000 ? session.id : `missing-${randomUUID()}`);
        return { owner, direct, session, ids };
    }

    it('reads all requested recipient entries above the native 32767-bind boundary', async () => {
        const f = await fixture();
        queries.length = 0;
        const recipients = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: f.ids }));
        expect(recipients.size).toBe(f.ids.length);
        expect(recipients.get(f.session.id)).toEqual([f.owner.id, f.direct.id].sort());
        expect(recipients.get(f.ids[0]!)).toEqual([]);
        assertBindBudget('recipients');
        console.info('SESSION_RECIPIENT_BIND_SCALE', JSON.stringify({ requested: f.ids.length, entries: recipients.size }));
    });

    it('captures the complete cursor audience above the three-arm relation bind boundary', async () => {
        const f = await fixture();
        const earlyOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createSession = (id: string, accountId: string) => db.session.create({ data: {
            id, accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        // The cursor owner sorts before chunking: a < missing-* < z forces distinct real boundaries.
        const early = await createSession(`a-${randomUUID()}`, earlyOwner.id);
        const manager = await createSession(`b-${randomUUID()}`, earlyOwner.id);
        const earlyDestination = await createSession(`x-${randomUUID()}`, earlyOwner.id);
        const lateDestination = await createSession(`y-${randomUUID()}`, f.owner.id);
        f.ids[0] = early.id;
        for (const [source, destination, relation] of [
            [early, earlyDestination, 'follower'], [f.session, lateDestination, 'follower'],
            [manager, early, 'manager'],
        ] as const) {
            await db.sessionFollowEdge.create({ data: { sourceSessionId: source.id,
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
                destinationSessionId: destination.id, relation,
                managerSourceSessionId: relation === 'manager' ? source.id : null,
                policyJson: '{"preset":"important"}',
            } });
        }
        queries.length = 0;
        const audience = await inReadSnapshot(tx => readSessionAccountCursorAudienceInTx(tx, f.ids, []));
        expect(audience.projectionSessionIds).toEqual([...f.ids, earlyDestination.id, lateDestination.id, manager.id].sort());
        expect(audience.accountIds).toEqual([f.owner.id, f.direct.id, earlyOwner.id].sort());
        assertBindBudget('cursor');
        console.info('SESSION_CURSOR_BIND_SCALE', JSON.stringify({ requested: f.ids.length, projection: audience.projectionSessionIds.length }));
    });

    it('bounds native grant joins while retaining horizons, guest membership and fresh revocation', async () => {
        vi.stubEnv('HAPPIER_FEATURE_SHARING__SESSION_ENABLED', '1');
        const accounts = await Promise.all(Array.from({ length: 5 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
        const [owner, direct, member, guest, cutoff] = accounts;
        const effectiveAt = new Date('2026-09-01T12:00:00.000Z');
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member!.id, role: 'member',
            sessionAccessStartsAt: new Date(effectiveAt.getTime() - 1) } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: cutoff!.id, role: 'member',
            sessionAccessStartsAt: effectiveAt } });
        const guestMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: guest!.id, role: 'guest' } });
        const groupName = randomUUID();
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: groupName, nameKey: groupName } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: guestMembership.id } });
        const ids = Array.from({ length: 1100 }, () => randomUUID());
        await db.session.createMany({ data: ids.map(id => ({ id, accountId: owner!.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' })) });
        await db.sessionGrant.createMany({ data: (ids.map(sessionId => ({ sessionId, createdByAccountId: owner!.id,
            accountId: direct!.id, accessLevel: 'view' }))).map(data => ({ ...data, principalKind: 'account' })) });
        await db.sessionGrant.createMany({ data: (ids.map(sessionId => ({ sessionId, teamId: team.id, accessLevel: 'view', effectiveAt }))).map(data => ({ ...data, principalKind: 'team' })) });
        await db.sessionGrant.createMany({ data: (ids.map(sessionId => ({ sessionId, teamGroupId: group.id, accessLevel: 'view', effectiveAt }))).map(data => ({ ...data, principalKind: 'group' })) });
        membershipResults.length = 0;
        await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [ids[0]!] }));
        const singleMembershipRows = membershipResults.reduce((sum, result) => sum + result.rows, 0);
        const singleMembershipBytes = membershipResults.reduce((sum, result) => sum + result.bytes, 0);
        expect(singleMembershipRows).toBe(3);
        membershipResults.length = 0;
        queries.length = 0;
        const result = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ids }));
        for (const id of ids) expect(result.get(id)).toEqual([owner!.id, direct!.id, member!.id, guest!.id].sort());
        assertBindBudget('native-grants');
        const membershipRows = membershipResults.reduce((sum, result) => sum + result.rows, 0);
        const membershipBytes = membershipResults.reduce((sum, result) => sum + result.bytes, 0);
        console.info('SESSION_RECIPIENT_MEMBERSHIP_RESULTS', JSON.stringify({ sessions: ids.length, singleMembershipRows,
            singleMembershipBytes, membershipRows, membershipBytes, results: membershipResults }));
        // Shared Team/Group grants must transport each distinct membership only once.
        expect(membershipRows).toBe(singleMembershipRows);
        expect(membershipBytes).toBe(singleMembershipBytes);

        // Later grants sharing Team/Group membership must evaluate their own horizons.
        await db.sessionGrant.update({ where: { principalKind: 'team', sessionId_teamId: { sessionId: ids[0]!, teamId: team.id } },
            data: { effectiveAt: new Date(effectiveAt.getTime() + 1) } });
        await db.teamGroupMembership.update({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: group.id, teamMembershipId: guestMembership.id,
        } }, data: { sessionAccessStartsAt: effectiveAt } });
        await db.sessionGrant.update({ where: { principalKind: 'group', sessionId_teamGroupId: { sessionId: ids[0]!, teamGroupId: group.id } },
            data: { effectiveAt: new Date(effectiveAt.getTime() + 1) } });
        const variedHorizons = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ids.slice(0, 2) }));
        expect(variedHorizons.get(ids[0]!)).toEqual([owner!.id, direct!.id, member!.id, guest!.id, cutoff!.id].sort());
        expect(variedHorizons.get(ids[1]!)).toEqual([owner!.id, direct!.id, member!.id].sort());

        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        const groupRevoked = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [ids[0]!] }));
        expect(groupRevoked.get(ids[0]!)).toEqual([owner!.id, direct!.id, member!.id, cutoff!.id].sort());
        await db.account.update({ where: { id: member!.id }, data: { status: 'suspended' } });
        const activeOnly = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [ids[1]!] }));
        expect(activeOnly.get(ids[1]!)).toEqual([owner!.id, direct!.id].sort());
        const includingInactive = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
            sessionIds: [ids[1]!], includeInactiveAccounts: true,
        }));
        expect(includingInactive.get(ids[1]!)).toEqual([owner!.id, direct!.id, member!.id].sort());
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', createdByAccountId: owner!.id } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        queries.length = 0;
        const revoked = await inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ids }));
        for (const id of ids) expect(revoked.get(id)).toEqual([owner!.id]);
        assertBindBudget('revoked-grants');
    });
});
