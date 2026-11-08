import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionOutputV1Schema, PluginAccountCollectionContributionV1Schema, PluginManifestV2Schema, normalizePluginAccountCollectionContractsV1 } from "@happier-dev/protocol";
import { withAuthenticatedTestApp as withAuthenticatedAppHarness } from "@/app/api/testkit/sqliteFastify";
import type { Fastify } from "@/app/api/types";
import { materializePluginCollectionContractsFromManifestTx } from "@/app/plugins/data/collections/contracts";
import { readCurrentPluginCollectionContract } from "@/app/plugins/data/collections/uiQuery";
import { forgetPluginCollection, mutatePluginCollection } from "@/app/plugins/data/collections/mutation";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { registerPluginAvailabilityRoutes } from "./routes";
import { resolveCurrentPluginDeclarationsTx } from "./currentDeclaration";
import { createPluginAvailabilityOperations } from "./operations";
import { createReleaseLessDeclarationV1 } from "./currentDeclaration";
import { acquireAccountSessionOwnerMetadataFenceInTx, acquireAccountSessionOwnerMetadataFencesInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { pagePluginCollectionCandidatePreparationSource, stagePluginCollectionCandidatePreparation } from "@/app/plugins/data/collections/candidatePreparation";

const route = PluginAvailabilityActionHttpPathsV1["account.plugins.availability.collectionWriters.claim"];
const withAuthenticatedTestApp: (
    register: (app: Fastify) => void,
    run: (app: Fastify) => Promise<void>,
) => Promise<void> = withAuthenticatedAppHarness;

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Collection writer claim contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const pluginIds: string[] = [];
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        // Preserve the production nine attempts; remove only randomized retry sleep.
        vi.stubEnv("HAPPIER_DB_TX_RETRY_BASE_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_MAX_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_JITTER_FACTOR", "0");
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) {
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId: { in: pluginIds } } });
            await db.$disconnect();
        }
        vi.unstubAllEnvs();
    });

    async function fixture(materialize = true) {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(account.id);
        const pluginId = `example.fix90-${randomUUID()}`;
        pluginIds.push(pluginId);
        const collection = PluginAccountCollectionContributionV1Schema.parse({
            id: "items", schemaVersion: 1, rowIdField: "id",
            schema: { type: "object", properties: {
                id: { type: "string", maxLength: 256 }, status: { type: "string", enum: ["open", "closed"] },
            }, required: ["id", "status"], additionalProperties: false },
            serverReadable: ["status"], indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }], relations: [],
        });
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: "1.0.0",
            displayName: "External collection claim", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
            contributes: { accountCollections: [collection] } });
        if (materialize) await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
        const [contract] = normalizePluginAccountCollectionContractsV1({ pluginId, contributions: [collection] });
        const ref = { pluginId, collectionId: contract!.collectionId, schemaVersion: contract!.schemaVersion, contractDigest: contract!.contractDigest };
        return { account, manifest, ref, headers: { "x-test-user-id": account.id } };
    }

    /** Observe the genuine database boundary; route, merge, readiness and publication logic stay real. */
    async function observeTransactions<T>(observe: (tx: Tx) => void | Tx, run: () => T): Promise<Awaited<T>> {
        const original = db.$transaction.bind(db);
        db.$transaction = (async <R>(callback: (tx: Tx) => Promise<R>, options?: { isolationLevel?: "Serializable" | "RepeatableRead" | "ReadCommitted"; timeout?: number; maxWait?: number }) =>
            original(async tx => { const observed = observe(tx); return await callback(typeof observed === "object" && observed !== null ? observed : tx); }, options)) as typeof db.$transaction;
        try { return await run(); }
        finally { db.$transaction = original; }
    }

    /** Continue only after the foreign SQL committed or PostgreSQL proves the current transaction fences it. */
    async function commitOrBlock(tx: Tx, write: () => Promise<unknown>, pending: Promise<unknown>[]) {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        let settled = false;
        const competitor = write().finally(() => { settled = true; });
        void competitor.catch(() => undefined);
        pending.push(competitor);
        while (!settled) {
            const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `;
            if (blocked) return;
        }
        await competitor;
    }

    it("keeps 490 Machine declaration bodies outside Account serialization on a changed claim", async () => {
        const { account, manifest, ref } = await fixture();
        // Match the retained Account census: 490 envelopes, about 65 MB of manifests.
        const marker = "claim-locked-body";
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
            ...manifest, metadata: { measuredBody: marker + "x".repeat(128 * 1024) },
        }));
        const stored = { schemaVersion: 2, machines: Array.from({ length: 490 }, (_, index) => ({
            machineId: `machine-${index}`, machineInstallationId: `installation-${index}`, declaration,
        })), legacyDeclaration: null };
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id,
            enabled: true, writableCollections: [ref], releaseLessDeclaration: stored } });
        const client = new PrismaClient({ errorFormat: "minimal", log: [{ emit: "event", level: "query" }] });
        const transaction = db.$transaction;
        const statements: Array<{ label: string; held: boolean; appBeforeMs: number; wallMs: number; sqlMs: number; result: unknown }> = [];
        let physicalMs = 0;
        let physicalCount = 0;
        let held = false;
        let last = 0;
        let lockedAt = 0;
        let lockedMs = 0;
        client.$on("query", (event: Prisma.QueryEvent) => { physicalMs += event.duration; physicalCount++; });
        await client.$connect();
        // Genuine database adapter observation: internal claim, merge and promotion stay real.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(client.$transaction, client, args);
            return Reflect.apply(client.$transaction, client, [async (tx: Tx) => {
                held = false;
                last = performance.now();
                const observe = async (target: object, method: (...values: unknown[]) => unknown, values: unknown[], label: string) => {
                    const start = performance.now();
                    const appBeforeMs = start - last;
                    const beforeSql = physicalMs;
                    const result = await Reflect.apply(method, target, values);
                    const end = performance.now();
                    const sql = values[0] as { text?: string; sql?: string } | string | undefined;
                    const lock = label.startsWith("$queryRaw") && /FROM "Account".*FOR NO KEY UPDATE/s.test(
                        typeof sql === "string" ? sql : sql?.text ?? sql?.sql ?? "");
                    statements.push({ label, held, appBeforeMs, wallMs: end - start, sqlMs: physicalMs - beforeSql, result });
                    if (lock && !held) { held = true; lockedAt = end; }
                    last = performance.now();
                    return result;
                };
                const proxy = new Proxy(tx, { get(target, key, receiver) {
                    const value = Reflect.get(target, key, receiver);
                    if (typeof value === "function" && String(key).startsWith("$")) {
                        return (...values: unknown[]) => observe(target, value, values, String(key));
                    }
                    const model = String(key);
                    if (value && typeof value === "object" && !model.startsWith("_")) return new Proxy(value, { get(delegate, key, receiver) {
                        const method = Reflect.get(delegate, key, receiver);
                        return typeof method === "function" ? (...values: unknown[]) => observe(delegate, method, values, `${model}.${String(key)}`) : method;
                    } });
                    return value;
                } });
                try { return await callback(proxy); }
                finally { if (held) lockedMs = performance.now() - lockedAt; }
            }, ...args.slice(1)]);
        } });
        try {
            const result = await createPluginAvailabilityOperations().claimCollectionWriters({ accountId: account.id,
                input: { manifest: { ...manifest, version: "1.0.1" } } });
            // Encode measurements only after transaction closure; instrumentation must not extend the lock.
            const measured = statements.map(({ result, ...statement }) => {
                const text = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value) ?? "";
                return { ...statement, bytes: Buffer.byteLength(text), bodies: text.split(marker).length - 1 };
            });
            console.info("CLAIM_LOCK_MEASUREMENT", JSON.stringify({ lockedMs, physicalCount, statements: measured }));
            expect(result.intent.revision).toBe("1");
            expect(held, "The changed claim must exercise Account serialization").toBe(true);
            expect(measured.filter(step => step.held).reduce((sum, step) => sum + step.bodies, 0)).toBe(0);
            expect(measured.filter(step => step.held && step.label === "accountPluginIntent.findUnique")).toHaveLength(1);
            expect(measured.filter(step => step.held && step.label === "pluginCollectionCandidatePreparationStage.deleteMany")).toHaveLength(1);
            const persisted = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } } });
            expect((persisted.releaseLessDeclaration as { machines: unknown[] }).machines).toHaveLength(490);
            const start = statements.length;
            await createPluginAvailabilityOperations().claimCollectionWriters({ accountId: account.id,
                input: { manifest: { ...manifest, version: "1.0.1" } } });
            const rejoin = statements.slice(start);
            const rejoinText = JSON.stringify(rejoin.map(step => step.result), (_key, value) => typeof value === "bigint" ? String(value) : value);
            console.info("CLAIM_REJOIN_MEASUREMENT", JSON.stringify({ statements: rejoin.length, bytes: Buffer.byteLength(rejoinText), bodies: rejoinText.split(marker).length - 1 }));
            expect(rejoin.some(step => step.held)).toBe(false);
            expect(rejoinText).not.toContain(marker);
        } finally { db.$transaction = transaction; await client.$disconnect(); }
    });

    it.each([false, true])("rejoins an unchanged claim without Account serialization (prepare: %s)", async prepare => {
        const { account, manifest, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
                expect(first.statusCode, first.body).toBe(200);
                const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
                let completed = false;
                await inTx(async tx => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
                    await commitOrBlock(tx, async () => {
                        const response = await app.inject({ method: "POST", url: route, headers,
                            payload: { manifest, ...(prepare ? { prepare: true } : {}) } });
                        expect(response.statusCode, response.body).toBe(200);
                        const result = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                        expect(result.intent).toEqual(first.json().intent);
                        if (prepare) expect(result.preparation).toEqual([]);
                        completed = true;
                    }, pending);
                    expect(completed, "An unchanged declaration must not queue an exclusive Account waiter").toBe(true);
                });
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq);
            });
        } finally { await Promise.allSettled(pending); }
    });

    it.each([false, true])("rejoins an exact declaration with accumulated writers without Account serialization (prepare: %s)", async prepare => {
        const { account, manifest, ref, headers } = await fixture();
        const newerManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
            accountCollections: [{ ...manifest.contributes.accountCollections[0]!, id: "other-items" }],
        } });
        const pending: Promise<unknown>[] = [];
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const claim = (value: typeof manifest, prepareClaim = false) => app.inject({
                    method: "POST", url: route, headers, payload: { manifest: value, ...(prepareClaim ? { prepare: true } : {}) },
                });
                expect((await claim(manifest)).statusCode).toBe(200);
                expect((await claim(newerManifest)).statusCode).toBe(200);
                // The current declaration owner has no version heuristic:
                // an unsigned development edit replaces the legacy declaration.
                const latest = await claim(manifest);
                expect(latest.statusCode, latest.body).toBe(200);
                expect(latest.json().intent.writableCollections).toContainEqual(ref);
                expect(latest.json().intent.writableCollections).toHaveLength(2);
                const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
                let completed = false;
                await inTx(async tx => {
                    // Exclusive admission also detects an unnecessary KEY SHARE rejoin.
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
                    await commitOrBlock(tx, async () => {
                        const response = await claim(manifest, prepare);
                        expect(response.statusCode, response.body).toBe(200);
                        const result = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                        expect(result.intent).toEqual(latest.json().intent);
                        if (prepare) expect(result.preparation).toEqual([]);
                        completed = true;
                    }, pending);
                    expect(completed, "A monotonic no-op claim must not queue behind unrelated Account publication").toBe(true);
                });
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq);
            });
        } finally { await Promise.allSettled(pending); }
    });

    it("pages and stages candidate content alongside unrelated content admission", async () => {
        const { account, manifest, ref } = await fixture();
        const operations = createPluginAvailabilityOperations();
        await operations.claimCollectionWriters({ accountId: account.id, input: { manifest } });
        await mutatePluginCollection({ accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), request: {
            pluginId: manifest.id, collectionId: ref.collectionId,
            writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
            operations: [{ kind: "put", rowId: "source", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                content: { t: "plain", v: {} }, projection: { status: "open" } }],
        } });
        const nextManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
            accountCollections: [{ ...manifest.contributes.accountCollections[0]!, schemaVersion: 2,
                readableSchemaVersions: [1], migrations: [{ id: "upgrade", fromSchemaVersion: 1, toSchemaVersion: 2 }] }],
        } });
        const prepared = await operations.claimCollectionWriters({ accountId: account.id,
            input: { manifest: nextManifest, prepare: true } });
        const binding = prepared.preparation![0]!.binding;
        const pending: Promise<unknown>[] = [];
        try {
            let paged = false;
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                await commitOrBlock(tx, async () => {
                    expect(await pagePluginCollectionCandidatePreparationSource({ accountId: account.id,
                        request: { binding, limit: 10 } })).toMatchObject({ rows: [{ rowId: "source", revision: 1 }] });
                    paged = true;
                }, pending);
                expect(paged, "A source-page read must not queue an exclusive Account waiter").toBe(true);
                let staged = false;
                await commitOrBlock(tx, async () => {
                    expect(await stagePluginCollectionCandidatePreparation({ accountId: account.id,
                        request: { binding, items: [{ source: { rowId: "source", revision: 1 },
                            target: { content: { t: "plain", v: {} }, projection: { status: "open" } } }] } }))
                        .toEqual({ results: [{ status: "staged" }] });
                    staged = true;
                }, pending);
                expect(staged, "Stage admission must coexist with unrelated content admission").toBe(true);
            });
            await Promise.all(pending);
        } finally { await Promise.allSettled(pending); }
    });

    it("serializes changed claims, mutations and staging before domain reads", async () => {
        const { account, manifest, ref } = await fixture();
        const operations = createPluginAvailabilityOperations();
        await operations.claimCollectionWriters({ accountId: account.id, input: { manifest } });
        const nextManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
            accountCollections: [{ ...manifest.contributes.accountCollections[0]!, schemaVersion: 2,
                readableSchemaVersions: [1], migrations: [{ id: "upgrade", fromSchemaVersion: 1, toSchemaVersion: 2 }] }],
        } });
        const prepared = await operations.claimCollectionWriters({ accountId: account.id,
            input: { manifest: nextManifest, prepare: true } });
        const binding = prepared.preparation![0]!.binding;
        const pending: Promise<unknown>[] = [];
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "serializing");
                for (const write of [
                    () => stagePluginCollectionCandidatePreparation({ accountId: account.id,
                        request: { binding, items: [{ source: { rowId: "absent", revision: 1 },
                            target: { content: { t: "plain", v: {} }, projection: { status: "open" } } }] } }),
                    () => mutatePluginCollection({ accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), request: {
                        pluginId: manifest.id, collectionId: ref.collectionId,
                        writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                        operations: [{ kind: "put", rowId: "one", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                            content: { t: "plain", v: {} }, projection: { status: "open" } }],
                    } }),
                    () => operations.claimCollectionWriters({ accountId: account.id, input: { manifest: nextManifest } }),
                    () => forgetPluginCollection({ accountId: account.id, request: {
                        pluginId: manifest.id, collectionId: ref.collectionId,
                        writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                        rowId: "absent", expectedRevision: 1,
                    } }),
                ]) {
                    let completed = false;
                    await commitOrBlock(tx, async () => { await write(); completed = true; }, pending);
                    expect(completed, "Every quota/currentness writer must join the same serializing cohort").toBe(false);
                }
            });
        } finally { await Promise.allSettled(pending); }
    });

    it("mutates, forgets and changes Availability alongside unrelated content", async () => {
        const { account, manifest, ref } = await fixture();
        const operations = createPluginAvailabilityOperations();
        await operations.claimCollectionWriters({ accountId: account.id, input: { manifest } });
        const selection = await fixture(false);
        const selectedManifest = PluginManifestV2Schema.parse({ ...selection.manifest, contributes: {} });
        await operations.publishRelease({ accountId: selection.account.id, input: { sourceClass: "registryPackage", facts: {
            ref: { pluginId: selectedManifest.id, version: selectedManifest.version }, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: selectedManifest, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${"b".repeat(64)}`, resources: [] },
        } } });
        const pending: Promise<unknown>[] = [];
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFencesInTx(tx, [account.id, selection.account.id], "content");
                for (const write of [
                    async () => expect(await mutatePluginCollection({ accountId: account.id,
                        authentication: createPresentUserSessionAccessAuthentication(), request: {
                            pluginId: manifest.id, collectionId: ref.collectionId,
                            writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                            operations: [{ kind: "put", rowId: "one", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                                content: { t: "plain", v: {} }, projection: { status: "open" } }],
                        } })).toMatchObject({ status: "updated" }),
                    async () => expect(await forgetPluginCollection({ accountId: account.id, request: {
                        pluginId: manifest.id, collectionId: ref.collectionId,
                        writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                        rowId: "one", expectedRevision: 1,
                    } })).toEqual({ status: "forgotten" }),
                    () => operations.claimCollectionWriters({ accountId: account.id, input: {
                        manifest: { ...manifest, version: "2.0.0" },
                    } }),
                    () => operations.setIntent({ accountId: selection.account.id, input: {
                        pluginId: selectedManifest.id, desiredVersion: selectedManifest.version, enabled: true, offlineUiHosting: "disabled",
                        writableCollections: [], expectedRevision: null,
                    } }),
                ]) {
                    let completed = false;
                    await commitOrBlock(tx, async () => { await write(); completed = true; }, pending);
                    expect(completed, "Collection and Availability must coexist with unrelated content admission").toBe(true);
                }
            });
            await Promise.all(pending);
        } finally { await Promise.allSettled(pending); }
    });

    it("prepares a new candidate without exclusively admitting a quota mutation", async () => {
        const { account, manifest, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
                expect(first.statusCode, first.body).toBe(200);
                const nextManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
                    accountCollections: [{ ...manifest.contributes.accountCollections[0]!, schemaVersion: 2,
                        readableSchemaVersions: [1], migrations: [{ id: "upgrade", fromSchemaVersion: 1, toSchemaVersion: 2 }] }],
                } });
                let prepared = false;
                await inTx(async tx => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                    await commitOrBlock(tx, async () => {
                        const response = await app.inject({ method: "POST", url: route, headers,
                            payload: { manifest: nextManifest, prepare: true } });
                        expect(response.statusCode, response.body).toBe(200);
                        const result = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                        expect(result.intent).toEqual(first.json().intent);
                        expect(result.preparation).toHaveLength(1);
                        prepared = true;
                    }, pending);
                    expect(prepared, "Preparation only reads the incumbent and materializes immutable contracts").toBe(true);
                });
            });
        } finally { await Promise.allSettled(pending); }
    });

    it("claims through HTTP and admits the exact Data writer despite a foreign Account cursor write on every attempt", async () => {
        const { account, manifest, ref, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        let interleavings = 0;
        let cursorCommittedDuringMaterialization = false;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const response = await observeTransactions(tx => {
                    const find = tx.pluginCollectionContract.findFirst.bind(tx.pluginCollectionContract);
                    let observed = false;
                    tx.pluginCollectionContract.findFirst = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed) {
                            observed = true;
                            interleavings++;
                            // This writer intentionally bypasses this release's inTx/fence
                            // to represent another server running older code.
                            let committed = false;
                            await commitOrBlock(tx, async () => {
                                await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                committed = true;
                            }, pending);
                            cursorCommittedDuringMaterialization = committed;
                        }
                        return row;
                    }) as unknown as typeof tx.pluginCollectionContract.findFirst;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { manifest } }));
                expect(response.statusCode, `${response.body}; observed attempts=${interleavings}`).toBe(200);
                const output = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                expect(output.intent).toMatchObject({ pluginId: manifest.id, desiredVersion: null, writableCollections: [ref], revision: "0" });
                await Promise.all(pending);
                await expect(readCurrentPluginCollectionContract({ accountId: account.id, request: { ref } }))
                    .resolves.toMatchObject({ access: "writable", contract: { contractDigest: ref.contractDigest } });
                expect(await db.accountPluginIntent.count({ where: { accountId: account.id, pluginId: manifest.id } })).toBe(1);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(account.seq + interleavings + 1);
                await expect(readCurrentPluginCollectionContract({ accountId: account.id,
                    request: { ref: { ...ref, pluginId: "example.misbound" } } })).rejects.toMatchObject({ code: "collection_unavailable" });
            });
        } finally { await Promise.allSettled(pending); }
        expect(interleavings).toBeGreaterThan(0);
        // Immutable global contract preparation must not occupy the Account's
        // publication critical section. Mutable intent/quota reads remain fenced.
        expect(cursorCommittedDuringMaterialization).toBe(true);
    });

    it("selects an immutable release after a foreign Account cursor writer commits during admission", async () => {
        const { account, manifest, headers } = await fixture(false);
        const selectedManifest = PluginManifestV2Schema.parse({ ...manifest, contributes: {} });
        const operations = createPluginAvailabilityOperations();
        await operations.publishRelease({ accountId: account.id, input: { sourceClass: "registryPackage", facts: {
            ref: { pluginId: manifest.id, version: manifest.version }, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: selectedManifest, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${"b".repeat(64)}`, resources: [] },
        } } });
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const transaction = db.$transaction.bind(db);
        const pending: Promise<unknown>[] = [];
        const releases = new Set<() => void>();
        let interleavings = 0;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const response = await observeTransactions(tx => {
                    const query = tx.$queryRawUnsafe.bind(tx);
                    // Only the real database boundary is interleaved. Do not insert
                    // a target read or establish its snapshot before its actual fence.
                    const interleaveAdmission = async (sql: string, ...values: unknown[]) => {
                        if (sql !== 'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE' || values[0] !== account.id) {
                            return await query(sql, ...values);
                        }
                        let release!: () => void;
                        const held = new Promise<void>(resolve => { release = resolve; });
                        releases.add(release);
                        let ready!: (pid: number) => void;
                        let fail!: (error: unknown) => void;
                        const writerReady = new Promise<number>((resolve, reject) => { ready = resolve; fail = reject; });
                        const writer = transaction(async (peer: Tx) => {
                            const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            // A preceding/older writer can legitimately change Account.seq.
                            await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                            ready(pid);
                            await held;
                        });
                        void writer.catch(fail);
                        pending.push(writer);
                        try {
                            const writerPid = await writerReady;
                            let settled = false;
                            const target = Promise.resolve(query(sql, ...values)).finally(() => { settled = true; });
                            void target.catch(() => {});
                            pending.push(target);
                            let blocked = false;
                            while (!settled) {
                                const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                                        WHERE datname = current_database() AND ${writerPid} = ANY(pg_blocking_pids(pid))) AS blocked
                                `;
                                if (state.blocked) { blocked = true; break; }
                            }
                            expect(blocked, "The actual admission statement must wait on the independent writer").toBe(true);
                            interleavings++;
                            release();
                            await writer;
                            return await target;
                        } finally { release(); releases.delete(release); }
                    };
                    // Native Prisma transaction proxies can share raw-method storage.
                    // Keep this database-boundary observer on our own proxy instead.
                    return new Proxy(tx, { get(owner, property) {
                        return property === "$queryRawUnsafe" ? interleaveAdmission : Reflect.get(owner, property, owner);
                    } });
                }, () => app.inject({ method: "POST", url: PluginAvailabilityActionHttpPathsV1["account.plugins.availability.intent.set"],
                    headers, payload: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                        offlineUiHosting: "disabled", writableCollections: [], expectedRevision: null } }));
                expect(response.statusCode, `${response.body}; observed admissions=${interleavings}`).toBe(200);
                expect(response.json().intent).toMatchObject({ pluginId: manifest.id, desiredVersion: manifest.version, enabled: true, revision: "0" });
                expect(await db.accountPluginIntent.count({ where: { accountId: account.id, pluginId: manifest.id } })).toBe(1);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq + interleavings + 1);
            });
        } finally {
            for (const release of releases) release();
            await Promise.allSettled(pending);
        }
        expect(interleavings).toBeGreaterThan(0);
    });

    it("merges concurrent first claims and retains the last unsigned development declaration", async () => {
        const { account, manifest, ref, headers } = await fixture();
        const newerManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
            accountCollections: [{ ...manifest.contributes.accountCollections[0]!, id: "other-items" }],
        } });
        const [newerRef] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: newerManifest }));
        const pending: Promise<unknown>[] = [];
        let observed = false;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const claim = (claimedManifest: typeof manifest) => app.inject({ method: "POST", url: route, headers, payload: { manifest: claimedManifest } });
                const first = await observeTransactions(tx => {
                    const find = tx.accountPluginIntent.findUnique.bind(tx.accountPluginIntent);
                    tx.accountPluginIntent.findUnique = (async (args: Parameters<typeof find>[0]) => {
                        const current = await find(args);
                        if (!observed) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const peer = await claim(newerManifest);
                                expect(peer.statusCode, peer.body).toBe(200);
                                PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(peer.json());
                            }, pending);
                        }
                        return current;
                    }) as unknown as typeof tx.accountPluginIntent.findUnique;
                }, () => claim(manifest));
                expect(first.statusCode, first.body).toBe(200);
                await Promise.all(pending);
                const lagging = await claim(manifest);
                expect(lagging.statusCode, lagging.body).toBe(200);
                expect(PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(lagging.json()).intent)
                    .toMatchObject({ revision: "1", writableCollections: [ref, newerRef] });
                for (const expected of [ref, newerRef!]) {
                    await expect(readCurrentPluginCollectionContract({ accountId: account.id, request: { ref: expected } }))
                        .resolves.toMatchObject({ access: "writable" });
                }
                const declarations = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                    refs: [{ pluginId: manifest.id, version: manifest.version }, { pluginId: newerManifest.id, version: newerManifest.version }] }));
                expect([...declarations.values()].map(value => value.manifest.version)).toEqual([manifest.version]);
            });
        } finally { await Promise.allSettled(pending); }
        expect(observed).toBe(true);
    });

    it("retains a present-user release selection and confines the claim to its authenticated Account", async () => {
        const { account, manifest, ref, headers } = await fixture();
        const operations = createPluginAvailabilityOperations();
        await operations.publishRelease({ accountId: account.id, input: { sourceClass: "registryPackage", facts: {
            ref: { pluginId: manifest.id, version: manifest.version }, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: manifest, collectionContracts: [ref], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${"b".repeat(64)}`, resources: [] },
        } } });
        await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
            const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
            expect(first.statusCode, first.body).toBe(200);
            const selected = await app.inject({ method: "POST", url: PluginAvailabilityActionHttpPathsV1["account.plugins.availability.intent.set"], headers,
                payload: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: "disabled", writableCollections: [ref], expectedRevision: "0" } });
            expect(selected.statusCode, selected.body).toBe(200);
            const refused = await app.inject({ method: "POST", url: route, headers,
                payload: { manifest: { ...manifest, version: "2.0.0" } } });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(refused.json()).toEqual({ error: "plugin_intent_release_selected" });
            expect(await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } } }))
                .toMatchObject({ desiredVersion: manifest.version, revision: BigInt(1) });
            const unauthenticated = await app.inject({ method: "POST", url: route, payload: { manifest } });
            expect(unauthenticated.statusCode).toBe(401);
            const outsider = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
            accountIds.push(outsider.id);
            await expect(readCurrentPluginCollectionContract({ accountId: outsider.id, request: { ref } }))
                .rejects.toMatchObject({ code: "collection_unavailable" });
        });
    });

    it("keeps the active Account quota gate and rolls back an inadmissible declaration", async () => {
        const { account, manifest, ref, headers } = await fixture();
        await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
            const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
            expect(first.statusCode, first.body).toBe(200);
            const mutated = await mutatePluginCollection({ accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), request: {
                pluginId: manifest.id, collectionId: ref.collectionId,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: ["one", "two"].map(rowId => ({ kind: "put", rowId, expectedRevision: "absent", expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: {} }, projection: { status: "open" } })),
            } });
            expect(mutated.status).toBe("updated");
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const keys = ["HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS", "HAPPIER_COLLECTION_MAX_BATCH_ROWS"] as const;
            const previous = keys.map(key => process.env[key]);
            try {
                for (const key of keys) process.env[key] = "1";
                const refused = await app.inject({ method: "POST", url: route, headers,
                    payload: { manifest: { ...manifest, version: "2.0.0", contributes: { accountCollections: [
                        ...manifest.contributes.accountCollections,
                        { ...manifest.contributes.accountCollections[0]!, id: "new-items" },
                    ] } } } });
                expect(refused.statusCode, refused.body).toBe(409);
                expect(refused.json()).toEqual({ error: "collection_quota_incompatible", dimension: "maxRows", effectiveMaximum: 1 });
            } finally {
                keys.forEach((key, index) => {
                    if (previous[index] === undefined) delete process.env[key];
                    else process.env[key] = previous[index];
                });
            }
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq);
            // Contract preparation moved before Account locking, but its writes
            // still belong to the rejected claim's transaction.
            expect(await db.pluginCollectionContract.count({ where: { pluginId: manifest.id } })).toBe(1);
            expect(await db.pluginCollectionRow.count({ where: { accountId: account.id, deletedAt: null } })).toBe(2);
            const current = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                refs: [{ pluginId: manifest.id, version: manifest.version }, { pluginId: manifest.id, version: "2.0.0" }] }));
            expect([...current.values()].map(value => value.manifest.version)).toEqual([manifest.version]);
        });
    });

    it.each(["same", "different"] as const)("materializes one shared immutable contract when %s Accounts first claim the same external plugin", async accountScope => {
        const { account, manifest, ref, headers } = await fixture(false);
        const peerAccount = accountScope === "same" ? account
            : await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        if (accountScope === "different") accountIds.push(peerAccount.id);
        const pending: Promise<unknown>[] = [];
        let observed = false;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const first = await observeTransactions(tx => {
                    const find = tx.pluginCollectionContract.findFirst.bind(tx.pluginCollectionContract);
                    tx.pluginCollectionContract.findFirst = (async (args: Parameters<typeof find>[0]) => {
                        const current = await find(args);
                        if (!observed && current === null) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const peer = await app.inject({ method: "POST", url: route,
                                    headers: { "x-test-user-id": peerAccount.id }, payload: { manifest } });
                                expect(peer.statusCode, peer.body).toBe(200);
                            }, pending);
                        }
                        return current;
                    }) as unknown as typeof tx.pluginCollectionContract.findFirst;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { manifest } }));
                expect(first.statusCode, first.body).toBe(200);
                PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(first.json());
                await Promise.all(pending);
                expect(await db.pluginCollectionContract.count({ where: { pluginId: manifest.id } })).toBe(1);
                for (const accountId of [account.id, peerAccount.id]) {
                    await expect(readCurrentPluginCollectionContract({ accountId, request: { ref } }))
                        .resolves.toMatchObject({ access: "writable" });
                }
            });
        } finally { await Promise.allSettled(pending); }
        expect(observed).toBe(true);
    });
});
