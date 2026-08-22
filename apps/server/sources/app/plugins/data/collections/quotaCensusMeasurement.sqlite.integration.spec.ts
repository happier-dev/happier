import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import {
    readPluginCollectionAccountActivationUsageInTx,
    readPluginCollectionAccountUsageInTx,
} from "./quota";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const ACCOUNT_ID = "quota-census-measurement-account";
const PLUGIN_ID = "example.census";
const COLLECTION_IDS = ["tasks", "notes"] as const;
const ROWS_PER_COLLECTION = Number(process.env.CENSUS_ROWS ?? "1000");

/**
 * The census walks the whole live Account twice per mutation batch, so its
 * round-trip count is a product contract, not an implementation detail: a page
 * size taken from the inbound `maxBatchRows` limit (100 by default, 1 when an
 * operator lowers it) turned a two-query census into hundreds of sequential
 * queries inside the open write transaction. Once the census has measured real
 * rows it must read at least this many per round trip, whatever that inbound
 * limit says.
 */
const MIN_STEADY_STATE_CENSUS_PAGE_ROWS = 500;

function maximumCensusPagesFor(liveRows: number): number {
    // One page sized from the row-byte ceiling, the steady-state pages, and the
    // short page that ends the walk.
    return Math.ceil(liveRows / MIN_STEADY_STATE_CENSUS_PAGE_ROWS) + 2;
}

function digestFor(collectionId: string): string {
    return `${collectionId}${"0".repeat(43)}`.slice(0, 43);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

type CountingTx = { tx: Tx; counts: Map<string, number>; total(): number };

function countingTx(real: Tx): CountingTx {
    const counts = new Map<string, number>();
    const proxy = new Proxy(real as unknown as Record<string, unknown>, {
        get(target, model: string) {
            const delegate = Reflect.get(target, model);
            if (typeof model !== "string" || model.startsWith("$") || delegate === undefined || delegate === null) {
                return delegate;
            }
            if (typeof delegate !== "object") return delegate;
            return new Proxy(delegate as Record<string, unknown>, {
                get(modelTarget, operation: string) {
                    const fn = Reflect.get(modelTarget, operation);
                    if (typeof fn !== "function") return fn;
                    return (...args: unknown[]) => {
                        const key = `${model}.${operation}`;
                        counts.set(key, (counts.get(key) ?? 0) + 1);
                        return (fn as (...a: unknown[]) => unknown).apply(modelTarget, args);
                    };
                },
            });
        },
    });
    return {
        tx: proxy as unknown as Tx,
        counts,
        total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    };
}

describe("plugin collection quota census — measurement", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-quota-census-measure-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        for (const [index, collectionId] of COLLECTION_IDS.entries()) {
            const contract = await db.pluginCollectionContract.create({
                data: {
                    pluginId: PLUGIN_ID,
                    collectionId,
                    schemaVersion: 1,
                    contractDigest: digestFor(collectionId),
                    normalizedSchema: toPrismaJson({ type: "object", properties: { id: { type: "string" } } }),
                    indexes: toPrismaJson([]),
                    relations: toPrismaJson([]),
                    privacyProjection: toPrismaJson({ serverReadable: ["id"] }),
                },
                select: { id: true },
            });
            const rows = Array.from({ length: ROWS_PER_COLLECTION }, (_, rowIndex) => ({
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId,
                rowId: `row-${String(rowIndex).padStart(6, "0")}`,
                schemaVersion: 1,
                revision: 1,
                contractId: contract.id,
                contractDigest: digestFor(collectionId),
                contentEnvelope: toPrismaJson({ t: "plain", v: { id: `row-${rowIndex}`, body: "x".repeat(200 + index) } }),
            }));
            for (let offset = 0; offset < rows.length; offset += 500) {
                await db.pluginCollectionRow.createMany({ data: rows.slice(offset, offset + 500) });
            }
        }
        // Add a second tenant so the planner cannot treat accountId as trivially selective.
        await db.account.create({ data: { id: `${ACCOUNT_ID}-other`, publicKey: null, encryptionMode: "plain" } });
        const otherContract = await db.pluginCollectionContract.findFirstOrThrow({ select: { id: true, contractDigest: true } });
        const otherRows = Array.from({ length: ROWS_PER_COLLECTION * 2 }, (_, rowIndex) => ({
            accountId: `${ACCOUNT_ID}-other`,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_IDS[0],
            rowId: `other-${String(rowIndex).padStart(6, "0")}`,
            schemaVersion: 1,
            revision: 1,
            contractId: otherContract.id,
            contractDigest: otherContract.contractDigest,
            contentEnvelope: toPrismaJson({ t: "plain", v: { id: `other-${rowIndex}` } }),
        }));
        for (let offset = 0; offset < otherRows.length; offset += 500) {
            await db.pluginCollectionRow.createMany({ data: otherRows.slice(offset, offset + 500) });
        }
    }, 300_000);

    afterAll(async () => {
        await harness.close();
    });

    it("serves the Account-live keyset walk from its supporting index", async () => {
        const plan = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
            'EXPLAIN QUERY PLAN SELECT "id" FROM "PluginCollectionRow"'
            + ' WHERE "accountId" = ? AND "deletedAt" IS NULL AND "id" > ?'
            + ' ORDER BY "accountId" ASC, "deletedAt" ASC, "id" ASC LIMIT 100',
            ACCOUNT_ID,
            "",
        );
        const detail = plan.map((step) => String(step.detail ?? "")).join(" | ");
        // Without `PluginCollectionRow_account_live_scan_idx` this same walk
        // either sorts the Account's whole live set per page or scans the
        // primary key across every other tenant.
        expect(detail).toContain("PluginCollectionRow_account_live_scan_idx");
        // Every predicate is satisfied by the index itself, including the
        // keyset cursor, so no page sorts and no page walks another tenant.
        expect(detail).toContain("accountId=?");
        expect(detail).toContain("deletedAt=?");
        expect(detail).toContain("id>?");
        expect(detail).not.toContain("TEMP B-TREE");
    });

    it("reads the whole live Account in a bounded number of round trips", async () => {
        const liveRows = await db.pluginCollectionRow.count({ where: { accountId: ACCOUNT_ID, deletedAt: null } });
        const deployment = readPluginsFeatureEnv(process.env).collectionLimits;

        const measured = await inTx(async (realTx) => {
            const counting = countingTx(realTx);
            const startedAt = performance.now();
            const usage = await readPluginCollectionAccountUsageInTx({
                tx: counting.tx,
                accountId: ACCOUNT_ID,
                deployment,
            });
            const mutationMs = performance.now() - startedAt;
            const mutationCounts = new Map(counting.counts);

            counting.counts.clear();
            const activationStartedAt = performance.now();
            const activation = await readPluginCollectionAccountActivationUsageInTx({
                tx: counting.tx,
                accountId: ACCOUNT_ID,
                deployment,
            });
            const activationMs = performance.now() - activationStartedAt;
            return {
                usage,
                activation,
                mutationCounts,
                activationCounts: new Map(counting.counts),
                mutationMs,
                activationMs,
            };
        }, { timeoutMs: 300_000, maxWaitMs: 60_000 });

        // eslint-disable-next-line no-console
        console.log(
            `[census] liveRows=${liveRows}`
            + ` mutationPages=${measured.mutationCounts.get("pluginCollectionRow.findMany") ?? 0}`
            + ` mutationMs=${measured.mutationMs.toFixed(1)}`
            + ` activationPages=${measured.activationCounts.get("pluginCollectionRow.findMany") ?? 0}`
            + ` activationMs=${measured.activationMs.toFixed(1)}`,
        );

        expect(measured.usage.rows).toBe(liveRows);
        expect(measured.activation.rows).toBe(liveRows);
        expect(measured.mutationCounts.get("pluginCollectionRow.findMany"))
            .toBeLessThanOrEqual(maximumCensusPagesFor(liveRows));
        expect(measured.activationCounts.get("pluginCollectionRow.findMany"))
            .toBeLessThanOrEqual(maximumCensusPagesFor(liveRows));
        // The census must not reach any other model: quota policy comes from
        // the contract columns joined onto each live row.
        expect([...measured.mutationCounts.keys()]).toEqual(["pluginCollectionRow.findMany"]);
    }, 300_000);
});
