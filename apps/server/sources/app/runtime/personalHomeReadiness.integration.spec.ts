import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PERSONAL_HOME_TEAM_NAME } from "@happier-dev/cli-common/firstPartyRuntime/server";

import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { createPersonalHomeAuthenticatedReadiness } from "./personalHomeReadiness";

const PERSONAL_HOME_ENV = {
    HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
    HAPPIER_FEATURE_TEAMS__ENABLED: "1",
    HAPPIER_SERVER_IDENTITY_ID: "srv_personal_home_h6",
    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
} satisfies NodeJS.ProcessEnv;

describe("Personal Home H6 readiness composition", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-personal-home-h6-readiness-",
            initAuth: true,
            env: PERSONAL_HOME_ENV,
        });
    }, 180_000);

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.repeatKey.deleteMany(),
            () => db.team.deleteMany(),
            () => db.homeGovernancePolicy.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it("materializes the Personal Home governance preset and one owner-managed default Team before publishing readiness", async () => {
        const account = await db.account.create({
            data: {
                id: "personal-home-bootstrap-account",
                publicKey: "personal-home-bootstrap-public-key",
                encryptionMode: "plain",
                homeRole: "member",
            },
        });

        await expect(createPersonalHomeAuthenticatedReadiness(PERSONAL_HOME_ENV)).resolves.toMatchObject({
            authenticated: true,
            homeServerIdentityId: "srv_personal_home_h6",
            accountCount: 1,
            teamsBootstrapStatus: "ready",
        });

        const policy = await db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
        });
        expect(policy.teamCreationPolicy).toBe("managed_only");
        expect(policy.authenticationPolicy).toEqual({ v: 1, admission: "invitation_only" });

        const teams = await db.team.findMany({
            include: { memberships: true },
        });
        expect(teams).toHaveLength(1);
        expect(teams[0]?.name).toBe(DEFAULT_PERSONAL_HOME_TEAM_NAME);
        expect(teams[0]?.admissionMode).toBe("invite_only");
        expect(teams[0]?.memberships).toEqual([
            expect.objectContaining({
                accountId: account.id,
                role: "owner",
                status: "active",
            }),
        ]);

        await expect(createPersonalHomeAuthenticatedReadiness(PERSONAL_HOME_ENV)).resolves.toMatchObject({
            authenticated: true,
            accountCount: 1,
            teamsBootstrapStatus: "ready",
        });
        await expect(db.team.count()).resolves.toBe(1);
        await expect(db.teamMembership.count()).resolves.toBe(1);

        // General Team-create retry custody is intentionally short-lived. The
        // Personal Home's default Team is a durable bootstrap fact, so a later
        // process restart must not depend on that transient retry window.
        await db.repeatKey.updateMany({ data: { expiresAt: new Date(0) } });
        await expect(createPersonalHomeAuthenticatedReadiness(PERSONAL_HOME_ENV)).resolves.toMatchObject({
            authenticated: true,
            accountCount: 1,
            teamsBootstrapStatus: "ready",
        });
        await expect(db.team.count()).resolves.toBe(1);
        await expect(db.teamMembership.count()).resolves.toBe(1);
    });

    it("selects the sole active Account even when a lower-id legacy Account is disabled", async () => {
        await db.account.create({
            data: {
                id: "a-disabled-legacy-account",
                publicKey: "personal-home-disabled-public-key",
                encryptionMode: "plain",
                homeRole: "owner",
                status: "disabled",
            },
        });
        const active = await db.account.create({
            data: {
                id: "z-active-personal-home-account",
                publicKey: "personal-home-active-public-key",
                encryptionMode: "plain",
                homeRole: "member",
            },
        });

        await expect(createPersonalHomeAuthenticatedReadiness(PERSONAL_HOME_ENV)).resolves.toMatchObject({
            authenticated: true,
            accountCount: 2,
            teamsBootstrapStatus: "ready",
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: active.id },
            select: { homeRole: true },
        })).resolves.toEqual({ homeRole: "owner" });
        await expect(db.teamMembership.findFirstOrThrow({
            select: { accountId: true, role: true },
        })).resolves.toEqual({ accountId: active.id, role: "owner" });
    });

    it("keeps an ownerless multi-Account Personal Home auth-ready without electing an owner or creating a Team", async () => {
        for (const id of ["personal-home-member-a", "personal-home-member-b"]) {
            await db.account.create({
                data: {
                    id,
                    publicKey: `${id}-public-key`,
                    encryptionMode: "plain",
                    homeRole: "member",
                },
            });
        }

        await expect(createPersonalHomeAuthenticatedReadiness(PERSONAL_HOME_ENV)).resolves.toMatchObject({
            authenticated: true,
            accountCount: 2,
            teamsBootstrapStatus: "setup_required",
        });
        await expect(db.account.count({ where: { homeRole: "owner", status: "active" } })).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });

    it.each([false, true])("publishes authenticated readiness with Teams disabled (previously initialized: %s)", async (initialized) => {
        await db.account.create({
            data: {
                id: "personal-home-bootstrap-account",
                publicKey: "personal-home-bootstrap-public-key",
                encryptionMode: "plain",
                homeRole: "owner",
            },
        });

        if (initialized) {
            await expect(createPersonalHomeAuthenticatedReadiness(PERSONAL_HOME_ENV)).resolves.toMatchObject({
                authenticated: true,
                teamsBootstrapStatus: "ready",
            });
        }

        await expect(createPersonalHomeAuthenticatedReadiness({
            ...PERSONAL_HOME_ENV,
            HAPPIER_BUILD_FEATURES_DENY: "teams",
        })).resolves.toMatchObject({
            authenticated: true,
            teamsBootstrapStatus: "teams_unavailable",
        });
    });

    it("rejects direct readiness attestation outside the Personal Home runtime purpose", async () => {
        await db.account.create({
            data: {
                id: "ordinary-light-home-account",
                publicKey: "ordinary-light-home-public-key",
                encryptionMode: "plain",
                homeRole: "owner",
            },
        });

        await expect(createPersonalHomeAuthenticatedReadiness({
            ...PERSONAL_HOME_ENV,
            HAPPIER_MANAGED_RELAY_PURPOSE: "generic",
        })).rejects.toThrow("requires the personal-home runtime purpose");
        await expect(db.team.count()).resolves.toBe(0);
    });
});
