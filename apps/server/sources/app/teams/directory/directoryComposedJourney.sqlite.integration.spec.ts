import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { TEAM_CHANGE_ENTITY_ID } from "../teamChanges";
import { getDirectorySourceForActor } from "./directorySourceAdministration";
import { runEnterpriseIdentitySyncWorkerPass } from "./runtime/worker";

const upstream = vi.hoisted(() => ({
    listUsers: vi.fn(),
    listGroups: vi.fn(),
    listEvents: vi.fn(),
}));

// WorkOS is the external SDK boundary. Worker selection, currentness, page
// staging, reconciliation, Lane 01 mutations, and publication remain real.
vi.mock("@workos-inc/node", () => ({
    WorkOS: class {
        directorySync = { listUsers: upstream.listUsers, listGroups: upstream.listGroups };
        events = { listEvents: upstream.listEvents };
    },
}));

describe("directory worker composed SQLite journey", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-directory-composed-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                WORKOS_API_KEY: "sk_test_composed_directory",
                WORKOS_CLIENT_ID: "client_composed_directory",
            },
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
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it("withholds native facts on a partial page, then activates and publishes a complete retry", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: "Composed directory" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
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
                    v: 1, kind: "workos_sso", organizationId: "org_composed", connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "initializing",
                displayName: "Composed WorkOS directory",
                externalSourceKey: `workos-composed:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_composed" },
                teamIdentityConnectionId: connection.id,
                manualSyncRequestedAt: new Date("2026-09-05T10:00:00.000Z"),
            },
        });
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: team.id,
                externalUserId: "user_composed",
                state: "active",
                boundAccountId: member.id,
            },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering")},
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: group.id,
                directorySourceId: source.id,
                externalGroupId: "group_composed",
                bindingMode: "native_target",
            },
        });

        const user = {
            id: "user_composed",
            directoryId: "directory_composed",
            organizationId: "org_composed",
            idpId: "subject_composed",
            firstName: "Managed",
            lastName: "Member",
            email: "managed@example.test",
            state: "active",
            updatedAt: "2026-09-05T10:00:00.000Z",
        };
        const page = (data: readonly unknown[], after: string | null = null) => ({
            data, listMetadata: { after },
        });
        upstream.listUsers.mockImplementation(async ({ after, group }: { after: string | null; group?: string }) => {
            if (group) return page([user]);
            if (after) throw Object.assign(new Error("provider unavailable"), { status: 503 });
            return page([user], "page_2");
        });
        upstream.listGroups.mockResolvedValue(page([{
            id: "group_composed", directoryId: "directory_composed",
            organizationId: "org_composed", name: "Engineering",
            updatedAt: "2026-09-05T10:00:00.000Z",
        }]));
        upstream.listEvents.mockResolvedValue(page([]));

        expect(await runEnterpriseIdentitySyncWorkerPass()).toEqual({ status: "failed", sourceId: source.id });
        expect(upstream.listUsers).toHaveBeenCalledWith({
            directory: "directory_composed", after: "page_2", limit: 100,
        });
        expect(await db.teamProvisionedIdentity.findFirstOrThrow({
            where: { directorySourceId: source.id, externalUserId: user.id },
        })).toMatchObject({ boundAccountId: member.id, displayName: "Managed Member" });
        expect(await db.teamMembership.findFirst({ where: { teamId: team.id, accountId: member.id } })).toBeNull();
        expect(await db.teamGroupMembershipExternalContribution.count({
            where: { externalGroupBindingId: binding.id },
        })).toBe(0);
        expect(await getDirectorySourceForActor({
            teamId: team.id, sourceId: source.id, actorAccountId: owner.id,
        })).toMatchObject({
            ok: true,
            value: {
                state: "needs_attention",
                sync: { attempt: "failed", freshness: "never_synced", lastSuccessAt: null },
                error: { code: "directory_sync_unavailable", retryable: true },
            },
        });

        // The retry is a fresh complete observation, including the page that
        // failed above. Its staged first-page row alone was not authorization.
        upstream.listUsers.mockImplementation(async ({ after, group }: { after: string | null; group?: string }) =>
            group ? page([user]) : after ? page([]) : page([user], "page_2"));
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: { manualSyncRequestedAt: new Date(), retryNotBefore: null },
        });
        const ownerSeqBefore = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await runEnterpriseIdentitySyncWorkerPass()).toEqual({ status: "completed", sourceId: source.id });
        expect(upstream.listGroups).toHaveBeenCalledWith({
            directory: "directory_composed", after: null, limit: 100,
        });
        expect(upstream.listEvents).toHaveBeenCalledWith(expect.objectContaining({
            organizationId: "org_composed", order: "asc",
        }));

        const nativeMembership = await db.teamMembership.findFirstOrThrow({
            where: { teamId: team.id, accountId: member.id },
        });
        expect(nativeMembership).toMatchObject({ role: "member", status: "active" });
        expect(await db.teamGroupMembershipExternalContribution.count({
            where: { externalGroupBindingId: binding.id },
        })).toBe(1);
        expect(await db.teamGroupMembership.findFirst({
            where: { teamGroupId: group.id, teamMembershipId: nativeMembership.id },
        })).toMatchObject({ nativeContribution: false });
        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
            state: "active", activeReconcileRunId: null, lastErrorCode: null,
            lastSuccessAt: expect.any(Date),
        });
        expect(await getDirectorySourceForActor({
            teamId: team.id, sourceId: source.id, actorAccountId: owner.id,
        })).toMatchObject({ ok: true, value: { state: "active", sync: { attempt: "succeeded" } } });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBeGreaterThan(ownerSeqBefore);
        expect(await db.accountChange.findFirst({
            where: { accountId: owner.id, entityId: TEAM_CHANGE_ENTITY_ID },
        })).not.toBeNull();
    });
});
