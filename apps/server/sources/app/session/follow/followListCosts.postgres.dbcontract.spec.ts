import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { type Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { encodeFollowListCursorV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';
import { listAccountSessionFollows } from './accountFollowService';
import { listSessionFollowSources } from './sessionFollowEdgeService';
import { sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';

const authentication = createPresentUserSessionAccessAuthentication();

/** Observe the real database boundary without eagerly consuming lazy transaction queries. */
async function measure<T>(run: () => Promise<T>, betweenSnapshots?: () => Promise<void>) {
    let followRows = 0, sessionReads = 0, snapshots = 0;
    const observe = (tx: Tx): Tx => new Proxy(tx, { get(target, property, receiver) {
        const delegate: unknown = Reflect.get(target, property, receiver);
        if (typeof delegate === 'function') return delegate.bind(target);
        if (!['accountSessionFollow', 'sessionFollowEdge', 'session'].includes(String(property))
            || !delegate || typeof delegate !== 'object') return delegate;
        return new Proxy(delegate, { get(owner, operation, delegateReceiver) {
            const method: unknown = Reflect.get(owner, operation, delegateReceiver);
            if (typeof method !== 'function' || !String(operation).startsWith('find')) return method;
            return (...args: unknown[]) => observeLazyPrismaQuery(Reflect.apply(method, owner, args),
                () => ({ started() {}, settled() {} }), undefined, async consume => {
                    const result = await consume();
                    if (property === 'session') sessionReads++;
                    else followRows += Array.isArray(result) ? result.length : result ? 1 : 0;
                    return result;
                });
        } });
    } });
    const original = db.$transaction;
    db.$transaction = new Proxy(original, { async apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
        const result = await Reflect.apply(target, receiver, [(tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
        if (++snapshots === 1) await betweenSnapshots?.();
        return result;
    } });
    try { return { result: await run(), counts: { followRows, sessionReads } }; }
    finally { db.$transaction = original; }
}

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Follow list demand (PostgreSQL)', () => {
    const accounts: string[] = [];
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        vi.stubEnv('HANDY_MASTER_SECRET', 'follow-list-cost-disposable-fixture');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        await initEncrypt();
    });
    afterAll(async () => {
        await db.session.deleteMany({ where: { accountId: { in: accounts } } });
        await db.account.deleteMany({ where: { id: { in: accounts } } });
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });
    async function fixture(unrelated = 0) {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accounts.push(owner.id);
        const ids = Array.from({ length: unrelated + 3 }, () => randomUUID());
        await db.session.createMany({ data: ids.map(id => ({ id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain' })) });
        const [selected, destination, another] = ids;
        const followed = [selected!, another!, ...ids.slice(3)];
        // Retained Session rows may have a null sourceKey; current rows may carry the canonical key.
        await db.accountSessionFollow.createMany({ data: followed.map((sessionId, i) => ({ accountId: owner.id,
            sessionId, sourceKey: i % 2 === 0 ? null : sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId }), following: true })) });
        const source = { kind: 'execution_run' as const, sessionId: selected!, runId: 'selected-run' };
        await db.accountSessionFollow.create({ data: { accountId: owner.id, sourceKey: sourceKeyForSessionFollowSourceV1(source),
            sourceExecutionRunSessionId: selected, sourceExecutionRunId: source.runId, following: true, followPolicy: '{"preset":"important"}' } });
        await db.sessionFollowEdge.createMany({ data: followed.map(sourceSessionId => ({ sourceSessionId,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sourceSessionId }),
            destinationSessionId: destination!, policyJson: '{"preset":"important"}' })) });
        return { accountId: owner.id, authentication, selected: selected!, destinationSessionId: destination!, another: another!, runSource: source, total: followed.length + 1 };
    }
    it('selects an exact source Session and its Runs without reading or admitting 1,000 unrelated Follows', async () => {
        const f = await fixture(1_000);
        const input = { ...f, source: { kind: 'session' as const, sessionId: f.selected } };
        const measured = await measure(() => listAccountSessionFollows(input));
        console.info('FOLLOW_LIST_COST exact-session', measured.counts);
        expect(measured.counts.followRows).toBeLessThanOrEqual(2);
        expect(measured.counts.sessionReads).toBeLessThan(20);
        expect(measured.result).toMatchObject({ ok: true, value: { follows: expect.arrayContaining([
            expect.objectContaining({ sessionId: f.selected }), expect.objectContaining({ source: f.runSource }),
        ]) } });
        if (!measured.result.ok) throw new Error(measured.result.error);
        expect(measured.result.value.follows).toHaveLength(2);
    });
    it('selects Run kinds before pagination without acquiring 2,000 unrelated Follows', async () => {
        const f = await fixture(2_000);
        const input = { ...f, sourceKinds: ['execution_run' as const, 'workflow_run' as const], limit: 1 };
        const first = await measure(() => listAccountSessionFollows(input));
        console.info('FOLLOW_LIST_COST run-kind', first.counts);
        expect(first.result).toMatchObject({ ok: true, value: { follows: [expect.objectContaining({ source: f.runSource })] } });
        expect(first.counts.followRows).toBe(1);
        expect(first.counts.sessionReads).toBeLessThan(20);
        if (!first.result.ok) throw new Error(first.result.error);
        expect(first.result.value.continuation).toBeUndefined();

        const workflow = await db.automationRun.create({ data: { accountId: f.accountId, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null, workflowAcceptedSnapshotEnvelope: '{}',
            state: 'running', workflowCustodyState: 'pending', scheduledAt: new Date(), dueAt: new Date(), revision: 1 } });
        const workflowSource = { kind: 'workflow_run' as const, runId: workflow.id };
        await db.accountSessionFollow.create({ data: { accountId: f.accountId,
            sourceKey: sourceKeyForSessionFollowSourceV1(workflowSource), sourceWorkflowRunId: workflow.id,
            following: true, followPolicy: '{"preset":"important"}' } });
        const page = await measure(() => listAccountSessionFollows(input));
        if (!page.result.ok) throw new Error(page.result.error);
        expect(page.counts.followRows).toBe(2);
        expect(page.result.value.continuation).toEqual(expect.any(String));
        const next = await listAccountSessionFollows({ ...input,
            sourceKinds: ['workflow_run', 'execution_run', 'execution_run'], cursor: page.result.value.continuation });
        if (!next.ok) throw new Error(next.error);
        expect([...page.result.value.follows, ...next.value.follows].map(row => 'source' in row ? row.source : null))
            .toEqual([f.runSource, workflowSource]);
        expect(next.value.continuation).toBeUndefined();
        expect(await listAccountSessionFollows({ ...f, cursor: page.result.value.continuation }))
            .toEqual({ ok: false, error: 'invalid_parameters' });
        expect(await listAccountSessionFollows({ ...input, sourceKinds: ['workflow_run'], cursor: page.result.value.continuation }))
            .toEqual({ ok: false, error: 'invalid_parameters' });
        await db.accountSessionFollow.deleteMany({ where: { accountId: f.accountId,
            OR: [{ sourceExecutionRunSessionId: f.selected }, { sourceWorkflowRunId: workflow.id }] } });
        const empty = await measure(() => listAccountSessionFollows(input));
        expect(empty.result).toEqual({ ok: true, value: { follows: [] } });
        expect(empty.counts.followRows).toBe(0);
        expect(empty.counts.sessionReads).toBe(0);
    });
    it('pages candidates before admission for both owners and keeps complete default and continuation results', async () => {
        const f = await fixture(1_000);
        const first = await measure(() => listAccountSessionFollows({ ...f, limit: 1 }));
        const sources = await measure(() => listSessionFollowSources({ ...f, limit: 1 }));
        console.info('FOLLOW_LIST_COST page', { account: first.counts, session: sources.counts });
        expect(first.counts.followRows).toBeLessThanOrEqual(4);
        expect(first.counts.sessionReads).toBeLessThan(20);
        expect(sources.counts.followRows).toBeLessThanOrEqual(2);
        expect(sources.counts.sessionReads).toBeLessThan(20);
        expect(first.result).toMatchObject({ ok: true, value: { follows: expect.any(Array), continuation: expect.any(String) } });
        if (!first.result.ok) throw new Error(first.result.error);
        const remaining = await listAccountSessionFollows({ ...f, cursor: first.result.value.continuation });
        const all = await listAccountSessionFollows(f);
        if (!remaining.ok || !all.ok) throw new Error('Expected admitted list');
        expect(all.value.follows).toHaveLength(f.total);
        expect([...first.result.value.follows, ...remaining.value.follows]).toEqual(all.value.follows);
    });
    it('refuses continuation when the selection changes and still reads the next matching page', async () => {
        const f = await fixture();
        const input = { ...f, source: { kind: 'session' as const, sessionId: f.selected }, limit: 1 };
        const first = await listAccountSessionFollows(input);
        if (!first.ok) throw new Error(first.error);
        expect(first.value.continuation).toEqual(expect.any(String));
        const next = await listAccountSessionFollows({ ...input, cursor: first.value.continuation });
        expect(next).toMatchObject({ ok: true, value: { follows: [expect.any(Object)] } });
        expect(await listAccountSessionFollows({ ...input, source: { kind: 'session', sessionId: f.another }, cursor: first.value.continuation }))
            .toEqual({ ok: false, error: 'invalid_parameters' });
        expect(await listAccountSessionFollows({ ...f, cursor: first.value.continuation }))
            .toEqual({ ok: false, error: 'invalid_parameters' });
    });
    it.each([
        { owner: 'account', filtered: false }, { owner: 'account', filtered: true },
        { owner: 'destination', filtered: false }, { owner: 'destination', filtered: true },
    ] as const)('rejects an unsealed canonical V1 cursor before reading Follow rows ($owner, filtered=$filtered)', async ({ owner, filtered }) => {
        const f = await fixture();
        const source = filtered ? { kind: 'session' as const, sessionId: f.selected } : undefined;
        const scope = JSON.stringify([f.accountId, 'following',
            ...(owner === 'destination' ? [f.destinationSessionId] : []), ...(source ? [source] : [])]);
        const cursor = encodeFollowListCursorV1(scope, sourceKeyForSessionFollowSourceV1(f.runSource));
        const input = { ...f, source, cursor };
        const measured = owner === 'account'
            ? await measure(() => listAccountSessionFollows(input))
            : await measure(() => listSessionFollowSources(input));
        expect(measured.result).toEqual({ ok: false, error: 'invalid_parameters' });
        expect(measured.counts).toEqual({ followRows: 0, sessionReads: 0 });
    });
    it('keeps exact Run identity and source selection on every destination continuation', async () => {
        const f = await fixture();
        const runs = [f.runSource, { ...f.runSource, runId: 'another-run' }];
        await db.sessionFollowEdge.createMany({ data: runs.map(source => ({ sourceKey: sourceKeyForSessionFollowSourceV1(source),
            sourceExecutionRunSessionId: source.sessionId, sourceExecutionRunId: source.runId,
            destinationSessionId: f.destinationSessionId, policyJson: '{"preset":"important"}' })) });
        const selected = { kind: 'session' as const, sessionId: f.selected };
        const all = await listSessionFollowSources({ ...f, source: selected });
        if (!all.ok) throw new Error(all.error);
        expect(all.value.sources).toHaveLength(3);
        const paged: typeof all.value.sources[number][] = [];
        let cursor: string | undefined;
        do {
            const page = await listSessionFollowSources({ ...f, source: selected, cursor, limit: 1 });
            if (!page.ok) throw new Error(page.error);
            paged.push(...page.value.sources);
            cursor = page.value.continuation;
            if (cursor) expect(await listSessionFollowSources({ ...f, source: f.runSource, cursor, limit: 1 }))
                .toEqual({ ok: false, error: 'invalid_parameters' });
        } while (cursor);
        expect(paged).toEqual(all.value.sources);
        expect(await listSessionFollowSources({ ...f, source: f.runSource, limit: 1 }))
            .toMatchObject({ ok: true, value: { sources: [expect.objectContaining({ source: f.runSource })] } });
        const exact = await listAccountSessionFollows({ ...f, source: f.runSource });
        if (!exact.ok) throw new Error(exact.error);
        expect(exact.value.follows).toHaveLength(1);
        expect(exact.value.follows[0]).toMatchObject({ source: f.runSource });
    });
    it('finishes an admitted list after access withdrawal and excludes rows on the next request', async () => {
        const f = await fixture();
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accounts.push(viewer.id);
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.selected, createdByAccountId: f.accountId, accountId: viewer.id, accessLevel: 'view' } });
        await db.accountSessionFollow.create({ data: { accountId: viewer.id, sessionId: f.selected, following: true } });
        await db.accountSessionFollow.create({ data: { accountId: viewer.id, sourceKey: sourceKeyForSessionFollowSourceV1(f.runSource),
            sourceExecutionRunSessionId: f.selected, sourceExecutionRunId: f.runSource.runId, followPolicy: '{"preset":"important"}' } });
        const input = { accountId: viewer.id, authentication, source: { kind: 'session' as const, sessionId: f.selected }, limit: 1 };
        const measured = await measure(() => listAccountSessionFollows(input), async () => {
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: f.selected, accountId: viewer.id } });
        });
        expect(measured.result).toMatchObject({ ok: true, value: { follows: [expect.objectContaining({
            source: f.runSource,
        })], continuation: expect.any(String) } });
        expect(await listAccountSessionFollows(input)).toMatchObject({ ok: true, value: { follows: [] } });
        await db.sessionGrant.createMany({ data: ([f.selected, f.destinationSessionId].map(sessionId => ({ sessionId,
            createdByAccountId: f.accountId, accountId: viewer.id, accessLevel: 'view' }))).map(data => ({ ...data, principalKind: 'account' })) });
        await db.sessionFollowEdge.create({ data: { sourceKey: sourceKeyForSessionFollowSourceV1(f.runSource),
            sourceExecutionRunSessionId: f.selected, sourceExecutionRunId: f.runSource.runId,
            destinationSessionId: f.destinationSessionId, policyJson: '{"preset":"important"}' } });
        const sources = await measure(() => listSessionFollowSources({ ...input, destinationSessionId: f.destinationSessionId }), async () => {
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: f.selected, accountId: viewer.id } });
        });
        expect(sources.result).toMatchObject({ ok: true, value: { sources: [expect.objectContaining({
            source: f.runSource,
        })], continuation: expect.any(String) } });
        expect(await listSessionFollowSources({ ...input, destinationSessionId: f.destinationSessionId }))
            .toMatchObject({ ok: true, value: { sources: [] } });
    });
    it('does not disclose an unadmitted source identity through the candidate continuation', async () => {
        const f = await fixture();
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accounts.push(viewer.id);
        const firstSourceId = [f.selected, f.another].sort()[0]!;
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.destinationSessionId,
            createdByAccountId: f.accountId, accountId: viewer.id, accessLevel: 'view' } });
        const page = await listSessionFollowSources({ accountId: viewer.id, authentication,
            destinationSessionId: f.destinationSessionId, limit: 1 });
        expect(page).toMatchObject({ ok: true, value: { sources: [], continuation: expect.any(String) } });
        if (!page.ok) throw new Error(page.error);
        expect(page.value.continuation).not.toContain(firstSourceId);
        const next = await listSessionFollowSources({ accountId: viewer.id, authentication,
            destinationSessionId: f.destinationSessionId, cursor: page.value.continuation, limit: 1 });
        expect(next).toEqual({ ok: true, value: { sources: [] } });
    });
});
