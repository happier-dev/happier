import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { db, getDbProviderFromEnv, initDbPostgres, initDbMysql } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { changeUsernameInTx } from '@/app/social/usernameUpdate';
import { readHomeAccountDetailInTx } from '@/app/home/governance/homeGovernanceService';
import { publicProfileServerDependencies as deps } from './publicProfileDependencies';
import { publishPublicProfile } from './publicProfilePublish';
import { refreshPublicProfile } from './publicProfileRefresh';
import { updatePublicProfile } from './publicProfileUpdate';
import { pausePublicProfile } from './publicProfilePause';
import { unpublishPublicProfile } from './publicProfileUnpublish';
import { moderatePublicProfile } from './publicProfileModeration';
import { reclaimPublicProfileHandle } from './publicProfileHandleReclaim';

const publicationEnv = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example', HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' };
const body = () => PublicProfilePublishBodyV1Schema.parse({ policy: structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1),
    metadata: {}, projectSelections: [], query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
    snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
        coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: { tokens: 987654321 } },
    layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
const refreshBody = () => { const captured = body(); return { query: captured.query, snapshot: captured.snapshot }; };

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('Public Profile current admission (real provider)', () => {
    beforeAll(async () => {
        const supplied = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Run with the disposable provider DB-contract harness');
        if (provider === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    async function fixture() {
        const account = await db.account.create({ data: { username: `profile_${randomUUID().replaceAll('-', '')}`, homeRole: 'owner', encryptionMode: 'plain' } });
        expect(await publishPublicProfile(account.id, body(), publicationEnv, deps)).toMatchObject({ kind: 'updated' });
        return account;
    }

    async function afterInitialCapture<T>(accountId: string, concurrent: () => Promise<unknown>, operation: () => Promise<T>): Promise<T> {
        const transaction = db.$transaction;
        let interleaved = false;
        // Schedule real committed owners only at the database boundary. A hot
        // cursor or revoked consent must be read afresh under mutation admission.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function' || interleaved) return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
                interleaved = true;
                await concurrent();
                return callback(tx);
            }, ...args.slice(1)]);
        } });
        try {
            const result = await operation();
            expect(interleaved).toBe(true);
            return result;
        } finally { db.$transaction = transaction; }
    }

    it.each(['pause', 'refresh'] as const)('refuses stale %s after committed withdrawal without exhausting conflicts', async operation => {
        const account = await fixture();
        try {
            const result = await afterInitialCapture(account.id, () => unpublishPublicProfile(account.id), () => operation === 'pause'
                ? pausePublicProfile(account.id) : refreshPublicProfile(account.id, refreshBody(), publicationEnv, deps));
            expect(result).toEqual({ kind: 'unavailable', reason: 'not_published' });
            expect(await db.accountPublicProfile.findUnique({ where: { accountId: account.id } })).toBeNull();
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('projects fresh facts under the consent that committed before admission', async () => {
        const account = await fixture();
        const policy = body().policy;
        policy.fields.tokens = false;
        try {
            expect(await afterInitialCapture(account.id, () => updatePublicProfile(account.id, { policy }),
                () => refreshPublicProfile(account.id, refreshBody(), publicationEnv, deps))).toMatchObject({ kind: 'updated' });
            const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(JSON.parse(row.policyJson!).fields.tokens).toBe(false);
            expect(row.snapshotJson).not.toContain('987654321');
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it.skipIf(provider !== 'postgres')('lets consent commit while a refresh holds only its captured row, then remasks the refresh', async () => {
        const account = await fixture();
        const transaction = db.$transaction;
        const policy = body().policy;
        policy.fields.tokens = false;
        let peer: Promise<unknown> | undefined;
        let peerSettled = false;
        let blocked = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'accountPublicProfile') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.accountPublicProfile, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findUnique') return operation;
                    return async (...parameters: unknown[]) => {
                        const row: unknown = await Reflect.apply(operation, delegate, parameters);
                        if (!peer) {
                            const [{ pid }] = await inner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            peer = updatePublicProfile(account.id, { policy }).finally(() => { peerSettled = true; });
                            while (!peerSettled) {
                                const waiting = await db.$queryRaw<Array<{ pid: number }>>`
                                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                                    AND ${pid} = ANY(pg_blocking_pids(pid))
                                `;
                                if (waiting.length > 0) { blocked = true; break; }
                            }
                            expect(blocked, 'ordinary consent writes do not wait behind Account admission').toBe(false);
                        }
                        return row;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await refreshPublicProfile(account.id, refreshBody(), publicationEnv, deps)).toMatchObject({ kind: 'updated' });
            expect(await peer).toMatchObject({ kind: 'updated' });
            const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(JSON.parse(row.policyJson!).fields.tokens).toBe(false);
            expect(row.snapshotJson).not.toContain('987654321');
        } finally {
            db.$transaction = transaction;
            if (peer) await Promise.allSettled([peer]);
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(['pause', 'unpublish', 'restrict', 'query', 'prune', 'metadata_case', 'metadata_accent'] as const)('keeps a %s committed after a refresh captured the row', async operation => {
        const account = await fixture();
        const transaction = db.$transaction;
        const policy = body().policy;
        policy.fields.tokens = false;
        if (operation === 'metadata_case' || operation === 'metadata_accent') await updatePublicProfile(account.id, {
            policy: { ...body().policy, fields: { ...body().policy.fields, bio: true } }, metadata: { bio: operation === 'metadata_case' ? 'Case' : 'Café' },
        });
        let peer: Promise<unknown> | undefined;
        let peerSettled = false;
        let peerBeforeWrite = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'accountPublicProfile') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.accountPublicProfile, { get(delegate, method, delegateReceiver) {
                    const read = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findUnique') return read;
                    return async (...parameters: unknown[]) => {
                        const row: unknown = await Reflect.apply(read, delegate, parameters);
                        if (!peer) {
                            const edit = operation === 'pause' ? () => pausePublicProfile(account.id)
                                : operation === 'unpublish' ? () => unpublishPublicProfile(account.id)
                                : operation === 'restrict' ? () => moderatePublicProfile(account.id, account.id, 'restrict', 'Concurrent restriction')
                                : operation === 'query' ? () => updatePublicProfile(account.id, { query: { ...body().query, period: { startMs: 2000, endMs: 3000 } } })
                                : operation === 'metadata_case' ? () => updatePublicProfile(account.id, { metadata: { bio: 'case' } })
                                : operation === 'metadata_accent' ? () => updatePublicProfile(account.id, { metadata: { bio: 'Cafe' } })
                                : () => updatePublicProfile(account.id, { policy });
                            peer = edit().finally(() => { peerSettled = true; });
                            await peer;
                            peerBeforeWrite = peerSettled;
                        }
                        return row;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await refreshPublicProfile(account.id, refreshBody(), publicationEnv, deps);
            await peer;
            expect(peer).toBeDefined();
            const row = await db.accountPublicProfile.findUnique({ where: { accountId: account.id } });
            if (operation === 'pause') expect(row?.state).toBe('paused');
            else if (operation === 'unpublish') expect(row).toBeNull();
            else if (operation === 'restrict') expect(row?.removedAt).not.toBeNull();
            else if (operation === 'query') {
                expect(JSON.parse(row!.queryJson!).period).toEqual({ startMs: 2000, endMs: 3000 });
                expect(row!.snapshotJson).toBeNull();
            } else if (operation === 'metadata_case') expect(JSON.parse(row!.metadataJson!).disclosure.bio).toBe('case');
            else if (operation === 'metadata_accent') expect(JSON.parse(row!.metadataJson!).disclosure.bio).toBe('Cafe');
            else {
                expect(JSON.parse(row!.policyJson!).fields.tokens).toBe(false);
                expect(row!.snapshotJson).not.toContain('987654321');
            }
            expect(peerBeforeWrite, 'ordinary refresh does not hold the Account exclusion').toBe(true);
            if (operation !== 'prune' && operation !== 'metadata_case' && operation !== 'metadata_accent') expect(result).toEqual({ kind: 'unavailable', reason:
                operation === 'restrict' ? 'restricted' : operation === 'query' ? 'query_mismatch' : 'not_published' });
            else expect(result).toMatchObject({ kind: 'updated' });
            console.info('PUBLIC_PROFILE_STALE_REFRESH_SCHEDULE', JSON.stringify({ operation, peerBeforeWrite }));
        } finally {
            db.$transaction = transaction;
            if (peer) await Promise.allSettled([peer]);
            await db.homeAdministrationEvent.deleteMany({ where: { targetId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('refreshes a publication with a null snapshot and withdraws its current row', async () => {
        const account = await fixture();
        const query = { ...body().query, period: { startMs: 2000, endMs: 3000 } };
        try {
            expect(await updatePublicProfile(account.id, { query })).toMatchObject({ kind: 'updated', record: { snapshot: null } });
            expect(await refreshPublicProfile(account.id, { query, snapshot: body().snapshot }, publicationEnv, deps)).toMatchObject({ kind: 'updated' });
            expect(await unpublishPublicProfile(account.id)).toEqual({ kind: 'updated', record: null });
            expect(await db.accountPublicProfile.findUnique({ where: { accountId: account.id } })).toBeNull();
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('projects current restriction and target-specific operator capability in Account detail on PostgreSQL', async () => {
        const target = await fixture();
        const admin = await db.account.create({ data: { homeRole: 'admin', encryptionMode: 'plain' } });
        try {
            expect(await inTx(tx => readHomeAccountDetailInTx(tx, { actorAccountId: admin.id, accountId: target.id,
                env: process.env, emailDeliveryReady: false }))).toMatchObject({ status: 'ok', result: { publicProfile: {
                restricted: false, managementCapability: { status: 'unavailable', reason: 'not_authorized' },
            } } });
            await db.account.update({ where: { id: target.id }, data: { homeRole: 'member' } });
            expect(await moderatePublicProfile(admin.id, target.id, 'restrict', 'Reported content')).toMatchObject({ kind: 'updated' });
            expect(await inTx(tx => readHomeAccountDetailInTx(tx, { actorAccountId: admin.id, accountId: target.id,
                env: process.env, emailDeliveryReady: false }))).toMatchObject({ status: 'ok', result: { publicProfile: {
                restricted: true, managementCapability: { status: 'available' },
            } } });
        } finally {
            await db.homeAdministrationEvent.deleteMany({ where: { targetId: target.id } });
            await db.account.deleteMany({ where: { id: { in: [target.id, admin.id] } } });
        }
    });

    it('refuses publication when identity withdrawal committed before admission', async () => {
        const account = await fixture();
        try {
            expect(await afterInitialCapture(account.id,
                () => inTx(tx => changeUsernameInTx(tx, account.id, { kind: 'release' })),
                () => publishPublicProfile(account.id, body(), publicationEnv, deps))).toEqual({ kind: 'unavailable', reason: 'username_required' });
            expect(await db.accountPublicProfile.findUnique({ where: { accountId: account.id } })).toBeNull();
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it.each(['moderate', 'reclaim'] as const)('commits %s behind a hot Account cursor', async operation => {
        const account = await fixture();
        try {
            const result = await afterInitialCapture(account.id, () => db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } }),
                async () => operation === 'moderate' ? moderatePublicProfile(account.id, account.id, 'restrict', 'Operator action')
                    : reclaimPublicProfileHandle(account.id, { accountId: account.id, username: account.username!, reason: 'Operator action', notice: 'Your handle was reclaimed.' }));
            expect(result).toMatchObject(operation === 'moderate' ? { kind: 'updated' } : { reclaimed: true });
            expect(await db.homeAdministrationEvent.count({ where: { targetId: account.id } })).toBe(1);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBeGreaterThan(1);
        } finally {
            await db.homeAdministrationEvent.deleteMany({ where: { targetId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(['moderate', 'reclaim'] as const)('rejects %s after operator authority is revoked before admission', async operation => {
        const account = await fixture();
        try {
            expect(await afterInitialCapture(account.id, () => db.account.update({ where: { id: account.id }, data: { homeRole: 'member' } }),
                async () => operation === 'moderate' ? moderatePublicProfile(account.id, account.id, 'restrict', 'Operator action')
                    : reclaimPublicProfileHandle(account.id, { accountId: account.id, username: account.username!, reason: 'Operator action', notice: 'Your handle was reclaimed.' })))
                .toEqual({ kind: 'forbidden' });
            expect(await db.homeAdministrationEvent.count({ where: { targetId: account.id } })).toBe(0);
            expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).removedAt).toBeNull();
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).username).toBe(account.username);
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it.skipIf(provider !== 'postgres')('holds a distinct operator authority through the moderation commit', async () => {
        const account = await fixture();
        await db.account.update({ where: { id: account.id }, data: { homeRole: 'member' } });
        const actor = await db.account.create({ data: { homeRole: 'owner', encryptionMode: 'plain' } });
        const transaction = db.$transaction;
        let peer: Promise<unknown> | undefined;
        let peerSettled = false;
        let blocked = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'account') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.account, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findUnique') return operation;
                    return async (...parameters: unknown[]) => {
                        const result: unknown = await Reflect.apply(operation, delegate, parameters);
                        const input = parameters[0] as { where?: { id?: string }; select?: { homeRole?: boolean } };
                        if (!peer && input.where?.id === actor.id && input.select?.homeRole) {
                            const [{ pid }] = await inner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            peer = db.account.update({ where: { id: actor.id }, data: { homeRole: 'member' } })
                                .finally(() => { peerSettled = true; });
                            while (!peerSettled) {
                                const waiting = await db.$queryRaw<Array<{ pid: number }>>`
                                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                                    AND ${pid} = ANY(pg_blocking_pids(pid))
                                `;
                                if (waiting.length > 0) { blocked = true; break; }
                            }
                            expect(blocked, 'operator demotion must wait behind current authority admission').toBe(true);
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await moderatePublicProfile(actor.id, account.id, 'restrict', 'Operator action')).toMatchObject({ kind: 'updated' });
            await peer;
            expect(blocked).toBe(true);
            expect((await db.account.findUniqueOrThrow({ where: { id: actor.id } })).homeRole).toBe('member');
            expect(await db.homeAdministrationEvent.count({ where: { targetId: account.id } })).toBe(1);
        } finally {
            db.$transaction = transaction;
            if (peer) await Promise.allSettled([peer]);
            await db.homeAdministrationEvent.deleteMany({ where: { targetId: account.id } });
            await db.account.deleteMany({ where: { id: { in: [account.id, actor.id] } } });
        }
    });
});
