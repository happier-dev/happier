import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrincipalRefV1 } from "@happier-dev/protocol/teams/principal";
import { resolveSessionAccessPrincipalsInTx } from "./sessionAccessPrincipalResolution";
import { resolveShareSubjectsInTx } from "@/app/teams/shareEligibility";
import { classifySubjectsExternalToTeamInTx } from "./sessionAccessExternalSharingPolicy";
import { teamsPolicyStillRequireGrants } from "./sessionAccessGrantService";
import { listSessionTeamCredentialBindingConsequencesInTx } from "@/app/teams/credentials/sessionBinding";
import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Selected Session principals query cost (PostgreSQL)", () => {
    let client: PrismaClientType;
    let selects = 0;
    let selectStatements: string[] = [];

    beforeAll(async () => {
        client = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(client, (event) => {
            if (/^\s*SELECT\b/i.test(event.query)) {
                selects++;
                selectStatements.push(JSON.stringify([event.query, event.params]));
            }
        });
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    it("reads required-Team floors beyond the bind boundary without truncation", async () => {
        const ids = Array.from({ length: 35_001 }, (_, index) => `absent-team-${index}`);
        const required = await client.$transaction(tx => teamsPolicyStillRequireGrants(tx, ids));
        expect([...required]).toEqual([]);
    });

    it("reads credential binding consequences beyond the Team bind boundary", async () => {
        const teamIds = Array.from({ length: 35_001 }, (_, index) => `absent-team-${index}`);
        const consequences = await client.$transaction(tx => listSessionTeamCredentialBindingConsequencesInTx(tx, {
            sessionId: "absent-session", teamIds, actorAccountId: "absent-actor",
        }));
        expect(consequences).toEqual([]);
    });

    it("resolves 120 selected Groups with the same SQL budget as one, preserving current refusals", async () => {
        const actor = await client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "e2ee" } });
        const friend = await client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "e2ee" } });
        const team = await client.team.create({ data: { name: `Principal cost ${randomUUID()}` } });
        try {
            await client.userRelationship.create({ data: { fromUserId: actor.id, toUserId: friend.id, status: "friend" } });
            const membership = await client.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
            const groups = Array.from({ length: 120 }, (_, index) => ({ id: randomUUID(), teamId: team.id, name: storedPlainPrivateLabel(`Group ${index}`) }));
            await client.teamGroup.createMany({ data: groups });
            const subjects: PrincipalRefV1[] = [
                { kind: "team", teamId: team.id },
                ...groups.map(group => ({ kind: "group" as const, teamId: team.id, groupId: group.id })),
            ];
            const resolve = async (selected: readonly PrincipalRefV1[], evidence: boolean = false) => {
                selects = 0;
                selectStatements = [];
                const value = await client.$transaction(tx => resolveSessionAccessPrincipalsInTx({
                    tx, actorAccountId: actor.id, subjects: selected,
                    creationTeamId: team.id,
                    authentication: { env: { ...process.env, HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" }, authority: "present_user", authenticationEvidence: evidence
                        ? [{ kind: "home_method", methodId: "key_challenge" }] : [] },
                }), { isolationLevel: "RepeatableRead" });
                return { value, selects, selectStatements };
            };
            const single = await resolve([subjects[0]!, subjects[1]!]);
            const page = await resolve(subjects);
            expect(page.value.principals).toHaveLength(121);
            expect(page.value.creationDecision?.teamId).toBe(team.id);
            console.info("SESSION_PRINCIPALS_QUERY_COST", { oneGroup: single.selects, groups120: page.selects });
            expect(page.selects).toBe(single.selects);
            // This read performs no writes: an identical query and binding set
            // must reuse the same transaction's admitted facts.
            const repeatedSelects = page.selectStatements.filter((statement, index, statements) => statements.indexOf(statement) !== index);
            console.info("SESSION_PRINCIPALS_REPEATED_SELECTS", repeatedSelects);
            expect(repeatedSelects).toEqual([]);

            await client.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            expect((await resolve(subjects)).value).toEqual({ v: 1, principals: [], creationDecision: null });
            await client.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
            await client.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } } });
            expect((await resolve(subjects)).value).toEqual({ v: 1, principals: [], creationDecision: null });
            expect((await resolve(subjects, true)).value.principals).toHaveLength(121);
            await client.teamGroup.update({ where: { id: groups[0]!.id }, data: { archivedAt: new Date() } });
            const filtered = await resolve([
                subjects[1]!,
                { kind: "group", teamId: "another-team", groupId: groups[1]!.id },
                subjects[2]!, subjects[2]!,
            ], true);
            expect(filtered.value.principals).toEqual([{ kind: "group", teamId: team.id, groupId: groups[1]!.id,
                name: groups[1]!.name, teamName: team.name }]);
            // A selected set can exceed PostgreSQL's bind boundary. Missing IDs
            // exercise the real query shape without seeding an unrelated inventory.
            const beyondBindBoundary = await resolve([
                subjects[2]!, ...Array.from({ length: 35_000 }, (_, index) => ({
                    kind: "group" as const, teamId: team.id, groupId: `absent-group-${index}`,
                })),
            ], true);
            expect(beyondBindBoundary.value.principals).toEqual(filtered.value.principals);
            console.info("SESSION_PRINCIPALS_BIND_BOUNDARY", { selected: 35_001, selects: beyondBindBoundary.selects });
            const initialSubjects: PrincipalRefV1[] = [subjects[2]!, ...Array.from({ length: 35_000 }, (_, index) => ({
                kind: "group" as const, teamId: team.id, groupId: `absent-group-${index}`,
            }))];
            for (const [hasExistingGrant, removingExistingGrant] of [[false, false], [true, false], [true, true]] as const) {
                selects = 0;
                const eligibility = await client.$transaction(tx => resolveShareSubjectsInTx(tx, {
                    actorAccountId: actor.id, resourceOwnerAccountId: actor.id, subjects: initialSubjects, hasExistingGrant, removingExistingGrant,
                }), { isolationLevel: "RepeatableRead" });
                expect(eligibility[0]?.eligibility.ok).toBe(true);
                expect(eligibility.slice(1).every(row => !row.eligibility.ok && row.eligibility.error === "subject_not_found")).toBe(true);
                console.info("SESSION_GRANT_ELIGIBILITY_BIND_BOUNDARY", { selected: initialSubjects.length, hasExistingGrant, removingExistingGrant, selects });
            }
            const beyondTeamBindBoundary = await resolve([
                subjects[0]!, ...Array.from({ length: 35_000 }, (_, index) => ({
                    kind: "team" as const, teamId: `absent-team-${index}`,
                })),
            ], true);
            expect(beyondTeamBindBoundary.value.principals).toEqual([{ kind: "team", teamId: team.id, name: team.name }]);
            console.info("SESSION_PRINCIPALS_TEAM_BIND_BOUNDARY", { selected: 35_001, selects: beyondTeamBindBoundary.selects });
            const accountSubjects: PrincipalRefV1[] = [{ kind: "account", accountId: friend.id }, ...Array.from({ length: 35_000 }, (_, index) => ({
                kind: "account" as const, accountId: `absent-account-${index}`,
            }))];
            const accounts = await resolve(accountSubjects, true);
            expect(accounts.value.principals.map(principal => principal.kind === "account" ? principal.accountId : null)).toEqual([friend.id]);
            const accountEligibility = await client.$transaction(tx => resolveShareSubjectsInTx(tx, {
                actorAccountId: actor.id, resourceOwnerAccountId: actor.id, subjects: accountSubjects, hasExistingGrant: false,
            }), { isolationLevel: "RepeatableRead" });
            expect(accountEligibility[0]?.eligibility.ok).toBe(true);
            const externality = await client.$transaction(tx => classifySubjectsExternalToTeamInTx(tx, {
                primaryTeamId: team.id, subjects: [{ kind: "account", accountId: actor.id }, ...accountSubjects],
            }), { isolationLevel: "RepeatableRead" });
            expect(externality[0]).toBe(false);
            expect(externality.slice(1).every(Boolean)).toBe(true);
            console.info("SESSION_ACCOUNT_SELECTION_BIND_BOUNDARY", { selected: accountSubjects.length, principals: accounts.value.principals.length });
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [actor.id, friend.id] } } });
        }
    });
});
