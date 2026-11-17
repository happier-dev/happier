import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { db, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerTeamRoutes } from "./registerTeamRoutes";
import { createDbMaintenanceClient, onDbClientQuery } from "@/storage/prisma";

const require = createRequire(import.meta.url);
// Generated SQLite is the real database boundary with the shared Prisma contract.
const postgres = Boolean(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL);

describe("Team archive resource census cost", () => {
    it("archives one member without scanning unrelated Home resources", async () => {
        if (postgres) {
            initDbPostgres();
            await db.$connect();
        }
        const harness = postgres ? { close: shutdownDbClient } : await createLightSqliteHarness({ tempDirPrefix: "team-archive-cost-", initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" } });
        const client = await createDbMaintenanceClient(postgres ? "postgres" : "sqlite", undefined, { log: [{ emit: "event", level: "query" }] });
        const statements: Array<{ query: string; params: string }> = [];
        onDbClientQuery(client, event => statements.push(event));
        const originalTransaction = db.$transaction;
        const app = createAuthenticatedTestApp();
        process.env.HAPPIER_FEATURE_TEAMS__ENABLED = "1";
        try {
            await db.account.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ id: `archive-cost-${i}`, encryptionMode: "plain" })) });
            await db.session.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `archive-session-${i}`,
                accountId: `archive-cost-${i % 100}`, tag: `archive-${i}`, encryptionMode: "plain", metadata: "{}" })) });
            const owner = "archive-cost-0";
            const team = await db.team.create({ data: { name: "One member", memberships: { create: { accountId: owner, role: "owner" } } } });
            // Rebind only database transport to observe the real route's SQL.
            db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
                return Reflect.apply(client.$transaction, client, args);
            } });
            registerTeamRoutes(app);
            await app.ready();
            const started = performance.now();
            const response = await app.inject({ method: "POST", url: "/v1/teams/archive",
                headers: { "x-test-user-id": owner }, payload: { v: 1, teamId: team.id } });
            console.info(`archive elapsedMs=${Math.round(performance.now() - started)} statements=${statements.length}`);
            expect(response.statusCode).toBe(200);
            expect(response.json().archivedAt).not.toBeNull();
            expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(1);
            const census = statements.filter(({ query }) => /^SELECT .* FROM [`"]?(?:(?:main|public)["`]?\.)?[`"]?(Session|Machine|Discussion)[`"]? /i.test(query));
            expect(statements.some(({ query }) => query.includes("SessionTeamGrant"))).toBe(true);
            const scans: string[] = [];
            for (const statement of census) {
                if (postgres) {
                    const plan = await client.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN ${statement.query}`, ...JSON.parse(statement.params));
                    for (const step of plan) if (/Seq Scan on "?(Session|Machine|Discussion)"?\b/.test(step["QUERY PLAN"])) scans.push(step["QUERY PLAN"]);
                } else {
                    const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${statement.query}`, ...JSON.parse(statement.params));
                    for (const step of plan) if (/^SCAN /i.test(step.detail)) scans.push(step.detail);
                }
            }
            expect(scans, "Team census must seek grant indexes rather than scan Home resource tables").toEqual([]);
            expect(await db.account.count({ where: { seq: { gt: 0 } } })).toBe(1);
        } finally {
            db.$transaction = originalTransaction;
            await app.close();
            await client.$disconnect();
            await harness.close();
        }
    });
});
