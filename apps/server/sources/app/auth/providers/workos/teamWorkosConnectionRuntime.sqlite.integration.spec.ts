import type { WorkOS } from "@workos-inc/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    computeTeamWorkosConnectionRuntimeFingerprint,
    resolveTeamWorkosConnectionRuntimeInTx,
} from "./teamWorkosConnectionRuntime";

describe("Team WorkOS connection runtime", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-workos-runtime-",
            initAuth: false,
        });
    }, 120_000);
    afterAll(async () => await harness.close());

    it("resolves Home SSO only in Home scope and never as a Team directory carrier", async () => {
        const provider = await db.identityProviderInstance.create({ data: {
            kind: "workos_sso", displayName: "Company Home", enabled: true,
            firstEnabledAt: new Date(), config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id, enabled: true,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_home", connectionId: "conn_home" },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const dependencies = { resolvePlatform: () => ({ available: true as const, clientId: "client_home",
            client: {} as WorkOS, runtimeFingerprint: "platform_home" }) };
        await expect(inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {}, teamId: null, connectionId: connection.id,
        }, dependencies))).resolves.toMatchObject({ status: "ready", connection: { teamId: null } });
        const team = await db.team.create({ data: { name: "Other Team" } });
        await expect(inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {}, teamId: team.id, connectionId: connection.id, purpose: "directory",
        }, dependencies))).resolves.toEqual({ status: "connection_not_found" });
    });

    it("refuses every runtime of a provider whose legacy Home and Team bindings disagree on the WorkOS namespace", async () => {
        const team = await db.team.create({ data: { name: "Legacy shared WorkOS Team" } });
        const provider = await db.identityProviderInstance.create({ data: {
            kind: "workos_sso", displayName: "Shared company", enabled: true,
            firstEnabledAt: new Date(), config: { v: 1, kind: "workos_sso" },
        } });
        const externalReference = { v: 1, kind: "workos_sso", organizationId: "org_shared", connectionId: "conn_shared" };
        const homeConnection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id, enabled: true,
            externalReference, settings: { v: 1, kind: "workos_sso" },
        } });
        const teamConnection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id, enabled: true,
            externalReference, settings: { v: 1, kind: "workos_sso" },
        } });
        const dependencies = { resolvePlatform: () => ({ available: true as const, clientId: "client_shared",
            client: {} as WorkOS, runtimeFingerprint: "platform_shared" }) };
        await expect(inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {}, teamId: null, connectionId: homeConnection.id,
        }, dependencies))).resolves.toMatchObject({ status: "ready" });
        // Direct database insertion models legacy persisted data, not a current writer bypass.
        await db.teamIdentityConnection.update({ where: { id: teamConnection.id }, data: {
            externalReference: { ...externalReference, connectionId: "conn_other" },
        } });
        for (const connection of [homeConnection, teamConnection]) {
            await expect(inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
                env: {}, teamId: connection.teamId, connectionId: connection.id, includeDisabled: true,
            }, dependencies))).resolves.toEqual({ status: "unreadable" });
        }
    });

    it("resolves a Home-owned provider only through the exact enabled Team binding", async () => {
        const team = await db.team.create({ data: { name: "WorkOS Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: null,
                kind: "workos_sso",
                displayName: "Company SSO",
                enabled: true,
                firstEnabledAt: new Date(),
                securityRevision: 4,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_exact",
                    connectionId: "conn_exact",
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: true,
                firstEnabledAt: new Date(),
                revision: 7,
            },
        });
        const client = {} as WorkOS;
        const result = await inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {},
            teamId: team.id,
            connectionId: connection.id,
        }, {
            resolvePlatform: () => ({
                available: true,
                clientId: "client_exact",
                client,
                runtimeFingerprint: "workos-platform:v1:exact",
            }),
        }));
        expect(result).toMatchObject({
            status: "ready",
            provider: { id: provider.id, owner: { kind: "home" }, securityRevision: 4 },
            connection: {
                id: connection.id,
                teamId: team.id,
                revision: 7,
                externalReference: {
                    organizationId: "org_exact",
                    connectionId: "conn_exact",
                },
            },
            platform: { clientId: "client_exact", client },
        });
        expect(result.status === "ready" && result.runtimeFingerprint).toContain(":4:7:");
        expect(result.status === "ready" && result.runtimeFingerprint).toBe(
            computeTeamWorkosConnectionRuntimeFingerprint({
                teamId: team.id,
                connectionId: connection.id,
                providerInstanceId: provider.id,
                providerSecurityRevision: 4,
                connectionRevision: 7,
                platformRuntimeFingerprint: "workos-platform:v1:exact",
                externalReference: { organizationId: "org_exact", connectionId: "conn_exact" },
            }),
        );

        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: { enabled: false, revision: 8 },
        });
        await expect(inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {}, teamId: team.id, connectionId: connection.id,
        }, {
            resolvePlatform: () => ({
                available: true,
                clientId: "client_exact",
                client,
                runtimeFingerprint: "workos-platform:v1:exact",
            }),
        }))).resolves.toEqual({ status: "connection_disabled" });
    });

    it("resolves a Directory carrier from an exact organization without an SSO connection", async () => {
        const team = await db.team.create({ data: { name: "Directory-only WorkOS Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Directory WorkOS",
                enabled: true,
                firstEnabledAt: new Date(),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_directory_only",
                    connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: false,
            },
        });
        const client = {} as WorkOS;
        const dependencies = {
            resolvePlatform: () => ({
                available: true as const,
                clientId: "client_exact",
                client,
                runtimeFingerprint: "workos-platform:v1:directory",
            }),
        };

        await expect(inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {},
            teamId: team.id,
            connectionId: connection.id,
        }, dependencies))).resolves.toEqual({ status: "connection_disabled" });
        const directory = await inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: {},
            teamId: team.id,
            connectionId: connection.id,
            purpose: "directory",
        }, dependencies));
        expect(directory).toMatchObject({
            status: "ready",
            purpose: "directory",
            connection: {
                id: connection.id,
                externalReference: {
                    organizationId: "org_directory_only",
                    connectionId: null,
                },
            },
            platform: { client },
        });
    });
});
