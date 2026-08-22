import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runSessionSidechainMessageRetentionRule } from "@/app/retention/rules/sessionSidechainMessageRetentionRule";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported contract provider: ${raw}`);
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/**
 * Pauses the retention rule's transaction-local candidate read (the delete
 * batch's id lookup) exactly once, after the database has answered it. That
 * read is the last thing the sweep learns about the sidechain before it
 * deletes, so releasing the barrier after a live message has committed is the
 * exact interleaving that must not truncate a sidechain. The real provider
 * transaction, the real rule and the real database stay in the path; only the
 * interleaving is made deterministic.
 */
function installSidechainCandidateReadBarrier(params: Readonly<{
    sessionId: string;
    sidechainId: string;
}>): Readonly<{
    candidateRead: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const candidateRead = deferred();
    const release = deferred();
    const originalTransaction = db.$transaction;
    let paused = false;
    let restored = false;

    // `db` forwards assignment to its active client; defining an own property
    // on the forwarding Proxy would not affect its get trap.
    db.$transaction = (async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") {
            return await Reflect.apply(originalTransaction, undefined, args);
        }
        return await Reflect.apply(originalTransaction, undefined, [
            async (tx: object) => {
                const delegate = Reflect.get(tx, "sessionMessage") as object;
                const originalFindMany = Reflect.get(delegate, "findMany");
                if (typeof originalFindMany !== "function") {
                    throw new Error("SessionMessage.findMany is unavailable in transaction");
                }
                const wrappedDelegate = new Proxy(delegate, {
                    get(target, property, receiver) {
                        if (property !== "findMany") return Reflect.get(target, property, receiver);
                        return async (...findManyArgs: unknown[]) => {
                            const result = await Reflect.apply(originalFindMany, target, findManyArgs);
                            const candidate = findManyArgs[0] as {
                                where?: { sessionId?: unknown; sidechainId?: unknown };
                                orderBy?: { seq?: unknown };
                            } | undefined;
                            const isCandidateRead = candidate?.where?.sessionId === params.sessionId
                                && candidate?.where?.sidechainId === params.sidechainId
                                && candidate?.orderBy?.seq === "asc";
                            if (isCandidateRead && !paused) {
                                paused = true;
                                candidateRead.resolve();
                                await release.promise;
                            }
                            return result;
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "sessionMessage") return wrappedDelegate;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await Reflect.apply(operation, undefined, [wrappedTx]);
            },
            ...args.slice(1),
        ]);
    }) as typeof db.$transaction;

    return {
        candidateRead: candidateRead.promise,
        release: () => {
            release.resolve();
        },
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            db.$transaction = originalTransaction;
        },
    };
}

describe("session sidechain retention database contract", () => {
    const provider = resolveContractProvider();
    const expired = new Date("2025-01-01T00:00:00.000Z");
    const cutoff = new Date("2026-01-01T00:00:00.000Z");
    const arrivedDuringSweep = new Date("2027-01-01T00:00:00.000Z");
    let connected = false;
    let barrier: ReturnType<typeof installSidechainCandidateReadBarrier> | null = null;
    let previousStoragePolicy: string | undefined;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
        previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterEach(() => {
        barrier?.restore();
        barrier = null;
    });

    afterAll(async () => {
        if (previousStoragePolicy === undefined) {
            delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        } else {
            process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
        }
        if (connected) await db.$disconnect();
    });

    it("never half-deletes a sidechain that gains a message between the eligibility read and the delete", async () => {
        const account = await db.account.create({
            data: { publicKey: `sidechain-retention-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `sidechain-retention-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const sidechainId = `sidechain-${randomUUID()}`;
        for (const seq of [1, 2, 3]) {
            await db.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq,
                    sidechainId,
                    createdAt: expired,
                    content: { t: "plain", v: { text: `expired:${seq}` } },
                },
            });
        }
        barrier = installSidechainCandidateReadBarrier({
            sessionId: session.id,
            sidechainId,
        });

        const sweep = runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
            maxCandidatesPerRulePerRun: 1,
            // Start immediately before this session's only sidechain so the
            // sweep cannot pick up unrelated contract-lane rows.
            startCursor: { sessionId: session.id, sidechainId: "" },
            persistCursor: false,
        });

        await barrier.candidateRead;
        // A live writer extends the very sidechain the sweep just judged
        // expired. Under a Serializable reader this statement may block on the
        // sweep's locks, so it is never awaited before the barrier releases.
        const concurrentWrite = db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 4,
                sidechainId,
                createdAt: arrivedDuringSweep,
                content: { t: "plain", v: { text: "arrived-during-sweep" } },
            },
        }).then(() => "committed" as const, () => "rejected" as const);
        await new Promise((resume) => setTimeout(resume, 250));
        barrier.release();

        const [writeOutcome] = await Promise.all([concurrentWrite, sweep]);

        const remaining = await db.sessionMessage.findMany({
            where: { sessionId: session.id, sidechainId },
            orderBy: { seq: "asc" },
            select: { seq: true },
        });
        if (writeOutcome === "committed") {
            // The sidechain was no longer wholly expired when the delete ran,
            // so no part of it may be gone. A truncated sidechain here is
            // silent transcript loss.
            expect(remaining).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]);
        } else {
            // The writer lost the conflict, so nothing it wrote exists and the
            // wholly expired sidechain may be pruned in full.
            expect(remaining).toEqual([]);
        }
    });
});
