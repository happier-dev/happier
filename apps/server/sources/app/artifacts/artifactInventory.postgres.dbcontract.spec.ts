import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { listArtifactHeadersForCallerInTx } from './artifactAccessService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Artifact inventory PostgreSQL query work', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('selects exact kind sets before paging with no unrelated content reads', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const template = { accountId: owner.id, header: bytes({ kind: 'account_notice.v1' }),
            body: new Uint8Array([0xff]), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 };
        await db.artifact.createMany({ data: Array.from({ length: 2500 }, () => ({ ...template,
            id: randomUUID(), kind: 'v1:other:unrelated.v1' })) });
        const selected = await db.artifact.create({ data: { ...template, id: randomUUID(),
            kind: 'v1:other:account_notice.v1', updatedAt: new Date(0) } });
        const queries: Array<{ ids: string[]; bodies: boolean }> = [];
        await db.$transaction(async tx => {
            const observed = new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'artifact') {
                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                return new Proxy(tx.artifact, { get(delegate, operation, delegateReceiver) {
                    const value = Reflect.get(delegate, operation, delegateReceiver);
                    if (operation !== 'findMany') return value;
                    return async (...args: Parameters<typeof tx.artifact.findMany>) => {
                        const rows = await tx.artifact.findMany(...args);
                        queries.push({ ids: rows.map(row => row.id), bodies: args[0]?.select?.body === true });
                        return rows;
                    };
                } });
            } });
            const page = await listArtifactHeadersForCallerInTx(observed, { actorAccountId: owner.id,
                kinds: ['account_notice.v1', ...Array.from({ length: 130 }, (_, index) => `absent.${index}.v1`)], limit: 1, cursor: null });
            expect(page).toMatchObject([{ id: selected.id, kind: 'other', kindHint: 'account_notice.v1' }]);
            expect(page).toHaveLength(1);
        }, { isolationLevel: 'RepeatableRead' });
        expect(new Set(queries.flatMap(query => query.ids))).toEqual(new Set([selected.id]));
        expect(queries.some(query => query.bodies)).toBe(false);
    });

    it('filters kinds and unclassified rows through the same current grant admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const data = (accountId: string, kind: 'skill' | 'prompt' | null) => ({ id: randomUUID(), accountId, kind,
            header: bytes({ title: 'Coarse inventory' }), body: bytes({ body: 'Private content' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 });
        const skill = await db.artifact.create({ data: data(owner.id, 'skill') });
        await db.artifact.create({ data: data(owner.id, 'prompt') });
        const unknown = await db.artifact.create({ data: data(owner.id, null) });
        await db.artifact.create({ data: data(stranger.id, null) });
        await db.artifactGrant.createMany({ data: [skill, unknown].map(artifact => ({ principalKind: 'account', artifactId: artifact.id,
            accountId: recipient.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
        await db.$transaction(async tx => {
            const rows = await listArtifactHeadersForCallerInTx(tx, { actorAccountId: recipient.id, kind: 'skill', limit: 500, cursor: null });
            expect(rows).toMatchObject([{ id: skill.id, kind: 'skill', access: 'view' }]);
            expect(rows).toHaveLength(1);
            const unclassified = await listArtifactHeadersForCallerInTx(tx, { actorAccountId: recipient.id, kind: null, limit: 1, cursor: null });
            expect(unclassified.map(row => row.id)).toEqual([unknown.id]);
        }, { isolationLevel: 'RepeatableRead' });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': recipient.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const filtered = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=1', headers });
            expect(filtered.statusCode, filtered.body).toBe(200);
            expect(filtered.json()).toMatchObject({ items: [{ id: skill.id, kind: 'skill' }], hasUnclassified: true });
            await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: unknown.id, accountId: recipient.id } });
            const afterRevocation = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=1', headers });
            expect(afterRevocation.statusCode, afterRevocation.body).toBe(200);
            expect(afterRevocation.json()).toMatchObject({ items: [{ id: skill.id }], hasUnclassified: false });
        });
        await db.$transaction(async tx => {
            expect(await listArtifactHeadersForCallerInTx(tx, { actorAccountId: recipient.id, kind: null, limit: 1, cursor: null })).toEqual([]);
        }, { isolationLevel: 'RepeatableRead' });
    });

    it('resolves the caller grant candidates in the database for a filtered page and its completeness count', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const data = (accountId: string, kind: string | null) => ({ id: randomUUID(), accountId, kind,
            header: bytes({ title: 'Inventory' }), body: bytes({ body: 'Private content' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 });
        const skill = await db.artifact.create({ data: data(owner.id, 'skill') });
        const legacy = await db.artifact.create({ data: data(owner.id, null) });
        await db.artifactGrant.createMany({ data: [skill, legacy].map(artifact => ({ principalKind: 'account', artifactId: artifact.id,
            accountId: recipient.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': recipient.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            // Count the real Prisma requests the route issues; all IO stays real.
            let grantCandidateReads = 0;
            const stop = observePrismaRequests(db, { before(request) {
                if (request.model === 'ArtifactGrant' && request.action === 'findMany') grantCandidateReads += 1;
            } });
            let filtered;
            try { filtered = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=50', headers }); } finally { stop(); }
            expect(filtered.statusCode, filtered.body).toBe(200);
            // The received legacy row still marks the page partial through the same admission.
            expect(filtered.json()).toMatchObject({ items: [{ id: skill.id, kind: 'skill' }], hasUnclassified: true });
            // Each grant arm is a semi-join inside the page queries; no grant row reaches the server.
            expect(grantCandidateReads).toBe(0);
        });
    });

    it('keeps a populated page near batched relation work when PostgreSQL compiles the access query', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const artifactData = (accountId: string) => ({ id: randomUUID(), accountId,
            header: bytes({ title: 'Inventory document' }), body: bytes({ body: 'Retained content' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1, seq: 1 });
        await db.artifact.createMany({ data: Array.from({ length: 2500 }, () => artifactData(owner.id)) });
        const shared = await db.artifact.create({ data: artifactData(other.id) });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: shared.id, accountId: owner.id,
            accessLevel: 'view', createdByAccountId: other.id } });

        type Variant = 'owner' | 'batched-control';
        let variant: Variant = 'owner';
        const durations: Record<Variant, number[]> = { owner: [], 'batched-control': [] };
        const measured = db.$extends({ query: { artifact: { async findMany({ args, query }) {
            // The content page, not the id-only received-arm positions.
            const page = args.take !== undefined && args.select?.header === true;
            const started = performance.now();
            const rows = await query({ ...args, ...(page && variant === 'batched-control'
                ? { relationLoadStrategy: 'query' as const } : {}) });
            if (page) durations[variant].push(performance.now() - started);
            return rows;
        } } } });
        // Preserve the generated client's contract while forwarding real queries,
        // as the canonical shared-QA diagnostics adapter does in storage/prisma.
        const client = new Proxy(db, {
            get(_target, property) {
                const value = Reflect.get(measured, property, measured);
                return typeof value === 'function' ? value.bind(measured) : value;
            },
        });
        const snapshots = [];
        for (const selected of ['owner', 'batched-control', 'batched-control', 'owner', 'owner', 'batched-control'] as const) {
            variant = selected;
            snapshots.push(await client.$transaction(async tx => {
                // The observed production plan crossed all three JIT thresholds
                // (129 functions; 914 ms compilation / 948 ms execution). Force
                // that same engine path without needing production cardinalities.
                await tx.$executeRawUnsafe('SET LOCAL jit_above_cost = 0');
                await tx.$executeRawUnsafe('SET LOCAL jit_inline_above_cost = 0');
                await tx.$executeRawUnsafe('SET LOCAL jit_optimize_above_cost = 0');
                return await listArtifactHeadersForCallerInTx(tx, { actorAccountId: owner.id, limit: 500, cursor: null });
            }, { isolationLevel: 'RepeatableRead' }));
        }
        expect(snapshots[0]).toHaveLength(500);
        expect(snapshots[0].find(row => row.id === shared.id)?.access).toBe('view');
        for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        expect(durations.owner).toHaveLength(3);
        expect(durations['batched-control']).toHaveLength(3);
        // Relative regression guard against the same database and projection,
        // not a new product deadline. The reproduced owner exceeded this margin.
        expect(median(durations.owner), JSON.stringify(durations))
            .toBeLessThan(median(durations['batched-control']) * 2);
    });
});
