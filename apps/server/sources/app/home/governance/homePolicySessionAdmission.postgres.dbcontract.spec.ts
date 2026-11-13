import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerSessionFollowRoutes } from "@/app/api/routes/session/registerSessionFollowRoutes";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { readTeamAuthenticationConnectionDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { encryptIdentityProviderSecrets } from "@/app/auth/providers/managed/identityProviderSecretCipher";
import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from "@happier-dev/protocol/changes";
import { HomeGovernancePolicySetInputV1Schema } from "@happier-dev/protocol/home/governance";
import { HOME_GOVERNANCE_POLICY_ID, setHomeGovernancePolicy } from "./governancePolicy";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Home policy Session admission fence", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        process.env.HANDY_MASTER_SECRET ??= "r36-disposable-contract";
        await initEncrypt();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["teamProviderPolicy", "identityNetworkPolicy"] as const)(
        "re-admits a regular member after a held %s writer commits", async field => {
            // This file owns the singleton only inside its explicitly disposable database.
            await db.homeGovernancePolicy.deleteMany({ where: { id: HOME_GOVERNANCE_POLICY_ID } });
            const owner = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
            const member = await db.account.create({ data: { homeRole: "member", encryptionMode: "plain" } });
            const sessionOwner = await db.account.create({ data: { homeRole: "member", encryptionMode: "plain" } });
            const env = {
                ...process.env,
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
                HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED: "true",
            };
            const team = await db.team.create({ data: { name: "Policy fence" } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member", status: "active" } });
            const providerId = randomUUID();
            await db.identityProviderInstance.create({ data: {
                id: providerId, ownerTeamId: team.id, kind: "oidc", displayName: "Fixture SSO", enabled: true,
                config: { v: 1, kind: "oidc", issuer: "https://id.example.test", clientId: "happier",
                    clientAuthenticationMethod: "client_secret_post", scopes: "openid profile email", httpTimeoutSeconds: 30,
                    claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: "oidc" } },
                encryptedSecrets: encryptIdentityProviderSecrets({ id: providerId, kind: "oidc",
                    secrets: { v: 1, kind: "oidc", clientSecret: "disposable-fixture" } }),
            } });
            const connection = await db.teamIdentityConnection.create({ data: {
                teamId: team.id, providerInstanceId: providerId, enabled: true,
                externalReference: { v: 1, kind: "oidc" },
                settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            } });
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "team_connection", connectionId: connection.id }],
            } } });
            const session = await db.session.create({ data: { accountId: sessionOwner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
            await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: session.id, teamId: team.id, accessLevel: "edit", effectiveAt: new Date() } });
            const identity = await db.accountIdentity.create({ data: {
                accountId: member.id, provider: providerId, providerUserId: randomUUID(), profile: {}, eligibilityStatus: "eligible",
            } });
            const descriptors = await inReadSnapshot(tx => readTeamAuthenticationConnectionDescriptorsInTx(tx, {
                env, references: [{ teamId: team.id, id: connection.id }],
            }));
            const descriptor = [...descriptors.values()][0];
            expect(descriptor?.status).toBe("ready");
            if (descriptor?.status !== "ready" || descriptor.descriptor === null) throw new Error("Fixture SSO descriptor is unavailable");
            const reference = descriptor.descriptor.reference;
            const evidence = [{ kind: "provider", providerId, identityId: identity.id, teamConnectionId: connection.id,
                runtimeFingerprint: reference.runtimeFingerprint }];
            const originalPublicUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
            const originalPrivateNetwork = process.env.HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED;
            process.env.HAPPIER_PUBLIC_SERVER_URL = env.HAPPIER_PUBLIC_SERVER_URL;
            process.env.HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED = "true";
            const ready = deferred(), release = deferred();
            const transaction = db.$transaction;
            let holdNext = false;
            // Pause the real policy callback after all its writes, before commit.
            // No policy, access, or publication implementation is replaced.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (!holdNext || typeof callback !== "function") return Reflect.apply(target, receiver, args);
                holdNext = false;
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const result = await callback(tx);
                    ready.resolve();
                    await release.promise;
                    return result;
                }, ...args.slice(1)]);
            } });
            try {
                await withAuthenticatedTestApp(registerSessionFollowRoutes, async app => {
                    const headers = { "x-test-user-id": member.id, "x-test-authentication-evidence": JSON.stringify(evidence) };
                    const url = `/v2/sessions/${session.id}/delivery-mutes`;
                    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
                    holdNext = true;
                    const policy = setHomeGovernancePolicy({ actorAccountId: owner.id, env, patch: HomeGovernancePolicySetInputV1Schema.parse({
                        expectedRevision: 0,
                        ...(field === "teamProviderPolicy" ? { teamProviderPolicy: {
                            v: 1 as const, allowedTeamProviderKinds: [], teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [],
                        } } : { identityNetworkPolicy: {
                            v: 1 as const, mode: "private_allowlist" as const, hostnames: ["id.example.test"], cidrs: ["10.20.0.0/16"], ports: [443],
                        } }),
                    }) });
                    await Promise.race([ready.promise, policy.then(() => { throw new Error("Policy did not reach its commit boundary"); })]);
                    const mutation = app.inject({ method: "PUT", url, headers,
                        payload: { scope: { kind: "sender_session", sessionId: session.id } } });
                    let settled = false;
                    void mutation.finally(() => { settled = true; }).catch(() => undefined);
                    try {
                        while (!settled) {
                            const [{ waiting }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                                `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                    AND wait_event_type = 'Lock' AND query LIKE '%"Account"%') AS waiting`,
                            );
                            if (waiting) break;
                        }
                    } finally { release.resolve(); }
                    const [changed, response] = await Promise.all([policy, mutation]);
                    expect(changed.status).toBe("applied");
                    if (field === "identityNetworkPolicy") {
                        const current = await inReadSnapshot(tx => readTeamAuthenticationConnectionDescriptorsInTx(tx, {
                            env: process.env, references: [{ teamId: team.id, id: connection.id }],
                        }));
                        const currentDescriptor = [...current.values()][0];
                        expect(currentDescriptor?.status).toBe("ready");
                        if (currentDescriptor?.status !== "ready" || currentDescriptor.descriptor === null) throw new Error("Current SSO descriptor is unavailable");
                        expect(currentDescriptor.descriptor.reference.runtimeFingerprint).not.toBe(reference.runtimeFingerprint);
                    }
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "session_not_found" });
                    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).deliveryMutes).toBeNull();
                    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
                    expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                        accountId: member.id, kind: "account", entityId: HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
                    } } })).not.toBeNull();
                });
            } finally {
                release.resolve();
                db.$transaction = transaction;
                if (originalPublicUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
                else process.env.HAPPIER_PUBLIC_SERVER_URL = originalPublicUrl;
                if (originalPrivateNetwork === undefined) delete process.env.HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED;
                else process.env.HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED = originalPrivateNetwork;
            }
        },
    );
});
