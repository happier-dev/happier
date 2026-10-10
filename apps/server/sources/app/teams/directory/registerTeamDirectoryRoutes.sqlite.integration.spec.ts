import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerTeamDirectoryRoutes } from "./registerTeamDirectoryRoutes";

describe("Team directory routes", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-directory-routes-",
            initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        app = createAuthenticatedTestApp();
        registerTeamDirectoryRoutes(app);
        await app.ready();
    }, 180_000);

    afterEach(() => harness.resetEnv());

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    it("binds the REST surface to current Team authority and typed lifecycle results", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: "Directory route Team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS", config: { v: 1, kind: "workos_sso" } },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "active",
                displayName: "Primary directory",
                externalSourceKey: `workos:${crypto.randomUUID()}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_1" },
                teamIdentityConnectionId: connection.id,
                lastAttemptAt: new Date(),
                lastSuccessAt: new Date(),
                lastFullReconcileAt: new Date(),
            },
        });
        const auth = (accountId: string) => ({ "x-test-user-id": accountId });

        const forbidden = await app.inject({
            method: "GET",
            url: `/v1/teams/${team.id}/directory-sources`,
            headers: auth(member.id),
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: "team_forbidden" });

        const listed = await app.inject({
            method: "GET",
            url: `/v1/teams/${team.id}/directory-sources?limit=25`,
            headers: auth(owner.id),
        });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toMatchObject({
            items: [{
                id: source.id,
                allowedActions: [
                    "teams.directory.sources.sync",
                    "teams.directory.sources.pause",
                    "teams.directory.sources.remove",
                ],
            }],
            nextCursor: null,
        });

        const removalImpact = await app.inject({
            method: "GET",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}/removal-impact`,
            headers: auth(owner.id),
        });
        expect(removalImpact.statusCode).toBe(200);
        expect(removalImpact.json()).toMatchObject({
            v: 1,
            status: "allowed",
            sourceId: source.id,
            sourceLabel: "Primary directory",
            impact: {
                teamMembershipsRemoved: 0,
                groupMembershipsRemoved: 0,
                groupContributionsRemoved: 0,
            },
        });

        const requested = await app.inject({
            method: "POST",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}/sync`,
            headers: auth(owner.id),
            payload: { v: 1 },
        });
        expect(requested.statusCode).toBe(202);
        expect(requested.json()).toMatchObject({ v: 1, status: "requested", source: { id: source.id } });

        const paused = await app.inject({
            method: "POST",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}/pause`,
            headers: auth(owner.id),
            payload: { v: 1 },
        });
        expect(paused.statusCode).toBe(200);
        expect(paused.json()).toMatchObject({ id: source.id, state: "paused" });

        const removed = await app.inject({
            method: "DELETE",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}`,
            headers: auth(owner.id),
            payload: { v: 1 },
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toMatchObject({ v: 1, status: "removed" });
    });

    it("binds external Group mapping list, set, and exact removal to the resource routes", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: `Mapping route ${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS", enabled: true, config: { v: 1, kind: "workos_sso" } },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                externalReference: { v: 1, kind: "workos_sso", organizationId: "org_mapping", connectionId: null },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "active",
                displayName: "Directory",
                externalSourceKey: `workos:${crypto.randomUUID()}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_mapping" },
                teamIdentityConnectionId: connection.id,
            },
        });
        await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "engineering",
                externalDisplayName: "Engineering",
                state: "active",
            },
        });
        const target = await db.teamGroup.create({
            data: { teamId: team.id, name: "Developers", nameKey: "developers" },
        });
        const headers = { "x-test-user-id": owner.id };

        const set = await app.inject({
            method: "PUT",
            url: `/v1/teams/${team.id}/external-group-bindings`,
            headers,
            payload: {
                v: 1,
                owner: { kind: "directory_source", directorySourceId: source.id },
                externalGroupId: "engineering",
                target: { kind: "native_target", teamGroupId: target.id },
            },
        });
        expect(set.statusCode).toBe(200);
        expect(set.json()).toMatchObject({ mode: "native_target", target: { teamGroupId: target.id } });

        const listed = await app.inject({
            method: "GET",
            url: `/v1/teams/${team.id}/external-group-bindings?ownerKind=directory_source&directorySourceId=${source.id}`,
            headers,
        });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toMatchObject({ items: [{ id: set.json().id }], nextCursor: null });

        const removed = await app.inject({
            method: "DELETE",
            url: `/v1/teams/${team.id}/external-group-bindings/${set.json().id}`,
            headers,
            payload: { v: 1 },
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({ v: 1, outcome: "removed" });
    });

    it("requires the exact credential to satisfy a restricted Team before a directory mutation", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" });
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({
            data: {
                name: `Restricted directory ${crypto.randomUUID()}`,
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS", enabled: true, config: { v: 1, kind: "workos_sso" } },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "workos_sso", organizationId: "org_restricted", connectionId: null },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "active",
                displayName: "Restricted directory",
                externalSourceKey: `workos:${crypto.randomUUID()}`,
                bindingConfig: { v: 1, kind: "workos_directory" },
                teamIdentityConnectionId: connection.id,
            },
        });

        const denied = await app.inject({
            method: "POST",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}/sync`,
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1 },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toEqual({ error: "team_authentication_required" });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ manualSyncRequestedAt: null });

        const allowed = await app.inject({
            method: "POST",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}/sync`,
            headers: {
                "x-test-user-id": owner.id,
                "x-test-authentication-evidence": JSON.stringify([
                    { kind: "home_method", methodId: "key_challenge" },
                ]),
            },
            payload: { v: 1 },
        });
        // Qualification succeeds and the directory owner then applies its
        // independent sync contract: this fixture's binding document names no
        // directory, which the owner reports as its own typed reason.
        expect(allowed.statusCode, allowed.body).toBe(409);
        expect(allowed.json()).toEqual({ error: "directory_source_identity_mismatch" });

        await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "engineering",
                externalDisplayName: "Engineering",
                state: "active",
            },
        });
        const target = await db.teamGroup.create({
            data: { teamId: team.id, name: "Restricted target", nameKey: "restricted target" },
        });
        const deniedBinding = await app.inject({
            method: "PUT",
            url: `/v1/teams/${team.id}/external-group-bindings`,
            headers: { "x-test-user-id": owner.id },
            payload: {
                v: 1,
                owner: { kind: "directory_source", directorySourceId: source.id },
                externalGroupId: "engineering",
                target: { kind: "native_target", teamGroupId: target.id },
            },
        });
        expect(deniedBinding.statusCode).toBe(403);
        expect(deniedBinding.json()).toEqual({ error: "team_authentication_required" });
        await expect(db.teamExternalGroupBinding.count({
            where: { teamId: team.id, directorySourceId: source.id },
        })).resolves.toBe(0);

        const allowedBinding = await app.inject({
            method: "PUT",
            url: `/v1/teams/${team.id}/external-group-bindings`,
            headers: {
                "x-test-user-id": owner.id,
                "x-test-authentication-evidence": JSON.stringify([
                    { kind: "home_method", methodId: "key_challenge" },
                ]),
            },
            payload: {
                v: 1,
                owner: { kind: "directory_source", directorySourceId: source.id },
                externalGroupId: "engineering",
                target: { kind: "native_target", teamGroupId: target.id },
            },
        });
        expect(allowedBinding.statusCode).toBe(200);
        expect(allowedBinding.json()).toMatchObject({
            owner: { kind: "directory_source", directorySourceId: source.id },
            target: { teamGroupId: target.id },
        });

        harness.resetEnv({ HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" });
        const unavailable = await app.inject({
            method: "POST",
            url: `/v1/teams/${team.id}/directory-sources/${source.id}/sync`,
            headers: {
                "x-test-user-id": owner.id,
                "x-test-authentication-evidence": JSON.stringify([
                    { kind: "home_method", methodId: "key_challenge" },
                ]),
            },
            payload: { v: 1 },
        });
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json()).toEqual({ error: "team_authentication_unavailable" });
    });
});
