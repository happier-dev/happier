import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import sharp from "sharp";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { createServiceAccountTokenIdentityFields } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { NO_TEAM_CAPABILITIES_V1 } from "@happier-dev/protocol";
import { TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1 } from "@happier-dev/protocol/teams";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerTeamRoutes } from "./registerTeamRoutes";

describe("Team routes (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-routes-",
            initAuth: false,
            initFiles: true,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
            },
        });
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
            update: { teamCreationPolicy: "self_service" },
        });
        app = createAuthenticatedTestApp();
        app.addHook("preHandler", async (request: FastifyRequest) => {
            if (request.headers["x-test-team-authentication"] === "key_challenge") {
                request.authTokenAuthenticationEvidence = [{ kind: "home_method", methodId: "key_challenge" }];
            }
        });
        registerTeamRoutes(app);
        await app.ready();
    }, 180_000);

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    async function account(encryptionMode: "plain" | "e2ee" = "plain") {
        return db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode } });
    }

    async function post(
        url: string,
        actorAccountId: string | null,
        payload: unknown,
        options: Readonly<{ teamAuthentication?: "key_challenge" }> = {},
    ) {
        return app.inject({
            method: "POST",
            url,
            headers: actorAccountId === null ? {} : {
                "x-test-user-id": actorAccountId,
                ...(options.teamAuthentication === undefined
                    ? {}
                    : { "x-test-team-authentication": options.teamAuthentication }),
            },
            payload,
        });
    }

    it("requires authentication on every Team route", async () => {
        const unauthenticated = await post("/v1/teams/list", null, { v: 1, scope: "member", archived: "active" });
        expect(unauthenticated.statusCode).toBe(401);
    });

    it("writes independent Review policy through the Team Action transport and refuses a member", async () => {
        const owner = await account();
        const member = await account();
        const created = await post("/v1/teams/create", owner.id, { v: 1, name: "Review audience", requestKey: crypto.randomUUID() });
        expect(created.statusCode, created.body).toBe(200);
        const teamId: string = created.json().id;
        await db.teamMembership.create({ data: { teamId, accountId: member.id, role: "member" } });
        const updated = await post("/v1/teams/policy/set", owner.id, { v: 1, teamId, reviewCreationPolicy: "team_required" });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json().policy).toMatchObject({ reviewCreationPolicy: "team_required", sessionCreationPolicy: "private_default" });
        const read = await post("/v1/teams/get", owner.id, { v: 1, teamId });
        expect(read.json().policy.reviewCreationPolicy).toBe("team_required");
        const refused = await post("/v1/teams/policy/set", member.id, { v: 1, teamId, reviewCreationPolicy: "private_default" });
        expect(refused.statusCode).toBe(403);
        expect((await post("/v1/teams/get", owner.id, { v: 1, teamId })).json().policy.reviewCreationPolicy).toBe("team_required");
    });

    it("writes and reads typed managed defaults through the existing Team policy transport", async () => {
        const owner = await account();
        const created = await post("/v1/teams/create", owner.id, { v: 1, name: "Managed defaults", requestKey: crypto.randomUUID() });
        expect(created.statusCode, created.body).toBe(200);
        const teamId: string = created.json().id;
        const managedDefaults = { team: { permissionModeByAgentTargetKey: { "agent:example.agent/example": "read-only" } }, groups: {} };
        const updated = await post("/v1/teams/policy/set", owner.id, { v: 1, teamId, managedDefaults });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json().policy.managedDefaults).toEqual(managedDefaults);
        const read = await post("/v1/teams/get", owner.id, { v: 1, teamId });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json().policy).toMatchObject({ managedDefaults, managedDefaultsStatus: "available" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).managedDefaults).toEqual(managedDefaults);
        const invalid = await post("/v1/teams/policy/set", owner.id, {
            v: 1, teamId, managedDefaults: { team: { permissionModeByAgentTargetKey: { "agent:example.agent/example": "invalid" } }, groups: {} },
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error).toBe("invalid_team_input");
    });

    it("serves the credential-resource lifecycle through the Team transport", async () => {
        const owner = await account();
        const created = await post("/v1/teams/create", owner.id, { v: 1, name: "Credentials", requestKey: crypto.randomUUID() });
        const teamId = created.json().id as string;
        const service = { pluginId: "route.source", localId: "subscription" };
        const accountRef = { service, accountId: "subscription-account" };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: owner.id,
            ...createServiceAccountTokenIdentityFields({ ref: accountRef, authenticationModeId: "api-key" }),
            token: Buffer.from("private-credential"),
            metadata: {
                v: 4,
                storage: "stored_envelope_v1",
                credentialRevision: "csr_aaaaaaaaaaaaaaaaaaaaaa",
                directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
                contributionContractVersion: "route-contribution-1",
                values: { scopes: [] },
            },
        } });
        const source = {
            v: 1,
            kind: "connected_account",
            target: { kind: "account", account: accountRef },
            credentialIncarnation: credential.id,
        };
        const resource = await post("/v1/teams/credential-resources/create", owner.id, {
            teamId,
            resourceId: "route-resource",
            displayName: "Shared subscription",
            source,
            deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
            sessionUsePolicy: "personal_allowed",
            brokerPlacement: null,
            requestPolicy: null,
            allMembersAllowedRoutes: null,
            groupGrants: [],
            memberGrants: [],
            usageLimits: [],
        });
        expect(resource.statusCode, resource.body).toBe(200);
        expect(resource.json().id).toBe("route-resource");
        const page = await post("/v1/teams/credential-resources/list", owner.id, { teamId });
        expect(page.json().resources.map((item: { id: string }) => item.id)).toEqual(["route-resource"]);
        // The viewer decision travels with the rows. A client cannot derive
        // resource authority from a role or from the custodian id, so a surface
        // that had to guess would either hide a control an owner has or offer
        // one the Home would refuse.
        expect(page.json().viewer).toEqual({ manageCredentials: true, offerOwnCredential: true });

        const memberAccount = await account();
        await db.teamMembership.create({ data: { teamId, accountId: memberAccount.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId, name: storedPlainPrivateLabel("Developers") } });
        const memberMembership = await db.teamMembership.findFirstOrThrow({ where: { teamId, accountId: memberAccount.id } });
        const audience = await post("/v1/teams/credential-resources/audience/set", owner.id, {
            resourceId: "route-resource", expectedRevision: 0,
            allMembersAllowedRoutes: null,
            // Direct delivery needs no broker Machine, so this case exercises
            // the projection rather than the placement rule that has its own.
            groupGrants: [{ teamGroupId: group.id, allowedRoutes: ["direct"] }],
            memberGrants: [{ teamMembershipId: memberMembership.id, allowedRoutes: ["direct"] }],
        });
        // Mutation answers remain value-free. The canonical administration
        // projection below proves the whole-audience replacement persisted;
        // callers must reconcile there rather than learn Team data from the
        // write response.
        expect(audience.json()).toEqual({ resourceId: "route-resource", revision: 1 });
        const managerPage = await post("/v1/teams/credential-resources/list", owner.id, { teamId });
        expect(managerPage.json().resources[0]).toMatchObject({
            groupGrants: [{ teamGroupId: group.id, allowedRoutes: ["direct"] }],
            memberGrants: [{ teamMembershipId: memberMembership.id, allowedRoutes: ["direct"] }],
        });

        await db.teamCredentialResource.create({
            data: {
                id: "corrupt-route-resource",
                teamId,
                custodianAccountId: owner.id,
                displayName: "Needs repair",
                disclosureCeiling: "direct_allowed",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: "not-json",
            },
        });
        const managerPageWithCorruptRow = await post("/v1/teams/credential-resources/list", owner.id, { teamId });
        expect(managerPageWithCorruptRow.json().resources.map((item: { id: string }) => item.id))
            .toEqual(["corrupt-route-resource", "route-resource"]);
        expect(managerPageWithCorruptRow.json().resources).toContainEqual(expect.objectContaining({
            id: "corrupt-route-resource",
            teamId,
            displayName: "Needs repair",
            readiness: { kind: "resource_corrupt" },
            recoveryAction: "source_owner_action",
        }));

        // The audience names other people. A member who may use the resource is
        // told their own delivery mode by the entitlement owner and never who
        // else holds a grant.
        const memberPage = await post("/v1/teams/credential-resources/list", memberAccount.id, { teamId });
        expect(memberPage.json().viewer).toEqual({ manageCredentials: false, offerOwnCredential: true });
        expect(memberPage.json().resources).toEqual([]);
        const memberCatalog = await post("/v1/teams/credential-resources/entitled/list", memberAccount.id, { teamId });
        expect(memberCatalog.json().resources).toEqual([{
            id: "route-resource",
            teamId,
            sourceOwnerDisplayName: null,
            displayName: "Shared subscription",
            resourceRevision: 1,
            readiness: { kind: "available" },
            recoveryAction: null,
            mayBroker: false,
            mayReceiveDirect: true,
            deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
            allowedRoutes: ["direct"],
            directMaterialState: "never_delivered",
            sessionUsePolicy: "personal_allowed",
            usageCapabilities: {
                costUsd: "unavailable",
                inferenceRequests: "unavailable",
                totalTokens: "unavailable",
                limitCoverage: "unavailable",
            },
            providerModels: [],
            connectedServiceSelections: [],
            sourcePresentation: { kind: "connected_service", service },
        }]);
        const updated = await post("/v1/teams/credential-resources/update", owner.id, {
            resourceId: "route-resource", expectedRevision: 1, displayName: "Renamed subscription",
        });
        // Presentation-only edits preserve the authority revision.
        expect(updated.json()).toEqual({ resourceId: "route-resource", revision: 1 });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: "route-resource" },
            select: { displayName: true, revision: true },
        })).resolves.toEqual({ displayName: "Renamed subscription", revision: 1 });
        const activity = await post("/v1/teams/credential-resources/activity/list", owner.id, {
            resourceId: "route-resource", limit: 10,
        });
        expect(activity.statusCode).toBe(200);
        expect(activity.json().items.map((event: { kind: string }) => event.kind)).toEqual([
            "resource_updated", "audience_changed", "resource_created",
        ]);
        const deleted = await post("/v1/teams/credential-resources/delete", owner.id, { resourceId: "route-resource", expectedRevision: 0 });
        expect(deleted.statusCode).toBe(409);
        const deletedAfterUpdate = await post("/v1/teams/credential-resources/delete", owner.id, { resourceId: "route-resource", expectedRevision: 1 });
        expect(deletedAfterUpdate.json()).toEqual({ resourceId: "route-resource", revision: 1 });
    });

    it("qualifies Team-derived credential-resource operations while preserving custodian withdrawal", async () => {
        const owner = await account("e2ee");
        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Restricted credentials", requestKey: crypto.randomUUID(),
        });
        const teamId = created.json().id as string;
        const service = { pluginId: "route.restricted", localId: "subscription" };
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: owner.id, groupId: "restricted-pool", servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId: "restricted-pool" }), policyJson: "{}",
        } });
        const source = {
            v: 1, kind: "connected_pool",
            target: { kind: "group", service, groupId: "restricted-pool" },
            poolIncarnation: pool.id,
        };
        await db.team.update({
            where: { id: teamId },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } },
        });

        const deniedCreate = await post("/v1/teams/credential-resources/create", owner.id, {
            teamId, resourceId: "restricted-route-resource", displayName: "Restricted subscription",
            source,
            deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
            sessionUsePolicy: "personal_allowed",
            brokerPlacement: null,
            requestPolicy: null,
            allMembersAllowedRoutes: null,
            groupGrants: [],
            memberGrants: [],
            usageLimits: [],
        });
        expect({ status: deniedCreate.statusCode, body: deniedCreate.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });

        const allowedCreate = await post(
            "/v1/teams/credential-resources/create",
            owner.id,
            {
                teamId, resourceId: "restricted-route-resource", displayName: "Restricted subscription",
                source,
                deliveryPolicy: { preferredAllowedModes: ["brokered", "direct"] },
                sessionUsePolicy: "personal_allowed",
                brokerPlacement: null,
                requestPolicy: null,
                allMembersAllowedRoutes: null,
                groupGrants: [],
                memberGrants: [],
                usageLimits: [],
            },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedCreate.statusCode).toBe(200);

        // The source owner retains the narrow, source-keyed projection needed
        // to find and withdraw their own resource. That independent authority
        // does not bypass restricted-Team authentication on Team reads.
        const deniedTeamPage = await post("/v1/teams/credential-resources/list", owner.id, { teamId });
        expect({ status: deniedTeamPage.statusCode, body: deniedTeamPage.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const sourceOwnerPage = await post(
            "/v1/teams/credential-resources/source-resources/list",
            owner.id,
            { source: { v: 1, kind: "connected_pool", target: source.target } },
        );
        expect(sourceOwnerPage.statusCode, sourceOwnerPage.body).toBe(200);
        expect(sourceOwnerPage.json().resources).toMatchObject([{
            id: "restricted-route-resource",
            capabilities: { disable: true, delete: true },
        }]);
        expect(sourceOwnerPage.body).not.toContain(teamId);

        const deniedCustodianRead = await post("/v1/teams/credential-resources/get", owner.id, {
            resourceId: "restricted-route-resource",
        });
        expect({ status: deniedCustodianRead.statusCode, body: deniedCustodianRead.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });

        const deniedManagerEdit = await post("/v1/teams/credential-resources/update", owner.id, {
            resourceId: "restricted-route-resource", expectedRevision: 0, displayName: "Manager-only edit",
        });
        expect({ status: deniedManagerEdit.statusCode, body: deniedManagerEdit.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });

        const custodianDisable = await post("/v1/teams/credential-resources/update", owner.id, {
            resourceId: "restricted-route-resource", expectedRevision: 0, enabled: false,
        });
        expect(custodianDisable.statusCode).toBe(200);

        const custodianDelete = await post("/v1/teams/credential-resources/delete", owner.id, {
            resourceId: "restricted-route-resource", expectedRevision: 1,
        });
        expect(custodianDelete.statusCode).toBe(200);
    });

    it("carries one Team through create, get, update, policy, logo, archive, and restore", async () => {
        const owner = await account();

        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Route Team", requestKey: crypto.randomUUID(),
        });
        expect(created.statusCode).toBe(200);
        const team = created.json();
        expect(team.name).toBe("Route Team");
        expect(team.viewerRole).toBe("owner");

        const fetched = await post("/v1/teams/get", owner.id, { v: 1, teamId: team.id });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().id).toBe(team.id);

        const updated = await post("/v1/teams/update", owner.id, {
            v: 1, teamId: team.id, description: "Ships things.",
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json().description).toBe("Ships things.");

        const policed = await post("/v1/teams/policy/set", owner.id, {
            v: 1, teamId: team.id, externalSharingPolicy: "team_admins_only",
        });
        expect(policed.statusCode).toBe(200);
        expect(policed.json().policy.externalSharingPolicy).toBe("team_admins_only");

        const narrowed = await post("/v1/teams/policy/set", owner.id, {
            v: 1,
            teamId: team.id,
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "email_password" }],
            },
        });
        expect({ status: narrowed.statusCode, body: narrowed.json() })
            .toEqual({
                status: 403,
                body: {
                    error: "team_authentication_required",
                },
            });

        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [
                        { kind: "home_method", methodId: "email_password" },
                        { kind: "team_connection", connectionId: "connection-z" },
                    ],
                },
            },
        });

        const staleRecovery = await post("/v1/teams/policy/set", owner.id, {
            v: 1,
            teamId: team.id,
            previousAuthenticationPolicy: null,
            authenticationPolicy: { v: 1, mode: "inherit" },
        });
        expect(staleRecovery.statusCode).toBe(409);
        expect(staleRecovery.json()).toEqual({ error: "team_authentication_policy_conflict" });

        const inherited = await post("/v1/teams/policy/set", owner.id, {
            v: 1,
            teamId: team.id,
            previousAuthenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [
                    { kind: "team_connection", connectionId: "connection-z" },
                    { kind: "home_method", methodId: "email_password" },
                ],
            },
            authenticationPolicy: { v: 1, mode: "inherit" },
        });
        expect({ status: inherited.statusCode, body: inherited.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        // The available Home method still requires qualifying evidence before
        // the owner can remove the restriction. Reset only this direct-DB
        // fixture so the unrelated route lifecycle below can continue.
        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: null },
        });

        const logo = await post("/v1/teams/logo/set", owner.id, {
            v: 1,
            teamId: team.id,
            image: {
                mimeType: "image/jpeg",
                dataBase64: (await sharp({
                    create: { width: 640, height: 480, channels: 3, background: { r: 9, g: 9, b: 9 } },
                }).jpeg().toBuffer()).toString("base64"),
            },
        });
        expect(logo.statusCode).toBe(200);
        expect(logo.json().logo.width).toBe(480);
        expect(logo.json().logo.url).toContain(`public/teams/${team.id}/logo/`);

        const removed = await post("/v1/teams/logo/remove", owner.id, { v: 1, teamId: team.id });
        expect(removed.statusCode).toBe(200);
        expect(removed.json().logo).toBeNull();

        const archived = await post("/v1/teams/archive", owner.id, { v: 1, teamId: team.id });
        expect(archived.statusCode).toBe(200);
        expect(archived.json().archivedAt).not.toBeNull();

        // The archived Team is refused for metadata and answered as a conflict,
        // not as a generic failure.
        const blocked = await post("/v1/teams/update", owner.id, { v: 1, teamId: team.id, name: "Nope" });
        // Status and body are asserted together: a mismatch that reports only the
        // status hides the body that explains it.
        expect({ status: blocked.statusCode, body: blocked.json() })
            .toEqual({ status: 409, body: { error: "team_archived" } });

        const restored = await post("/v1/teams/restore", owner.id, { v: 1, teamId: team.id });
        expect(restored.statusCode).toBe(200);
        expect(restored.json().archivedAt).toBeNull();

        const page = await post("/v1/teams/list", owner.id, { v: 1, scope: "member", archived: "active" });
        expect(page.statusCode).toBe(200);
        expect(page.json().items.map((item: { id: string }) => item.id)).toContain(team.id);
    });

    it("requires the restricted Team credential on every direct administration route", async () => {
        const owner = await account("e2ee");
        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Restricted administration", requestKey: crypto.randomUUID(),
        });
        const teamId = created.json().id as string;
        await db.team.update({
            where: { id: teamId },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });

        // The directory is not a direct administration route: an unqualified
        // credential keeps the row and loses the Team-derived capabilities on
        // it, so the viewer's other Teams and their page position survive.
        const deniedList = await post("/v1/teams/list", owner.id, {
            v: 1, scope: "member", archived: "active",
        });
        expect(deniedList.statusCode).toBe(200);
        const deniedListRow = deniedList.json().items
            .find((item: { id: string }) => item.id === teamId);
        expect(deniedListRow.viewerRole).toBe("owner");
        expect(deniedListRow.capabilities).toEqual(NO_TEAM_CAPABILITIES_V1);
        const allowedList = await post(
            "/v1/teams/list",
            owner.id,
            { v: 1, scope: "member", archived: "active" },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedList.statusCode).toBe(200);
        expect(allowedList.json().items
            .find((item: { id: string }) => item.id === teamId).capabilities.manageMembers).toBe(true);

        const deniedGet = await post("/v1/teams/get", owner.id, { v: 1, teamId });
        expect({ status: deniedGet.statusCode, body: deniedGet.json() }).toEqual({
            status: 403,
            body: { error: "team_authentication_required" },
        });
        const allowedGet = await post(
            "/v1/teams/get",
            owner.id,
            { v: 1, teamId },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedGet.statusCode).toBe(200);

        const deniedUpdate = await post("/v1/teams/update", owner.id, { v: 1, teamId, name: "Denied" });
        expect(deniedUpdate.statusCode).toBe(403);
        expect(deniedUpdate.json()).toEqual({ error: "team_authentication_required" });
        const allowedUpdate = await post(
            "/v1/teams/update",
            owner.id,
            { v: 1, teamId, name: "Qualified" },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedUpdate.statusCode).toBe(200);

        const deniedPolicy = await post("/v1/teams/policy/set", owner.id, {
            v: 1, teamId, externalSharingPolicy: "disabled",
        });
        expect(deniedPolicy.statusCode).toBe(403);
        expect(deniedPolicy.json()).toEqual({ error: "team_authentication_required" });
        const allowedPolicy = await post(
            "/v1/teams/policy/set",
            owner.id,
            { v: 1, teamId, externalSharingPolicy: "disabled" },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedPolicy.statusCode).toBe(200);

        const image = {
            mimeType: "image/jpeg" as const,
            dataBase64: (await sharp({
                create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
            }).jpeg().toBuffer()).toString("base64"),
        };
        const deniedLogo = await post("/v1/teams/logo/set", owner.id, { v: 1, teamId, image });
        expect(deniedLogo.statusCode).toBe(403);
        expect(deniedLogo.json()).toEqual({ error: "team_authentication_required" });
        const allowedLogo = await post(
            "/v1/teams/logo/set",
            owner.id,
            { v: 1, teamId, image },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedLogo.statusCode).toBe(200);

        const deniedLogoRemoval = await post("/v1/teams/logo/remove", owner.id, { v: 1, teamId });
        expect(deniedLogoRemoval.statusCode).toBe(403);
        const allowedLogoRemoval = await post(
            "/v1/teams/logo/remove",
            owner.id,
            { v: 1, teamId },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedLogoRemoval.statusCode).toBe(200);

        const deniedArchive = await post("/v1/teams/archive", owner.id, { v: 1, teamId });
        expect(deniedArchive.statusCode).toBe(403);
        const allowedArchive = await post(
            "/v1/teams/archive",
            owner.id,
            { v: 1, teamId },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedArchive.statusCode).toBe(200);

        const deniedRestore = await post("/v1/teams/restore", owner.id, { v: 1, teamId });
        expect(deniedRestore.statusCode).toBe(403);
        const allowedRestore = await post(
            "/v1/teams/restore",
            owner.id,
            { v: 1, teamId },
            { teamAuthentication: "key_challenge" },
        );
        expect(allowedRestore.statusCode).toBe(200);
    });

    it("keeps mutation projections credential-qualified without blocking independent Home administration", async () => {
        const owner = await account("e2ee");
        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Combined authority", requestKey: crypto.randomUUID(),
        });
        const teamId = created.json().id as string;
        await db.account.update({ where: { id: owner.id }, data: { homeRole: "admin" } });
        await db.team.update({ where: { id: teamId }, data: { authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
        } } });
        const image = {
            mimeType: "image/jpeg" as const,
            dataBase64: (await sharp({
                create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
            }).jpeg().toBuffer()).toString("base64"),
        };
        for (const [path, fields] of [
            ["update", { name: "Home-admin edit" }],
            ["logo/set", { image }],
            ["logo/remove", {}],
            ["archive", {}],
            ["restore", {}],
        ] as const) {
            const mutation = await post(`/v1/teams/${path}`, owner.id, { v: 1, teamId, ...fields });
            expect(mutation.statusCode, mutation.body).toBe(200);
            const readback = await post("/v1/teams/get", owner.id, { v: 1, teamId });
            expect(readback.statusCode).toBe(200);
            expect(mutation.json().capabilities, path).toEqual(readback.json().capabilities);
            expect(mutation.json().capabilities.managePolicy, path).toBe(false);
            expect(mutation.json().capabilities.manageAuthentication, path).toBe(false);
            expect(mutation.json().capabilities.manageMembers, path).toBe(false);
        }
        const readback = await post("/v1/teams/get", owner.id, { v: 1, teamId });
        const administered = await post("/v1/teams/list", owner.id, {
            v: 1, scope: "administered", archived: "active",
        });
        expect(administered.statusCode).toBe(200);
        expect(administered.json().items.find((item: { id: string }) => item.id === teamId)?.capabilities)
            .toEqual(readback.json().capabilities);
        const qualified = await post("/v1/teams/update", owner.id, {
            v: 1, teamId, name: "Qualified edit",
        }, { teamAuthentication: "key_challenge" });
        expect(qualified.statusCode).toBe(200);
        expect(qualified.json().capabilities.managePolicy).toBe(true);
        expect(qualified.json().capabilities.manageAuthentication).toBe(true);
        expect(qualified.json().capabilities.manageMembers).toBe(true);
        const qualifiedPage = await post("/v1/teams/list", owner.id, {
            v: 1, scope: "administered", archived: "active",
        }, { teamAuthentication: "key_challenge" });
        expect(qualifiedPage.json().items.find((item: { id: string }) => item.id === teamId)?.capabilities)
            .toEqual(qualified.json().capabilities);
    });

    it("exposes malformed policy only to structural Team administrators for canonical repair", async () => {
        const owner = await account();
        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Malformed policy repair", requestKey: crypto.randomUUID(),
        });
        const teamId = created.json().id as string;
        const admin = await account();
        const ordinary = await account();
        const outsider = await account();
        await db.teamMembership.createMany({ data: [
            { teamId, accountId: admin.id, role: "admin" },
            { teamId, accountId: ordinary.id, role: "member" },
        ] });
        await db.team.update({
            where: { id: teamId },
            data: { authenticationPolicy: { v: 99, mode: "restricted", providerSecret: "must-not-leak" } },
        });

        for (const actorAccountId of [owner.id, admin.id]) {
            const listed = await post("/v1/teams/list", actorAccountId, {
                v: 1, scope: "member", archived: "active",
            });
            expect(listed.statusCode).toBe(200);
            const listRow = listed.json().items.find((item: { id: string }) => item.id === teamId);
            expect(listRow.policy).toMatchObject({
                authenticationPolicy: null,
                authenticationPolicyStatus: "repair_required",
            });
            expect(JSON.stringify(listRow)).not.toContain("must-not-leak");

            const detail = await post("/v1/teams/get", actorAccountId, { v: 1, teamId });
            expect(detail.statusCode).toBe(200);
            expect(detail.json().policy).toMatchObject({
                authenticationPolicy: null,
                authenticationPolicyStatus: "repair_required",
            });
            expect(JSON.stringify(detail.json())).not.toContain("must-not-leak");
        }

        const deniedMember = await post("/v1/teams/get", ordinary.id, { v: 1, teamId });
        expect({ status: deniedMember.statusCode, body: deniedMember.json() }).toEqual({
            status: 503,
            body: { error: "team_authentication_unavailable" },
        });
        const deniedOutsider = await post("/v1/teams/get", outsider.id, { v: 1, teamId });
        expect(deniedOutsider.statusCode).toBe(404);

        const deniedMutation = await post("/v1/teams/update", owner.id, { v: 1, teamId, name: "Denied" });
        expect({ status: deniedMutation.statusCode, body: deniedMutation.json() }).toEqual({
            status: 503,
            body: { error: "team_authentication_unavailable" },
        });
        const repaired = await post("/v1/teams/policy/set", owner.id, {
            v: 1,
            teamId,
            previousAuthenticationPolicy: { v: 1, status: "repair_required" },
            authenticationPolicy: { v: 1, mode: "inherit" },
        });
        expect(repaired.statusCode).toBe(200);
        expect(repaired.json().policy).toMatchObject({
            authenticationPolicy: null,
            authenticationPolicyStatus: "available",
        });
    });

    it("maps each typed domain result to its status and never reveals a hidden Team", async () => {
        const owner = await account();
        const stranger = await account();
        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Private", requestKey: crypto.randomUUID(),
        });
        const teamId = created.json().id;

        const hidden = await post("/v1/teams/get", stranger.id, { v: 1, teamId });
        const missing = await post("/v1/teams/get", stranger.id, { v: 1, teamId: "no-such-team" });
        expect(hidden.statusCode).toBe(404);
        expect(hidden.json()).toEqual({ error: "team_not_found" });
        expect(missing.json()).toEqual(hidden.json());

        const badInput = await post("/v1/teams/create", owner.id, {
            v: 1, name: "   ", requestKey: crypto.randomUUID(),
        });
        expect(badInput.statusCode).toBe(400);
        expect(badInput.json()).toEqual({ error: "invalid_team_input", details: { field: "name", reason: "empty" } });

        const badCursor = await post("/v1/teams/list", owner.id, {
            v: 1, scope: "member", archived: "active", cursor: "not-a-cursor",
        });
        expect(badCursor.statusCode).toBe(400);
        expect(badCursor.json()).toEqual({ error: "invalid_team_cursor" });

        const forbiddenScope = await post("/v1/teams/list", stranger.id, {
            v: 1, scope: "administered", archived: "active",
        });
        expect(forbiddenScope.statusCode).toBe(403);
        expect(forbiddenScope.json()).toEqual({ error: "team_forbidden" });
    });

    it("rejects an unknown field and an over-limit logo payload at the transport", async () => {
        const owner = await account();
        const created = await post("/v1/teams/create", owner.id, {
            v: 1, name: "Bounded", requestKey: crypto.randomUUID(),
        });
        const teamId = created.json().id;

        // A strict schema violation is answered in the one shared Team error
        // envelope, on the 400 the route publishes. Letting the framework's own
        // validation body through would give a plain client mistake a second wire
        // shape — and serializing it against the declared schema would surface a
        // 500 instead.
        const unknownField = await post("/v1/teams/update", owner.id, {
            v: 1, teamId, name: "Fine", slug: "fine",
        });
        expect(unknownField.statusCode).toBe(400);
        expect(unknownField.json()).toEqual({ error: "invalid_team_input" });
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).name).toBe("Bounded");

        // The same envelope on a different route and a different violation, so
        // one malformed-input contract covers the whole family.
        const badEnum = await post("/v1/teams/list", owner.id, {
            v: 1, scope: "everyone", archived: "active",
        });
        expect(badEnum.statusCode).toBe(400);
        expect(badEnum.json()).toEqual({ error: "invalid_team_input" });

        const missingField = await post("/v1/teams/get", owner.id, { v: 1 });
        expect(missingField.statusCode).toBe(400);
        expect(missingField.json()).toEqual({ error: "invalid_team_input" });

        const oversized = await post("/v1/teams/logo/set", owner.id, {
            v: 1,
            teamId,
            image: { mimeType: "image/png", dataBase64: "A".repeat(12 * 1024 * 1024) },
        });
        // Either the narrowed body limit or the strict payload bound refuses it;
        // both are the same product answer: too large, and nothing was published.
        expect([400, 413]).toContain(oversized.statusCode);
        expect((await db.team.findUniqueOrThrow({ where: { id: teamId } })).logo).toBeNull();
    });

    it("returns the Team error envelope when the canonical feature decision disables the route family", async () => {
        const actor = await account();
        const disabledApp = createAuthenticatedTestApp();
        registerTeamRoutes(disabledApp, { ...process.env, HAPPIER_BUILD_FEATURES_DENY: "teams" });
        await disabledApp.ready();
        try {
            const response = await disabledApp.inject({
                method: "POST",
                url: "/v1/teams/list",
                headers: { "x-test-user-id": actor.id },
                payload: { v: 1, scope: "member", archived: "active" },
            });
            expect({ status: response.statusCode, body: response.json() }).toEqual({
                status: 404,
                body: { error: "teams_unavailable" },
            });
        } finally {
            await disabledApp.close();
        }
    });
});
