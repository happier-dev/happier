import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pruneExpiredVoiceSessionLeases } from "@/app/voice/pruneExpiredVoiceSessionLeases";
import { db, initDbMysql, initDbPostgres, isPrismaErrorCode } from "@/storage/db";

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();

    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

function uniq(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
}

describe("db portability contract", () => {
    const provider = resolveContractProviderFromEnv();
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for db contract tests).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            // initDbPostgres is synchronous (PrismaClient is bundled in the main server build).
            // MySQL/SQLite init paths are async because they may dynamically import generated clients.
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterAll(async () => {
        if (!dbConnected) return;
        await db.$disconnect();
    });

    it("round-trips BigInt fields", async () => {
        const feedSeq = 9_007_199_254_740_993n;
        const account = await db.account.create({
            data: {
                publicKey: uniq("contract-bigint-pubkey"),
                feedSeq,
            },
            select: { id: true },
        });

        const reread = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { feedSeq: true },
        });

        expect(reread.feedSeq).toBe(feedSeq);
    });

    it("round-trips Json fields", async () => {
        const account = await db.account.create({
            data: { publicKey: uniq("contract-json-pubkey") },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: uniq("contract-session"),
                metadata: "{}",
            },
            select: { id: true },
        });

        const hint = { test: true, nested: { a: 1 }, provider };
        await db.accountChange.create({
            data: {
                accountId: account.id,
                kind: "contract",
                entityId: uniq("entity"),
                cursor: 1,
                hint,
                sessionId: session.id,
            },
            select: { accountId: true },
        });

        const reread = await db.accountChange.findFirstOrThrow({
            where: { accountId: account.id, kind: "contract" },
            select: { hint: true },
        });

        expect(reread.hint).toEqual(hint);
    });

    it("enforces unique constraints via Prisma P2002", async () => {
        const publicKey = uniq("contract-unique-pubkey");
        await db.account.create({ data: { publicKey }, select: { id: true } });

        let err: unknown = null;
        try {
            await db.account.create({ data: { publicKey }, select: { id: true } });
        } catch (e) {
            err = e;
        }

        expect(isPrismaErrorCode(err, "P2002")).toBe(true);
    });

    it("sets AccountChange.sessionId to NULL when a Session is deleted (ON DELETE SET NULL)", async () => {
        const account = await db.account.create({
            data: { publicKey: uniq("contract-setnull-pubkey") },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: uniq("contract-setnull-session"),
                metadata: "{}",
            },
            select: { id: true },
        });

        await db.accountChange.create({
            data: {
                accountId: account.id,
                kind: "contract-setnull",
                entityId: uniq("entity"),
                cursor: 1,
                sessionId: session.id,
            },
            select: { accountId: true },
        });

        await db.session.delete({ where: { id: session.id }, select: { id: true } });

        const reread = await db.accountChange.findFirstOrThrow({
            where: { accountId: account.id, kind: "contract-setnull" },
            select: { sessionId: true },
        });

        expect(reread.sessionId).toBeNull();
    });

    it("preserves exact Voice grant provenance while transactionally pruning an expired lease", async () => {
        const account = await db.account.create({
            data: { publicKey: uniq("contract-voice-grant-provenance-pubkey") },
            select: { id: true },
        });
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: account.id,
                periodKey: "2026-07",
                grantedBy: "subscription",
                elevenLabsAgentId: "contract-agent",
                expiresAt: new Date("2026-07-01T00:00:00.000Z"),
            },
            select: { id: true },
        });
        const conversation = await db.voiceConversation.create({
            data: {
                accountId: account.id,
                leaseId: lease.id,
                providerId: "contract-provider",
                providerConversationId: uniq("contract-voice-conversation"),
                durationSeconds: 1,
                grantedBy: null,
                grantPeriodKey: null,
            },
            select: { id: true },
        });

        await expect(pruneExpiredVoiceSessionLeases({
            accountId: account.id,
            cutoff: new Date("2026-07-02T00:00:00.000Z"),
        })).resolves.toBe(1);

        await expect(db.voiceSessionLease.findUnique({
            where: { id: lease.id },
            select: { id: true },
        })).resolves.toBeNull();
        await expect(db.voiceConversation.findUniqueOrThrow({
            where: { id: conversation.id },
            select: { grantedBy: true, grantPeriodKey: true, leaseId: true },
        })).resolves.toEqual({
            grantedBy: "subscription",
            grantPeriodKey: "2026-07",
            leaseId: null,
        });
    });

    it("preserves exact Voice grant provenance when an older writer directly deletes the lease", async () => {
        const account = await db.account.create({
            data: { publicKey: uniq("contract-legacy-voice-grant-provenance-pubkey") },
            select: { id: true },
        });
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: account.id,
                periodKey: "2026-06",
                grantedBy: "free",
                elevenLabsAgentId: "contract-agent",
                expiresAt: new Date("2026-06-01T00:00:00.000Z"),
            },
            select: { id: true },
        });
        const conversation = await db.voiceConversation.create({
            data: {
                accountId: account.id,
                leaseId: lease.id,
                providerId: "contract-provider",
                providerConversationId: uniq("contract-legacy-voice-conversation"),
                durationSeconds: 1,
                grantedBy: null,
                grantPeriodKey: null,
            },
            select: { id: true },
        });

        await db.voiceSessionLease.delete({
            where: { id: lease.id },
            select: { id: true },
        });

        await expect(db.voiceConversation.findUniqueOrThrow({
            where: { id: conversation.id },
            select: { grantedBy: true, grantPeriodKey: true, leaseId: true },
        })).resolves.toEqual({
            grantedBy: "free",
            grantPeriodKey: "2026-06",
            leaseId: null,
        });
    });
});
