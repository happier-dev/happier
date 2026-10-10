import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

import { createPluginAvailabilityOperations } from "./operations";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported Availability contract provider: ${raw}`);
}

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const provider = resolveContractProvider();
const accountIdPrefix = "plugin-availability-interleave-";

describe("plugin Availability report transaction contract", () => {
    let activeAccountId: string | null = null;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL for Availability DB contract test");
        }
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
    });

    afterEach(async () => {
        if (activeAccountId !== null) {
            await db.machine.deleteMany({ where: { accountId: activeAccountId } });
            await db.account.deleteMany({ where: { id: activeAccountId } });
            activeAccountId = null;
        }
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    it(`rejects a predecessor report that resumes after its successor commits on ${provider}`, async () => {
        const suffix = randomUUID();
        const accountId = `${accountIdPrefix}${suffix}`;
        const machineId = `machine-${suffix}`;
        const serverIdentityId = `srv_availabilityInterleave_${suffix.replace(/-/gu, "")}`;
        const pluginId = `com.acme.availability-interleave-${suffix}`;
        activeAccountId = accountId;
        await db.account.create({
            data: {
                id: accountId,
                publicKey: null,
                encryptionMode: "plain",
            },
        });
        await db.machine.create({
            data: {
                id: machineId,
                accountId,
                metadata: "{}",
                installationId: `installation-${suffix}`,
            },
        });
        const service = createPluginAvailabilityOperations({
            resolveHostingCapability: () => ({ enabled: false }),
            resolveServerIdentityId: async () => serverIdentityId,
        });
        const materialization = (version: string, observedAt: number) => ({
            serverIdentityId,
            machineId,
            materializationId: "install-epoch-1",
            pluginId,
            version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt,
        });
        const report = async (expectedRevision: number | null, version: string, observedAt: number) => (
            await service.reportMaterializations({
                accountId,
                publisherMachineId: machineId,
                input: {
                    expectedRevision,
                    snapshot: {
                        serverIdentityId,
                        machineId,
                        materializations: [materialization(version, observedAt)],
                    },
                },
            })
        );

        await expect(report(null, "1.0.0", 1_700_000_000_000))
            .resolves.toEqual({ outcome: "replaced", revision: 1 });

        const predecessorRead = deferred();
        const resumePredecessor = deferred();
        const runTransaction = db.$transaction.bind(db);
        let pauseMaterializationRead = true;
        const pausingTransaction = (async (
            callback: (tx: Tx) => Promise<unknown>,
            options?: unknown,
        ) => await runTransaction(async (tx) => {
            const pausedMaterializationDelegate = new Proxy(tx.pluginMachineMaterialization, {
                get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property === "findMany" && pauseMaterializationRead) {
                        pauseMaterializationRead = false;
                        return async (...args: unknown[]) => {
                            const rows = await Reflect.apply(value as (...input: unknown[]) => unknown, target, args);
                            predecessorRead.resolve();
                            await resumePredecessor.promise;
                            return rows;
                        };
                    }
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const pausedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    if (property === "pluginMachineMaterialization") {
                        return pausedMaterializationDelegate;
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            return await callback(pausedTx);
        }, options as never)) as typeof db.$transaction;

        db.$transaction = pausingTransaction;
        const predecessor = report(1, "1.1.0-predecessor", 1_700_000_001_000);
        await predecessorRead.promise;
        db.$transaction = runTransaction as typeof db.$transaction;
        try {
            await expect(report(1, "1.2.0-successor", 1_700_000_002_000))
                .resolves.toEqual({ outcome: "replaced", revision: 2 });
        } finally {
            resumePredecessor.resolve();
        }
        await expect(predecessor).resolves.toEqual({ outcome: "conflict", revision: 2 });

        await expect(db.machine.findUnique({
            where: { id: machineId },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: BigInt(2) });
        await expect(db.pluginMachineMaterialization.findMany({
            where: { accountId, machineId },
            select: { version: true, observedAt: true },
        })).resolves.toEqual([{
            version: "1.2.0-successor",
            observedAt: new Date(1_700_000_002_000),
        }]);
        await expect(db.account.findUnique({
            where: { id: accountId },
            select: { seq: true },
        })).resolves.toEqual({ seq: 2 });
        await expect(db.accountChange.findMany({
            where: { accountId, kind: "pluginDomain" },
            select: { cursor: true, hint: true },
        })).resolves.toEqual([{
            cursor: 2,
            hint: { pluginDomain: "availability", pluginId },
        }]);
    });
});
