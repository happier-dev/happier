import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { findNextDirectorySourceDueForSync, hasDirectorySourceDueForSync } from "../directorySourceService";
import { WORKOS_DIRECTORY_SYNC_TARGET_MS } from "../directorySourceProjection";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("directory due-work probe (PostgreSQL)", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID
            || !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "1");
        initDbPostgres();
        await db.$connect();
        connected = true;
        await db.homeGovernancePolicy.create({ data: { id: "home", teamProviderPolicy: {
            v: 1, allowedTeamProviderKinds: ["workos_sso"], teamJitAllowed: false,
            approvedGitHubEnterpriseOrigins: [],
        } } });
    });
    afterAll(async () => { if (connected) await db.$disconnect(); vi.unstubAllEnvs(); });

    it("shares the selector's due boundaries without admitting or changing a source", async () => {
        const now = new Date("2026-11-02T12:00:00Z");
        expect(await hasDirectorySourceDueForSync({ now })).toBe(false);
        const team = await db.team.create({ data: { name: "Directory due-work contract" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS", enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1 }, settings: { v: 1 },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "workos_directory", state: "active", displayName: "WorkOS",
            teamIdentityConnectionId: connection.id,
            externalSourceKey: `probe:${team.id}`, bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "probe" },
            lastSuccessAt: now, lastFullReconcileAt: now, eventCursor: "event_current",
        } });
        expect(await hasDirectorySourceDueForSync({ now })).toBe(false);
        await db.teamDirectorySource.update({ where: { id: source.id }, data: {
            lastSuccessAt: new Date(now.getTime() - WORKOS_DIRECTORY_SYNC_TARGET_MS),
        } });
        expect(await hasDirectorySourceDueForSync({ now })).toBe(true);
        expect(await findNextDirectorySourceDueForSync({ now })).toEqual({ id: source.id, mode: "incremental" });
        await db.teamDirectorySource.update({ where: { id: source.id }, data: { manualSyncRequestedAt: now } });
        expect(await hasDirectorySourceDueForSync({ now })).toBe(true);
        expect(await findNextDirectorySourceDueForSync({ now })).toEqual({ id: source.id, mode: "full" });
        await db.teamDirectorySource.update({ where: { id: source.id }, data: { state: "paused" } });
        expect(await hasDirectorySourceDueForSync({ now })).toBe(false);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ activeReconcileRunId: null, manualSyncRequestedAt: now });
    });
});
