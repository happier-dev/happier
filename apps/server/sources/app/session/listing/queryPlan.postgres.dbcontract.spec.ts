import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { decodeBase64 } from "privacy-kit";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { readSessionMetadataOwnerAccountModes } from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { findV2SessionListRows, mapV2SessionListRows, V2_SESSION_LIST_ORDER_BY } from "./page";
import { loadSessionLatestFailureSequencesInTx } from "@/app/session/personal/projection";
import { loadSessionRuleReadStatesInTx } from "@/app/session/personal/readState";
import { SessionFollowRuleStoredRowV1Schema, buildSessionFollowRulePhysicalKeyV1 } from "@happier-dev/protocol/sessions/follow/sessionFollowRuleV1";
import { normalizeSessionListFilterV1 } from "@happier-dev/protocol/sessions/listFilter/sessionListFilterV1";
import { encodeAccountScopedKvJson } from "@/app/kv/accountScopedKv";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";

interface PlanNode {
    "Node Type": string;
    "Relation Name"?: string;
    "Actual Loops": number;
    Plans?: PlanNode[];
}

function relationLoops(plan: PlanNode, relation: string): number {
    return (plan["Relation Name"] === relation ? plan["Actual Loops"] : 0)
        + (plan.Plans ?? []).reduce((sum, child) => sum + relationLoops(child, relation), 0);
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session listing PostgreSQL query work", () => {
    const queries: Prisma.QueryEvent[] = [];
    const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    let resolveQueryBarrier: (() => void) | undefined;

    async function drainQueryEvents() {
        const observed = new Promise<void>(resolve => { resolveQueryBarrier = resolve; });
        try {
            // Engine query events can arrive after the query promise. As in
            // the hot-read cost fixtures, settle the event stream before counting.
            await Promise.all([client.$queryRaw`SELECT 1 AS "session_list_cost_barrier"`, observed]);
        } finally { resolveQueryBarrier = undefined; }
    }

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        client.$on("query", query => {
            if (query.query.includes('"session_list_cost_barrier"')) resolveQueryBarrier?.();
            else queries.push(query);
        });
        initDbPostgres();
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); await shutdownDbClient(); });

    it("batches personal rule boundaries by distinct inception rather than Session or rule", async () => {
        const accountId = `rule-boundaries-${randomUUID()}`;
        const sessionIds = Array.from({ length: 1_000 }, (_, index) => `${accountId}-${index}`);
        await client.account.create({ data: { id: accountId, publicKey: accountId, encryptionMode: "plain" } });
        try {
            await client.session.createMany({ data: sessionIds.map(id => ({ id, accountId, tag: id, metadata: "{}", seq: 3,
                currentStorageState: "hosted" })) });
            await client.sessionMessage.createMany({ data: sessionIds.flatMap(sessionId => [1, 2, 3].map(seq => ({
                sessionId, seq, localId: `${sessionId}-${seq}`, createdAt: new Date(seq * 100),
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "Original" } } },
            } satisfies Prisma.SessionMessageCreateManyInput))) });
            await client.userKVStore.createMany({ data: Array.from({ length: 20 }, (_, index) => {
                const encoded = encodeAccountScopedKvJson(SessionFollowRuleStoredRowV1Schema.parse({ version: 0, receiver: { kind: "account" },
                    inception: { createdAt: index % 2 ? 250 : 150 },
                    content: { t: "plain", v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: "important" } } },
                }));
                if (encoded === null) throw new Error("Rule fixture could not be encoded");
                return { accountId, key: buildSessionFollowRulePhysicalKeyV1(`rule-${index}`), version: 0, value: decodeBase64(encoded) };
            }) });
            const rows = await client.session.findMany({ where: { accountId }, select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT } });
            await drainQueryEvents();
            queries.length = 0;
            const projected = await loadSessionRuleReadStatesInTx(client, { accountId,
                authentication: createPresentUserSessionAccessAuthentication(), rows });
            await drainQueryEvents();
            expect(projected.size).toBe(1_000);
            const first = projected.get(sessionIds[0]);
            expect(first).toHaveLength(20);
            expect(first?.find(rule => rule.ruleId === "rule-0")?.readState)
                .toEqual({ state: "tracking", lastViewedSessionSeq: 1, unreadSince: 150 });
            expect(first?.find(rule => rule.ruleId === "rule-1")?.readState)
                .toEqual({ state: "tracking", lastViewedSessionSeq: 2, unreadSince: 250 });
            const originalReads = queries.filter(query => /FROM "public"\."SessionMessage"/.test(query.query));
            expect(originalReads).toHaveLength(4);
            expect(Math.max(...originalReads.map(query => JSON.parse(query.params).length))).toBeLessThanOrEqual(999);
            expect(originalReads.every(query => query.query.includes("MAX(") && query.query.includes("GROUP BY"))).toBe(true);
            expect(queries.filter(query => /FROM "public"\."UserKVStore"/.test(query.query))).toHaveLength(1);
        } finally {
            await client.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await client.userKVStore.deleteMany({ where: { accountId } });
            await client.session.deleteMany({ where: { accountId } });
            await client.account.delete({ where: { id: accountId } });
        }
    });

    it("reads exact current failure anchors in batches without scanning historical turns or querying per Session", async () => {
        const prefix = `failure-anchor-${randomUUID()}`;
        const accountId = `${prefix}-owner`;
        const sessionIds = Array.from({ length: 1_000 }, (_, index) => `${prefix}-${index}`);
        await client.account.create({ data: { id: accountId, publicKey: prefix, encryptionMode: "plain" } });
        try {
            await client.session.createMany({ data: sessionIds.map(id => ({ id, accountId, tag: id, metadata: "{}",
                latestTurnId: "current", latestTurnStatus: "failed", seq: 20 })) });
            await client.sessionTurn.createMany({ data: sessionIds.flatMap(sessionId => [
                { sessionId, turnId: "historical", status: "failed", startedAt: 1, updatedAt: 30,
                    transcriptAnchorsJson: JSON.stringify({ endSeqInclusive: 3 }) },
                { sessionId, turnId: "current", status: "failed", startedAt: 2, updatedAt: 20,
                    transcriptAnchorsJson: JSON.stringify({ endSeqInclusive: 12 }) },
            ]) });
            const rows = await client.session.findMany({ where: { accountId },
                select: { id: true, latestTurnId: true, latestTurnStatus: true } });
            await drainQueryEvents();
            queries.length = 0;
            const sequences = await loadSessionLatestFailureSequencesInTx(client, rows);
            await drainQueryEvents();
            expect(sequences.size).toBe(sessionIds.length);
            expect([...sequences.values()].every(seq => seq === 12)).toBe(true);
            const anchorReads = queries.filter(query => query.query.startsWith("SELECT"));
            expect(anchorReads).toHaveLength(3);
            expect(anchorReads.every(query => JSON.parse(query.params).length <= 999)).toBe(true);
            queries.length = 0;
            expect(await loadSessionLatestFailureSequencesInTx(client, rows.map(row => ({ ...row, latestTurnStatus: "completed" }))))
                .toEqual(new Map());
            expect(queries).toHaveLength(0);
        } finally {
            await client.session.deleteMany({ where: { accountId } });
            await client.account.delete({ where: { id: accountId } });
        }
    });

    it("reuses captured membership facts while preserving rollback and current collective access", async () => {
        const prefix = `query-plan-${randomUUID()}`;
        const accountId = `${prefix}-viewer`;
        const sessionCount = 2748;
        const ownedSessionCount = 1413;
        const pageSize = 200;
        const teamCount = 16;
        const sessionIds = Array.from({ length: sessionCount }, (_, i) => `${prefix}-session-${i}`);
        const teamIds = Array.from({ length: teamCount }, (_, i) => `${prefix}-team-${i}`);
        await client.account.createMany({ data: Array.from({ length: 200 }, (_, i) => ({
            id: i === 0 ? accountId : `${prefix}-account-${i}`, publicKey: `${prefix}-key-${i}`, encryptionMode: "plain",
        })) });
        try {
            await client.team.createMany({ data: teamIds.map(id => ({ id, name: id })) });
            await client.teamMembership.createMany({ data: Array.from({ length: 27 }, (_, i) => ({
                teamId: teamIds[i % teamCount], accountId: i === 0 ? accountId : `${prefix}-account-${i}`,
                role: "member", sessionAccessStartsAt: null,
            })) });
            await client.teamGroup.create({ data: {
                id: `${prefix}-group`, teamId: teamIds[0], name: storedPlainPrivateLabel("Group"),
            } });
            await client.session.createMany({ data: sessionIds.map((id, i) => ({
                id, accountId: i < ownedSessionCount ? accountId : `${prefix}-account-${(i % 199) + 1}`,
                tag: id, metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
                meaningfulActivityAt: new Date(i),
            })) });
            await client.sessionTurn.createMany({ data: sessionIds.map(sessionId => ({
                sessionId, turnId: "turn", status: "completed", startedAt: 1, updatedAt: 2,
                rollbackState: "eligible", transcriptAnchorsJson: '{"startUserMessageSeq":3}',
            })) });
            await client.sessionGrant.createMany({ data: (sessionIds.slice(0, 4).map(sessionId => ({
                sessionId, teamId: teamIds[0], effectiveAt: new Date(1),
            }))).map(data => ({ ...data, principalKind: 'team' })) });
            await client.sessionGrant.createMany({ data: (sessionIds.slice(0, 4).map(sessionId => ({
                sessionId, teamGroupId: `${prefix}-group`, effectiveAt: new Date(1),
            }))).map(data => ({ ...data, principalKind: 'group' })) });
            await client.sessionGrant.deleteMany({ where: { principalKind: 'team', sessionId: { in: sessionIds } } });
            await client.sessionGrant.deleteMany({ where: { principalKind: 'group', sessionId: { in: sessionIds } } });
            // Fresh sparse grant tables have reltuples=-1 until analyzed. This
            // is the observed hot database topology, not a planner override.
            await client.$executeRawUnsafe('ANALYZE "Session", "Team", "TeamMembership", "Account", "SessionTurn"');
            queries.length = 0;
            const measured = await client.$transaction(async reader => {
                const access = await resolveEffectiveSessionAccessWhere({
                    tx: reader, accountId, capability: "readTranscript", mode: "effective_access_v1",
                    authentication: createPresentUserSessionAccessAuthentication(),
                });
                await drainQueryEvents();
                queries.length = 0;
                const read = async (kind: "baseline" | "snapshot" | "legacy") => {
                    const started = performance.now();
                    const rows = await findV2SessionListRows({
                        userId: accountId, orderBy: V2_SESSION_LIST_ORDER_BY, take: pageSize,
                        source: { kind: "effective", reader, baseWhere: { accountId },
                            accessMode: kind === "legacy" ? "legacy_owner_or_direct" : "effective_access_v1",
                            qualifiedTeamIds: access.qualifiedTeamIds,
                            ...(kind === "baseline" ? {} : { collectiveAccessSnapshot: access.collectiveAccessSnapshot }) },
                    });
                    const elapsedMs = performance.now() - started;
                    await drainQueryEvents();
                    return { kind, rows, elapsedMs, queries: queries.splice(0) };
                };
                return [await read("baseline"), await read("snapshot"), await read("legacy")];
            }, { isolationLevel: "RepeatableRead", timeout: 120_000 });
            const rows = measured[1].rows;
            expect(rows).toEqual(measured[0].rows);
            expect(rows).toEqual(measured[2].rows);
            const captured = measured.flatMap(result => result.queries
                .filter(query => query.query.startsWith("SELECT") && !query.query.includes("pg_"))
                .map((query, i) => ({ ...query, label: `${result.kind}-${i}` })));
            // A list question must never read full Session documents, including
            // through one of its relation/subquery projections.
            expect(captured.length).toBeGreaterThan(0);
            expect(captured.some(query => query.query.includes('."displayProjectionV1"'))).toBe(true);
            for (const query of captured) {
                expect(query.query).not.toMatch(/\."(?:metadata|ownerMetadata|agentState)"(?:\s|,|\))/);
            }
            const logDetails = process.env.HAPPIER_TEST_SESSION_QUERY_PLAN_LOG === "1";
            if (logDetails) console.info("DBPERF_QUERY", JSON.stringify({ queries: captured.map(query => ({
                label: query.label, query: query.query, params: JSON.parse(query.params), actorId: accountId,
                sessionIds: rows.map(row => row.id),
            })) }));
            const plans: Array<{ label: string; executionMs: number; membershipLoops: number; plan: PlanNode }> = [];
            for (const query of captured) {
                const explained = await client.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number }> }>>(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`, ...JSON.parse(query.params),
                );
                const plan = explained[0]["QUERY PLAN"][0];
                plans.push({ label: query.label, executionMs: plan["Execution Time"],
                    membershipLoops: relationLoops(plan.Plan, "TeamMembership"), plan: plan.Plan });
            }
            console.info("DBPERF_PLAN", JSON.stringify({ sessionCount, ownedSessionCount, pageSize, teamCount,
                timings: measured.map(({ kind, elapsedMs }) => ({ kind, elapsedMs })),
                plans: plans.map(plan => logDetails ? plan : { ...plan, plan: undefined }),
            }));
            expect(rows.map(row => row.id)).toEqual(sessionIds.slice(0, ownedSessionCount).reverse().slice(0, pageSize));
            const projected = mapV2SessionListRows({ rows, userId: accountId, qualifiedTeamIds: new Set(teamIds) });
            expect(projected.sessions).toHaveLength(pageSize);
            expect(projected.sessions.every(row => row.rollbackEligibleTurnStarts?.includes(3))).toBe(true);
            // With no grants, no Team membership can contribute to the page.
            // A membership-first inverse join must not multiply work across
            // every selected Session merely to rediscover empty grant tables.
            expect(plans.filter(plan => !plan.label.startsWith("baseline"))
                .reduce((sum, plan) => sum + plan.membershipLoops, 0)).toBe(0);

            // The optimization cannot discard collective facts: a real shared
            // row must retain its stronger Group grant beside its Team grant.
            const sharedId = `${prefix}-shared`;
            sessionIds.push(sharedId);
            await client.session.create({ data: {
                id: sharedId, accountId: `${prefix}-account-1`, tag: sharedId,
                metadata: '{"v":1}', metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
                encryptionMode: "plain", currentStorageState: "hosted",
            } });
            const membership = await client.teamMembership.findUniqueOrThrow({
                where: { teamId_accountId: { teamId: teamIds[0], accountId } },
            });
            await client.teamGroupMembership.create({ data: {
                teamId: teamIds[0], teamGroupId: `${prefix}-group`, teamMembershipId: membership.id,
                nativeContribution: true, sessionAccessStartsAt: null,
            } });
            await client.sessionGrant.createMany({ data: [
                { principalKind: 'team', sessionId: sharedId, teamId: teamIds[0], effectiveAt: new Date(1), accessLevel: "view" },
                { principalKind: 'team', sessionId: sharedId, teamId: teamIds[1], effectiveAt: new Date(1), accessLevel: "admin" },
            ] });
            await client.sessionGrant.create({ data: { principalKind: 'group',
                sessionId: sharedId, teamGroupId: `${prefix}-group`, effectiveAt: new Date(1), accessLevel: "edit",
            } });
            const readShared = async () => await client.$transaction(async reader => {
                const access = await resolveEffectiveSessionAccessWhere({
                    tx: reader, accountId, capability: "readTranscript", mode: "effective_access_v1",
                    authentication: createPresentUserSessionAccessAuthentication(),
                });
                const rows = await findV2SessionListRows({ userId: accountId, orderBy: { id: "asc" },
                    where: { id: sharedId }, source: { kind: "effective", reader, baseWhere: access.where,
                        accessMode: "effective_access_v1", qualifiedTeamIds: access.qualifiedTeamIds,
                        ...{ collectiveAccessSnapshot: access.collectiveAccessSnapshot } },
                });
                const ownerAccountModes = await readSessionMetadataOwnerAccountModes(reader, rows.map(row => row.accountId));
                return mapV2SessionListRows({ rows, userId: accountId, qualifiedTeamIds: access.qualifiedTeamIds, ownerAccountModes }).sessions;
            }, { isolationLevel: "RepeatableRead", timeout: 120_000 });
            expect(await readShared()).toMatchObject([{ id: sharedId, effectiveAccess: { level: "edit" } }]);
            await client.teamMembership.update({ where: { id: membership.id }, data: { role: "guest" } });
            expect(await readShared()).toMatchObject([{ id: sharedId, effectiveAccess: { level: "edit" } }]);
            await client.teamGroup.update({ where: { id: `${prefix}-group` }, data: { archivedAt: new Date() } });
            expect(await readShared()).toEqual([]);
            await client.teamGroup.update({ where: { id: `${prefix}-group` }, data: { archivedAt: null } });
            expect(await readShared()).toMatchObject([{ id: sharedId, effectiveAccess: { level: "edit" } }]);
            await client.teamGroupMembership.update({
                where: { teamGroupId_teamMembershipId: { teamGroupId: `${prefix}-group`, teamMembershipId: membership.id } },
                data: { sessionAccessStartsAt: new Date(1) },
            });
            expect(await readShared()).toEqual([]);
            await client.teamMembership.update({ where: { id: membership.id }, data: { role: "member" } });
            expect(await readShared()).toMatchObject([{ id: sharedId, effectiveAccess: { level: "view" } }]);
            await client.teamMembership.delete({ where: { id: membership.id } });
            const rejoined = await client.teamMembership.create({ data: {
                teamId: teamIds[0], accountId, role: "member", sessionAccessStartsAt: new Date(1),
            } });
            expect(rejoined.id).not.toBe(membership.id);
            expect(await readShared()).toEqual([]);
            await client.teamMembership.update({ where: { id: rejoined.id }, data: { sessionAccessStartsAt: null } });
            expect(await readShared()).toMatchObject([{ id: sharedId, effectiveAccess: { level: "view" } }]);
            await client.team.update({ where: { id: teamIds[0] }, data: { archivedAt: new Date() } });
            expect(await readShared()).toEqual([]);
        } finally {
            await client.session.deleteMany({ where: { id: { in: sessionIds } } });
            await client.team.deleteMany({ where: { id: { in: teamIds } } });
            await client.account.deleteMany({ where: { publicKey: { startsWith: `${prefix}-key-` } } });
        }
    }, 180_000);
});
