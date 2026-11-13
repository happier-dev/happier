import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { db, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { deleteAccountForErasure } from "./accountDataErase";

const require = createRequire(import.meta.url);
// Generated SQLite is the real database boundary with the shared Prisma contract.
const postgres = Boolean(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL);
const { PrismaClient } = require(postgres ? "@prisma/client" : "../../../../generated/sqlite-client/index.js") as typeof import("@prisma/client");

interface QueryPlan {
    "Node Type": string;
    "Relation Name"?: string;
    "Actual Loops": number;
    "Actual Rows": number;
    "Rows Removed by Filter"?: number;
    Plans?: QueryPlan[];
}

describe("Account erasure resource census cost", () => {
    it.each([0, 1000])("erases an empty Account with %i unrelated resources without resource scans", async (size) => {
        if (postgres) {
            initDbPostgres();
            await db.$connect();
        }
        const harness = postgres ? { close: shutdownDbClient } : await createLightSqliteHarness({ tempDirPrefix: "account-erase-cost-", initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" } });
        const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        const statements: Array<{ query: string; params: string }> = [];
        client.$on("query", event => statements.push(event));
        const originalTransaction = db.$transaction;
        process.env.HAPPIER_FEATURE_TEAMS__ENABLED = "1";
        try {
            await db.account.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ id: `erase-cost-${i}`, encryptionMode: "plain" })) });
            await db.session.createMany({ data: Array.from({ length: size }, (_, i) => ({ id: `erase-session-${i}`,
                accountId: `erase-cost-${i % 100}`, tag: `erase-${i}`, encryptionMode: "plain", metadata: "{}" })) });
            await db.machine.createMany({ data: Array.from({ length: size }, (_, i) => ({ id: `erase-machine-${i}`,
                accountId: `erase-cost-${i % 100}`, metadata: "{}" })) });
            await db.team.createMany({ data: Array.from({ length: size / 10 }, (_, i) => ({ id: `erase-team-${i}`, name: `Unrelated ${i}` })) });
            await db.teamGroup.createMany({ data: Array.from({ length: size / 10 }, (_, i) => ({ id: `erase-group-${i}`,
                teamId: `erase-team-${i}`, name: "Group", nameKey: "group" })) });
            await db.discussion.createMany({ data: Array.from({ length: size }, (_, i) => ({ id: `erase-discussion-${i}`,
                ownerAccountId: `erase-cost-${i % 100}`, encryptionMode: "plain", dataEncryptionKey: new Uint8Array([0]),
                creationLocalId: `erase-discussion-${i}`, creationEqualityEvidenceV1: {}, titleContent: {}, lastMessageAt: new Date() })) });
            // Retained foreign grants exercise the unindexed creator arms reserved for B6.
            // Ten grants of each kind per resource: 60,000 unrelated grant rows at crowded scale.
            for (let recipient = 0; recipient < 10; recipient++) {
                await db.machineGrant.createMany({ data: (Array.from({ length: size }, (_, i) => ({ machineId: `erase-machine-${i}`,
                    accountId: `erase-cost-${recipient}`, createdByAccountId: `erase-cost-${i % 100}`, accessLevel: "view" }))).map(grant => ({ ...grant, principalKind: 'account' as const })) });
                await db.discussionAccountGrant.createMany({ data: Array.from({ length: size }, (_, i) => ({ discussionId: `erase-discussion-${i}`,
                    accountId: `erase-cost-${recipient}`, createdByAccountId: `erase-cost-${i % 100}`, accessLevel: "view" })) });
                await db.machineGrant.createMany({ data: (Array.from({ length: size }, (_, i) => ({ machineId: `erase-machine-${i}`,
                    teamId: `erase-team-${recipient}`, createdByAccountId: `erase-cost-${i % 100}`, accessLevel: "view" }))).map(grant => ({ ...grant, principalKind: 'team' as const })) });
                await db.discussionTeamGrant.createMany({ data: Array.from({ length: size }, (_, i) => ({ discussionId: `erase-discussion-${i}`,
                    teamId: `erase-team-${recipient}`, createdByAccountId: `erase-cost-${i % 100}`, accessLevel: "view" })) });
                await db.machineGrant.createMany({ data: (Array.from({ length: size }, (_, i) => ({ machineId: `erase-machine-${i}`,
                    teamGroupId: `erase-group-${recipient}`, createdByAccountId: `erase-cost-${i % 100}`, accessLevel: "view" }))).map(grant => ({ ...grant, principalKind: 'group' as const })) });
                await db.discussionGroupGrant.createMany({ data: Array.from({ length: size }, (_, i) => ({ discussionId: `erase-discussion-${i}`,
                    teamGroupId: `erase-group-${recipient}`, createdByAccountId: `erase-cost-${i % 100}`, accessLevel: "view" })) });
            }
            const owner = "erasure-cost-target";
            await db.account.create({ data: { id: owner, encryptionMode: "plain" } });
            // Observe the real erasure owner through the database transport boundary.
            db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
                return Reflect.apply(client.$transaction, client, args);
            } });
            const started = performance.now();
            expect(await deleteAccountForErasure({ accountId: owner })).toEqual({ status: "deleted" });
            console.info(`erasure elapsedMs=${Math.round(performance.now() - started)} size=${size} statements=${statements.length}`);
            expect(await db.account.findUnique({ where: { id: owner } })).toBeNull();
            expect(await db.session.count()).toBe(size);
            const creatorReads = statements.filter(({ query }) => /^SELECT /.test(query) && /FROM ["`]?(?:(?:main|public)["`]?\.)?["`]?(Machine|Discussion)(Account|Team|Group)Grant["`]? /.test(query) && /WHERE .*createdByAccountId/.test(query));
            console.info(`creator queries=${creatorReads.length}`);
            if (postgres && size > 0) {
                let removed = 0;
                let executionMs = 0;
                for (const statement of creatorReads) {
                    const plan = await client.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (ANALYZE) ${statement.query}`, ...JSON.parse(statement.params));
                    for (const step of plan) {
                        removed += Number(/Rows Removed by Filter: (\d+)/.exec(step["QUERY PLAN"])?.[1] ?? 0);
                        executionMs += Number(/Execution Time: ([\d.]+)/.exec(step["QUERY PLAN"])?.[1] ?? 0);
                    }
                }
                console.info(`creator rowsVisited=${removed} executionMs=${executionMs.toFixed(3)}`);
            }
            const census = statements.filter(({ query }) => /^SELECT .* FROM [`"]?(?:(?:main|public)["`]?\.)?[`"]?(Session|Machine|Discussion)[`"]? /i.test(query));
            const scans: string[] = [];
            let resourceRowsVisited = 0;
            for (const statement of census) {
                if (postgres) {
                    const plan = await client.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: QueryPlan }> }>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`, ...JSON.parse(statement.params));
                    const visit = (step: QueryPlan) => {
                        if (/^(Session|Machine|Discussion)$/.test(step["Relation Name"] ?? "")) {
                            resourceRowsVisited += step["Actual Loops"] * (step["Actual Rows"] + (step["Rows Removed by Filter"] ?? 0));
                        }
                        if (size > 0 && step["Node Type"] === "Seq Scan" && /^(Session|Machine|Discussion)$/.test(step["Relation Name"] ?? "")
                            && step["Actual Loops"] > 0 && step["Actual Rows"] + (step["Rows Removed by Filter"] ?? 0) > 0) {
                            scans.push(`${step["Relation Name"]}: ${JSON.stringify(step)}; ${statement.query}`);
                        }
                        for (const child of step.Plans ?? []) visit(child);
                    };
                    for (const row of plan) for (const entry of row["QUERY PLAN"]) visit(entry.Plan);
                } else {
                    const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${statement.query}`, ...JSON.parse(statement.params));
                    for (const step of plan) if (/^SCAN /i.test(step.detail)) scans.push(step.detail);
                    resourceRowsVisited += (await client.$queryRawUnsafe<unknown[]>(statement.query, ...JSON.parse(statement.params))).length;
                }
            }
            console.info(`resource rowsVisited=${resourceRowsVisited} scans=${scans.length}`);
            expect(resourceRowsVisited, "An empty Account's erasure must not visit unrelated resources").toBe(0);
            expect(scans, "Account census must seek grant indexes rather than scan Home resource tables").toEqual([]);

        } finally {
            db.$transaction = originalTransaction;
            if (postgres) {
                await db.machine.deleteMany({ where: { id: { startsWith: "erase-machine-" } } });
                await db.discussion.deleteMany({ where: { id: { startsWith: "erase-discussion-" } } });
                await db.session.deleteMany({ where: { id: { startsWith: "erase-session-" } } });
                await db.account.deleteMany({ where: { id: { startsWith: "erase-cost-" } } });
                await db.team.deleteMany({ where: { id: { startsWith: "erase-team-" } } });
            }
            await client.$disconnect();
            await harness.close();
        }
    });
});
