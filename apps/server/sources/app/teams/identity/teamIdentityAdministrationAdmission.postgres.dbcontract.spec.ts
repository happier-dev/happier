import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { listHomeManagedIdentityProviders } from "@/app/home/governance/homeManagedIdentityProviders";
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { listExternalGroupBindingsForActor } from "../directory/externalGroupBindingAdministration";
import { preflightTeamIdentityConnectionRemovalForActor } from "./teamIdentityConnectionAdministration";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Team identity administration admission SQL cost (PostgreSQL)", () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, "query"> | undefined;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        const version = await db.$queryRaw<Array<{ server_version: string }>>`SHOW server_version`;
        expect(version[0]?.server_version).toMatch(/^17\./);
        console.info("TEAM_IDENTITY_ADMISSION_POSTGRES_VERSION", version[0]?.server_version);
        client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        client.$on("query", event => statements.push(event));
        await client.$connect();
        vi.stubEnv("HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED", "1");
        await db.homeGovernancePolicy.create({ data: {
            id: "home", teamProviderPolicy: {
                v: 1, allowedTeamProviderKinds: ["oidc", "workos_sso"],
                teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [],
            },
        } });
    });

    afterAll(async () => {
        await client?.$disconnect();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Admission ${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", displayName: "SSO", config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: null, connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const listedProvider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "oidc", displayName: "Team OIDC", config: {
                v: 1, kind: "oidc", issuer: "https://identity.example.test", clientId: "happier",
                clientAuthenticationMethod: "client_secret_post", scopes: "openid profile email",
                httpTimeoutSeconds: 30,
                claims: { login: "preferred_username", email: "email", groups: "groups" },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: "oidc" },
            },
        } });
        return { owner, team, connection, listedProvider };
    }

    it("keeps physical SELECTs constant at one and 101 members without acquiring mutation audiences or a second binding actor", async () => {
        const f = await fixture();
        const originalTransaction = db.$transaction;
        const traced = client!;
        // Only the database transport changes: every public owner, authority,
        // credential decision and transaction body executes its real logic.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            const operations = [
                { name: "providers", run: () => listHomeManagedIdentityProviders({
                    actorAccountId: f.owner.id, owner: { kind: "team", teamId: f.team.id },
                }) },
                { name: "removal preview", run: () => preflightTeamIdentityConnectionRemovalForActor({
                    v: 1, teamId: f.team.id, actorAccountId: f.owner.id, connectionId: f.connection.id,
                    expectedRevision: 1, env: process.env,
                }) },
                { name: "bindings", run: () => listExternalGroupBindingsForActor({
                    v: 1, teamId: f.team.id, actorAccountId: f.owner.id,
                    ownerKind: "identity_connection", teamIdentityConnectionId: f.connection.id,
                }) },
            ];
            const measurements: Array<Readonly<{ members: number; operations: Array<Readonly<{
                name: string; selects: number; teamSelects: number; audienceSelects: number;
                membershipAudienceSelects: number; providerItems: number | null;
            }>> }>> = [];
            for (const members of [1, 101]) {
                if (members > 1) {
                    const accounts = Array.from({ length: members - 1 }, () => ({
                        id: crypto.randomUUID(), encryptionMode: "plain" as const,
                    }));
                    await db.account.createMany({ data: accounts });
                    await db.teamMembership.createMany({ data: accounts.map(account => ({
                        teamId: f.team.id, accountId: account.id, role: "member" as const,
                    })) });
                }
                const measured = [];
                for (const operation of operations) {
                    await operation.run(); // Exclude first-use connection/module initialization.
                    statements.length = 0;
                    const result = await operation.run();
                    expect("status" in result ? result.status === "ready" : result.ok).toBe(true);
                    if (operation.name === "providers") {
                        expect("instances" in result && result.instances.some(resolved =>
                            resolved.status === "ready" && resolved.instance.id === f.listedProvider.id)).toBe(true);
                    }
                    const selects = statements.filter(({ query }) => /^\s*SELECT\b/.test(query));
                    measured.push({
                        name: operation.name,
                        providerItems: "instances" in result ? result.instances.length : null,
                        selects: selects.length,
                        teamSelects: selects.filter(({ query }) => /\bFROM\s+"[^"]+"\."Team"(?:\s|$)/.test(query)).length,
                        audienceSelects: selects.filter(({ query }) => /\b(?:FROM|JOIN)\s+"[^"]+"\."(?:Session|Machine)"(?:\s|$)/.test(query)).length,
                        membershipAudienceSelects: selects.filter(({ query }) => {
                            const projection = query.split(/\bFROM\b/, 1)[0] ?? "";
                            return /\bFROM\s+"[^"]+"\."TeamMembership"(?:\s|$)/.test(query)
                                && /\."accountId"/.test(projection)
                                && !/\."(?:id|role|status)"|\bCOUNT\s*\(/i.test(projection);
                        }).length,
                    });
                }
                measurements.push({ members, operations: measured });
            }
            console.info("TEAM_IDENTITY_ADMISSION_SQL_COST", JSON.stringify(measurements));
            expect(measurements[1]!.operations).toEqual(measurements[0]!.operations);
            for (const measurement of measurements) {
                for (const operation of measurement.operations) {
                    expect(operation.selects, operation.name).toBeGreaterThan(0);
                    expect(operation.audienceSelects, operation.name).toBe(0);
                    expect(operation.membershipAudienceSelects, operation.name).toBe(0);
                    if (operation.name === "bindings") expect(operation.teamSelects).toBe(1);
                }
            }
        } finally { db.$transaction = originalTransaction; }
    });

    it("preserves principal and credential refusals, including owner-only Home removal preview", async () => {
        const f = await fixture();
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        const suspended = await db.account.create({ data: { encryptionMode: "plain" } });
        const removed = await db.account.create({ data: { encryptionMode: "plain" } });
        const otherAdmin = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const otherTeam = await db.team.create({ data: { name: "Other administration" } });
        await db.teamMembership.createMany({ data: [
            { teamId: f.team.id, accountId: member.id, role: "member" },
            { teamId: f.team.id, accountId: suspended.id, role: "admin", status: "suspended" },
            { teamId: f.team.id, accountId: removed.id, role: "admin" },
            { teamId: otherTeam.id, accountId: otherAdmin.id, role: "admin" },
        ] });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team.id, accountId: removed.id } } });
        for (const [actor, error] of [
            [member, "team_forbidden"], [suspended, "team_not_found"],
            [removed, "team_not_found"], [otherAdmin, "team_not_found"],
        ] as const) {
            await expect(listHomeManagedIdentityProviders({
                actorAccountId: actor.id, owner: { kind: "team", teamId: f.team.id },
            })).resolves.toEqual({ status: "forbidden" });
            await expect(preflightTeamIdentityConnectionRemovalForActor({
                v: 1, teamId: f.team.id, actorAccountId: actor.id, connectionId: f.connection.id,
                expectedRevision: 1, env: process.env,
            })).resolves.toEqual({ ok: false, error });
            await expect(listExternalGroupBindingsForActor({
                v: 1, teamId: f.team.id, actorAccountId: actor.id,
                ownerKind: "identity_connection", teamIdentityConnectionId: f.connection.id,
            })).resolves.toEqual({ ok: false, error });
        }
        await db.team.update({ where: { id: f.team.id }, data: { authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }],
        } } });
        const wrongCredential = {
            authenticationAuthority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        } as const;
        await expect(listHomeManagedIdentityProviders({
            actorAccountId: f.owner.id, owner: { kind: "team", teamId: f.team.id }, ...wrongCredential,
        })).resolves.toEqual({ status: "team_authentication_required" });
        await expect(preflightTeamIdentityConnectionRemovalForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.owner.id, connectionId: f.connection.id,
            expectedRevision: 1, env: process.env, ...wrongCredential,
        })).resolves.toEqual({ ok: false, error: "team_authentication_required" });
        await expect(listExternalGroupBindingsForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.owner.id, ...wrongCredential,
            ownerKind: "identity_connection", teamIdentityConnectionId: f.connection.id,
        })).resolves.toEqual({ ok: false, error: "team_authentication_required" });
        const admin = await db.account.create({ data: { homeRole: "admin", encryptionMode: "plain" } });
        await expect(preflightTeamIdentityConnectionRemovalForActor({
            v: 1, teamId: null, actorAccountId: admin.id, connectionId: "missing",
            expectedRevision: 1, env: process.env,
        })).resolves.toEqual({ ok: false, error: "home_forbidden" });
    });
});
