import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from 'fastify';
import { ACCOUNT_CHANGES_PAGE_LIMIT_V1, ChangeEntrySchema, ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER, ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { buildProviderAccountUsageMaterialChangesV1, readProviderAccountUsageChangedRecordIdsV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/providerAccountUsagePrimitives';
import { z } from 'zod';

import { markAccountChanged, markAccountProjectionChanges } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { changesRoutes } from "./changesRoutes";

// The 0.2 reader (73c533b470 packages/protocol/src/changes.ts) rejects extra
// response fields and stops its catch-up when changes.length < limit.
const predecessorPage = z.strictObject({ changes: z.array(ChangeEntrySchema), nextCursor: z.number().int().nonnegative() });

async function drainPredecessorFeed(app: FastifyInstance, accountId: string, limit = ACCOUNT_CHANGES_PAGE_LIMIT_V1) {
    const pages = [];
    let after = 0;
    for (;;) {
        const response = await app.inject({ method: 'GET', url: `/v2/changes?after=${after}&limit=${limit}`,
            headers: { 'x-test-user-id': accountId } });
        expect(response.statusCode).toBe(200);
        const page = predecessorPage.parse(response.json());
        pages.push(page);
        if (page.changes.length < limit) return pages;
        expect(page.nextCursor).toBeGreaterThan(after);
        after = page.nextCursor;
    }
}

const COMPATIBILITY_HIDDEN_KINDS = ['machinePool', 'pluginDomain', 'savedSecretResource'] as const;

async function publishHiddenChange(tx: Tx, accountId: string, kind: typeof COMPATIBILITY_HIDDEN_KINDS[number]) {
    if (kind !== 'pluginDomain') return markAccountChanged(tx, { accountId, kind, entityId: `${kind}-fixture` });
    return markAccountChanged(tx, { accountId, kind, entityId: 'pluginDomain/example.tasks/data-collection/tasks',
        hint: { pluginDomain: 'dataCollection', pluginId: 'example.tasks', collectionId: 'tasks',
            contractDigest: 'a'.repeat(43), revision: 1, full: true } });
}

describe("changesRoutes automation changes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-changes-automation-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("returns automation changes through /v2/changes", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-changes-automation" },
            select: { id: true },
        });

        const changedAtCursor = await inTx(async (tx) => {
            return await markAccountChanged(tx, {
                accountId: account.id,
                kind: "automation",
                entityId: "automation-1",
                hint: { reason: "run-updated" },
            });
        });

        await withAuthenticatedTestApp(
            (app) => changesRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/changes?after=0&limit=50",
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(body.nextCursor).toBe(changedAtCursor.resolveCursor());
                expect(body.changes).toEqual([
                    expect.objectContaining({
                        kind: "automation",
                        entityId: "automation-1",
                        hint: { reason: "run-updated" },
                    }),
                ]);
            },
        );
    });

    it('keeps a quota invalidation narrow when a page ends at its global row', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const recordId = buildProviderAccountUsageRecordId({ providerId: 'claude', accountSubjectId: 'account',
            subjectKind: 'account', quotaScope: 'account' });
        const [global, exact] = buildProviderAccountUsageMaterialChangesV1(recordId);
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: account.id, kind: 'automation', entityId: 'before' });
            await markAccountChanged(tx, { accountId: account.id, ...global });
            await markAccountChanged(tx, { accountId: account.id, ...exact });
            await markAccountChanged(tx, { accountId: account.id, kind: 'automation', entityId: 'after' });
        });
        await withAuthenticatedTestApp(changesRoutes, async app => {
            const read = async (after: number, limit: number) => {
                const response = await app.inject({ method: 'GET', url: `/v2/changes?after=${after}&limit=${limit}`,
                    headers: { 'x-test-user-id': account.id,
                        [ACCOUNT_STORED_CONTENT_COMPATIBILITY_HTTP_HEADER]: String(ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION) } });
                expect(response.statusCode).toBe(200);
                return ChangesResponseSchema.parse(response.json());
            };
            const before = await read(0, 1);
            expect(before.changes.map(change => change.entityId)).toEqual(['before']);
            const boundary = await read(0, 2);
            expect(boundary).toEqual(before);
            for (const limit of [1, 2]) {
                const quota = await read(boundary.nextCursor, limit);
                expect(readProviderAccountUsageChangedRecordIdsV1(quota.changes)).toEqual([recordId]);
                expect(quota.full).toBe(true);
                expect((await read(quota.nextCursor, 2)).changes.map(change => change.entityId)).toEqual(['after']);
            }
        });
    });

    it.each([false, true])('drains a trailing Session in one predecessor catch-up when a quota pair straddles a full page (hidden row: %s)', async hidden => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const recordId = buildProviderAccountUsageRecordId({ providerId: 'claude', accountSubjectId: 'account',
            subjectKind: 'account', quotaScope: 'account' });
        const [global, exact] = buildProviderAccountUsageMaterialChangesV1(recordId);
        const limit = ACCOUNT_CHANGES_PAGE_LIMIT_V1;
        await inTx(async tx => {
            await markAccountProjectionChanges(tx, 'machine', new Map(Array.from({ length: limit - 1 },
                (_, index) => [`machine-${index}`, [account.id]] as const)));
            if (hidden) await publishHiddenChange(tx, account.id, 'machinePool');
            await markAccountChanged(tx, { accountId: account.id, ...global });
            await markAccountChanged(tx, { accountId: account.id, ...exact });
            await markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: 'trailing-session', hint: { pendingCount: 2, pendingVersion: 1 } });
        });
        await withAuthenticatedTestApp(changesRoutes, async app => {
            const pages = await drainPredecessorFeed(app, account.id);
            expect(pages.map(page => page.changes.length)).toEqual([limit, 2]);
            expect(pages.flatMap(page => page.changes).slice(-3).map(change => change.entityId))
                .toEqual([global.entityId, exact.entityId, 'trailing-session']);
            expect(pages.at(-1)?.nextCursor).toBe(limit + 2 + Number(hidden));
        });
    });

    it.each(COMPATIBILITY_HIDDEN_KINDS)('fills the predecessor page across a hidden %s row', async kind => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const limit = ACCOUNT_CHANGES_PAGE_LIMIT_V1;
        await inTx(async tx => {
            await markAccountProjectionChanges(tx, 'machine', new Map(Array.from({ length: limit - 1 },
                (_, index) => [`machine-${index}`, [account.id]] as const)));
            await publishHiddenChange(tx, account.id, kind);
            await markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: 'trailing-session' });
        });
        await withAuthenticatedTestApp(changesRoutes, async app => {
            const pages = await drainPredecessorFeed(app, account.id);
            expect(pages.map(({ changes, nextCursor }) => [changes.length, nextCursor])).toEqual([[limit, limit + 1], [0, limit + 1]]);
            expect(pages.flatMap(page => page.changes).find(change => change.kind === kind)).toBeUndefined();
            expect(pages.flatMap(page => page.changes).filter(change => change.kind === 'session').map(change => change.entityId))
                .toEqual(['trailing-session']);
        });
    });

    it.each([false, true])('advances through an all-hidden tail in one predecessor page (visible prefix: %s)', async visible => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const finalChange = await inTx(async tx => {
            if (visible) await markAccountChanged(tx, { accountId: account.id, kind: 'machine', entityId: 'before' });
            await publishHiddenChange(tx, account.id, 'machinePool');
            await publishHiddenChange(tx, account.id, 'pluginDomain');
            return publishHiddenChange(tx, account.id, 'savedSecretResource');
        });
        await withAuthenticatedTestApp(changesRoutes, async app => {
            const pages = await drainPredecessorFeed(app, account.id, 2);
            expect(pages).toHaveLength(1);
            expect(pages[0]?.changes.map(change => change.entityId)).toEqual(visible ? ['before'] : []);
            expect(pages[0]?.nextCursor).toBe(finalChange.resolveCursor());
        });
    });

    it("keeps a Collection full reread broad when a later exact change coalesces before polling", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-changes-collection-full" },
            select: { id: true },
        });
        const pluginId = "example.tasks";
        const collectionId = "tasks";
        const firstDigest = "a".repeat(43);
        const laterDigest = "b".repeat(43);
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;

        const fullCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: firstDigest,
                    revision: 4,
                    full: true,
                },
            })
        ));
        const exactCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: laterDigest,
                    revision: 5,
                    rowIds: ["task-1"],
                },
            })
        ));

        expect(exactCursor.resolveCursor()).toBeGreaterThan(fullCursor.resolveCursor());
        await withAuthenticatedTestApp(
            (app) => changesRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/changes?after=0&limit=50",
                    headers: {
                        "x-test-user-id": account.id,
                        "x-happier-account-stored-content-protocol": "3",
                    },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({
                    changes: [{
                        cursor: exactCursor.resolveCursor(),
                        kind: "pluginDomain",
                        entityId,
                        changedAt: expect.any(Number),
                        hint: {
                            pluginDomain: "dataCollection",
                            pluginId,
                            collectionId,
                            contractDigest: laterDigest,
                            revision: 5,
                            full: true,
                        },
                    }],
                    nextCursor: exactCursor.resolveCursor(),
                });
            },
        );
    });
});
