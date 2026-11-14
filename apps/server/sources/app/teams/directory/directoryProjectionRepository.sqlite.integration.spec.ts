import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    commitDirectoryProjectionPage,
    commitActiveWorkosProjectionEvent,
    commitInitializingWorkosProjectionEvent,
    completeDirectoryProjection,
    finalizeDirectoryProjection,
    stageActiveWorkosGroupMemberEventPage,
    stageInitializingWorkosGroupMemberEventPage,
} from "./directoryProjectionRepository";
import {
    claimDirectorySourceFullReconcile,
    markActiveWorkosDirectoryPollFailed,
    removeDirectorySourceForObservedDeletion,
} from "./directorySourceService";
import { inTx } from "@/storage/inTx";
import { bindDirectoryProvisionedIdentitiesInTx } from "./provisionedIdentityBinding";
import { setIdentityProviderInstanceEnabledInTx } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { resolveTeamWorkosConnectionRuntimeInTx } from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";

describe("directoryProjectionRepository", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-directory-projection-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
                WORKOS_API_KEY: "sk_test_directory_currentness",
                WORKOS_CLIENT_ID: "client_directory_currentness",
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

    it.each(["full", "incremental", "snapshot_deletion", "event_deletion", "runtime_revision"] as const)("rejects stale WorkOS %s after read authority changes", async (mode) => {
        const team = await db.team.create({ data: { name: `WorkOS stale ${mode}` } });
        const account = await db.account.create({ data: { publicKey: `workos-stale-${mode}-${team.id}` } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS",
            enabled: true, firstEnabledAt: new Date(), config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id, enabled: false,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_original", connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "workos_directory", displayName: "Original directory",
            externalSourceKey: `workos-currentness:${team.id}`,
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_original" },
            teamIdentityConnectionId: connection.id, eventCursor: "event_before",
            state: mode === "full" || mode === "snapshot_deletion" || mode === "runtime_revision" ? "initializing" : "active",
            activeReconcileRunId: mode === "full" || mode === "snapshot_deletion" || mode === "runtime_revision" ? "workos-run" : null,
            activeReconcileStartedAt: mode === "full" || mode === "snapshot_deletion" || mode === "runtime_revision"
                ? new Date("2026-09-29T10:00:00Z") : null,
        } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: account.id, role: "member", status: "active",
        } });
        await db.teamProvisionedIdentity.create({ data: {
            directorySourceId: source.id, teamId: team.id, externalUserId: "person",
            state: "active", boundAccountId: account.id,
            teamMembershipId: membership.id, teamMembershipTeamId: team.id,
        } });
        const runtime = await inTx((tx) => resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: process.env, teamId: team.id, connectionId: connection.id, purpose: "directory",
        }));
        expect(runtime.status).toBe("ready");
        if (runtime.status !== "ready") throw new Error("Expected WorkOS directory runtime");
        const expectedCurrentness = {
            kind: "workos_directory_read" as const,
            directorySourceId: source.id,
            teamIdentityConnectionId: connection.id,
            workosDirectoryId: "directory_original",
            organizationId: runtime.connection.externalReference.organizationId,
            runtimeFingerprint: runtime.runtimeFingerprint,
        };
        if (mode === "full" || mode === "runtime_revision") {
            expect(await commitDirectoryProjectionPage({
                sourceId: source.id, reconcileRunId: "workos-run",
                people: [{ externalUserId: "person", active: false }],
            })).toEqual({ applied: true });
        }
        if (mode === "runtime_revision") {
            await db.identityProviderInstance.update({
                where: { id: provider.id }, data: { securityRevision: { increment: 1 } },
            });
        } else {
            await db.teamIdentityConnection.update({
                where: { id: connection.id },
                data: {
                    revision: { increment: 1 },
                    externalReference: { v: 1, kind: "workos_sso", organizationId: "org_rebound", connectionId: null },
                },
            });
        }
        const outcome = mode === "full" || mode === "runtime_revision"
            ? await completeDirectoryProjection({
                sourceId: source.id, reconcileRunId: "workos-run", observedManualSyncRequestedAt: null,
                expectedCurrentness,
            })
            : mode === "incremental"
                ? await commitActiveWorkosProjectionEvent({
                    sourceId: source.id, expectedPosition: { eventCursor: "event_before" },
                    eventId: "event_after", people: [{ externalUserId: "person", active: false }],
                    expectedCurrentness,
                })
                : await removeDirectorySourceForObservedDeletion({
                    teamId: team.id, sourceId: source.id,
                    expectedState: mode === "snapshot_deletion" ? "initializing" : "active",
                    reconcileRunId: mode === "snapshot_deletion" ? "workos-run" : null,
                    expectedPosition: { eventCursor: "event_before" },
                    expectedCurrentness,
                });
        expect(outcome).toEqual({ applied: false, reason: "stale_run" });
        expect(await db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } })).toMatchObject({ status: "active" });
        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
            state: mode === "full" || mode === "snapshot_deletion" || mode === "runtime_revision" ? "initializing" : "active",
            eventCursor: "event_before", lastSuccessAt: null,
        });
    });

    it.each(["incremental", "full"] as const)("rejects %s native effects after the provider is disabled, without revoking retained access", async (mode) => {
        const team = await db.team.create({ data: { name: `Provider currentness ${mode}` } });
        const account = await db.account.create({ data: { publicKey: `provider-currentness-${team.id}` } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: mode === "full" ? null : team.id,
            kind: "workos_sso", displayName: "WorkOS", config: { v: 1, kind: "workos_sso" },
        } });
        const owner = mode === "full" ? { kind: "home" as const } : { kind: "team" as const, teamId: team.id };
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            // Disabling Team SSO is independent of directory provisioning.
            enabled: false, externalReference: { v: 1 }, settings: { v: 1 },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "workos_directory", displayName: "Current provider directory",
            externalSourceKey: `provider-currentness:${team.id}`,
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory" },
            teamIdentityConnectionId: connection.id, eventCursor: "before-disable",
            state: mode === "full" ? "initializing" : "active",
            activeReconcileRunId: mode === "full" ? "in-flight-run" : null,
            activeReconcileStartedAt: mode === "full" ? new Date("2026-09-26T10:00:00Z") : null,
        } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: account.id, role: "member", status: "active",
        } });
        await db.teamProvisionedIdentity.create({ data: {
            directorySourceId: source.id, teamId: team.id, externalUserId: "person",
            state: "active", boundAccountId: account.id,
            teamMembershipId: membership.id, teamMembershipTeamId: team.id,
        } });
        if (mode === "full") {
            expect(await commitDirectoryProjectionPage({
                sourceId: source.id, reconcileRunId: "in-flight-run",
                people: [{ externalUserId: "person", active: false }],
            })).toEqual({ applied: true });
        }
        const disable = await inTx((tx) => setIdentityProviderInstanceEnabledInTx(tx, {
            id: provider.id, owner, enabled: false,
            expectedRevision: provider.revision, expectedSecurityRevision: provider.securityRevision,
        }));
        expect(disable.status).toBe("applied");
        if (disable.status !== "applied") throw new Error("Provider disable failed");
        const complete = () => mode === "full"
            ? completeDirectoryProjection({ sourceId: source.id, reconcileRunId: "in-flight-run", observedManualSyncRequestedAt: null })
            : commitActiveWorkosProjectionEvent({
                sourceId: source.id, expectedPosition: { eventCursor: "before-disable" },
                eventId: "after-disable", people: [{ externalUserId: "person", active: false }],
            });
        expect(await complete()).toEqual({ applied: false, reason: "stale_run" });
        expect(await db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } })).toMatchObject({ status: "active" });
        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
            eventCursor: "before-disable", lastSuccessAt: null,
        });
        expect(await inTx((tx) => setIdentityProviderInstanceEnabledInTx(tx, {
            id: provider.id, owner, enabled: true,
            expectedRevision: disable.instance.revision, expectedSecurityRevision: disable.instance.securityRevision,
        }))).toMatchObject({ status: "applied" });
        expect(await complete()).toEqual({ applied: true });
        expect(await db.teamMembership.findUniqueOrThrow({ where: { id: membership.id } })).toMatchObject({ status: "suspended" });
    });

    it("fences stale pages, preserves newer object evidence, and finalizes only projection absence", async () => {
        const team = await db.team.create({ data: { name: "Directory Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
                config: { v: 1, kind: "workos_sso" },
            },
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
                state: "initializing",
                displayName: "Primary directory",
                externalSourceKey: "workos:organization:directory",
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "previous-run",
                activeReconcileStartedAt: new Date("2026-09-05T10:00:00.000Z"),
            },
        });
        const newerAt = new Date("2026-09-05T12:00:00.000Z");
        const olderAt = new Date("2026-09-05T11:00:00.000Z");
        const eventRangeStart = new Date("2026-09-05T10:00:00.000Z");

        expect(await commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "previous-run",
            people: [
                { externalUserId: "current-user", displayName: "Current", active: true, externalUpdatedAt: newerAt },
                { externalUserId: "missing-user", displayName: "Missing", active: true, externalUpdatedAt: newerAt },
                { externalUserId: "stale-delete-user", displayName: "Still current", active: true, externalUpdatedAt: newerAt },
            ],
            groups: [
                { externalGroupId: "current-group", displayName: "Current group", externalUpdatedAt: newerAt },
                { externalGroupId: "missing-group", displayName: "Missing group", externalUpdatedAt: newerAt },
                { externalGroupId: "stale-delete-group", displayName: "Still current group", externalUpdatedAt: newerAt },
            ],
            groupMembers: [
                { externalGroupId: "current-group", externalUserId: "current-user" },
                { externalGroupId: "missing-group", externalUserId: "missing-user" },
                { externalGroupId: "stale-delete-group", externalUserId: "stale-delete-user" },
            ],
        })).toEqual({ applied: true });

        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: { activeReconcileRunId: "current-run", eventRangeStart },
        });

        expect(await commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "previous-run",
            people: [{ externalUserId: "stale-user", active: true }],
        })).toEqual({ applied: false, reason: "stale_run" });

        expect(await commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "current-run",
            people: [{
                externalUserId: "current-user",
                displayName: "Older name",
                active: false,
                externalUpdatedAt: olderAt,
            }],
            groups: [{
                externalGroupId: "current-group",
                displayName: "Older group name",
                externalUpdatedAt: olderAt,
            }],
            groupMembers: [{ externalGroupId: "current-group", externalUserId: "current-user" }],
        })).toEqual({ applied: true });

        expect(await commitInitializingWorkosProjectionEvent({
            sourceId: source.id,
            reconcileRunId: "current-run",
            expectedPosition: { eventCursor: null, eventRangeStart },
            eventId: "event_opaque_1",
            people: [{
                externalUserId: "current-user",
                externalSubjectId: "  Exact-Subject  ",
                displayName: "Newest event name",
                active: false,
                externalUpdatedAt: new Date("2026-09-05T13:00:00.000Z"),
            }],
        })).toEqual({ applied: true });
        expect(await commitInitializingWorkosProjectionEvent({
            sourceId: source.id,
            reconcileRunId: "current-run",
            expectedPosition: { eventCursor: null, eventRangeStart },
            eventId: "event_opaque_stale",
        })).toEqual({ applied: false, reason: "stale_run" });

        expect(await stageInitializingWorkosGroupMemberEventPage({
            sourceId: source.id,
            reconcileRunId: "current-run",
            expectedPosition: { eventCursor: "event_opaque_1" },
            eventId: "event_opaque_2",
            attemptId: "initializing-attempt",
            externalGroupId: "current-group",
            people: [{
                externalUserId: "current-user",
                displayName: "Newest event name",
                active: false,
                externalUpdatedAt: new Date("2026-09-05T13:00:00.000Z"),
            }],
        })).toEqual({ applied: true });

        expect(await commitInitializingWorkosProjectionEvent({
            sourceId: source.id,
            reconcileRunId: "current-run",
            expectedPosition: { eventCursor: "event_opaque_1" },
            eventId: "event_opaque_2",
            attemptId: "initializing-attempt",
            deletedPeople: [{ externalUserId: "missing-user", active: false }],
            deletedGroups: [{ externalGroupId: "missing-group", displayName: "Missing group" }],
            replaceGroupMembers: [{ externalGroupId: "current-group" }],
        })).toEqual({ applied: true });

        expect(await commitInitializingWorkosProjectionEvent({
            sourceId: source.id,
            reconcileRunId: "current-run",
            expectedPosition: { eventCursor: "event_opaque_2" },
            eventId: "event_opaque_3",
            deletedPeople: [{
                externalUserId: "stale-delete-user",
                displayName: "Stale deletion",
                active: false,
                externalUpdatedAt: olderAt,
            }],
            deletedGroups: [{
                externalGroupId: "stale-delete-group",
                displayName: "Stale deletion",
                externalUpdatedAt: olderAt,
            }],
        })).toEqual({ applied: true });

        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
            eventCursor: "event_opaque_3",
            eventRangeStart: null,
        });

        const currentPerson = await db.teamProvisionedIdentity.findUniqueOrThrow({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: source.id,
                    externalUserId: "current-user",
                },
            },
        });
        expect(currentPerson).toMatchObject({
            externalSubjectId: "  Exact-Subject  ",
            displayName: "Newest event name",
            state: "suspended",
            externalUpdatedAt: new Date("2026-09-05T13:00:00.000Z"),
            lastSeenReconcileRunId: "current-run",
        });
        expect(await db.teamDirectoryGroup.findUniqueOrThrow({
            where: {
                directorySourceId_externalGroupId: {
                    directorySourceId: source.id,
                    externalGroupId: "current-group",
                },
            },
        })).toMatchObject({
            externalDisplayName: "Current group",
            externalUpdatedAt: newerAt,
            lastSeenReconcileRunId: "current-run",
        });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: source.id,
                    externalUserId: "missing-user",
                },
            },
        })).resolves.toMatchObject({ state: "deleted" });
        await expect(db.teamDirectoryGroup.findUniqueOrThrow({
            where: {
                directorySourceId_externalGroupId: {
                    directorySourceId: source.id,
                    externalGroupId: "missing-group",
                },
            },
        })).resolves.toMatchObject({ state: "deleted" });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: source.id,
                    externalUserId: "stale-delete-user",
                },
            },
        })).resolves.toMatchObject({
            state: "active",
            displayName: "Still current",
            externalUpdatedAt: newerAt,
        });
        await expect(db.teamDirectoryGroup.findUniqueOrThrow({
            where: {
                directorySourceId_externalGroupId: {
                    directorySourceId: source.id,
                    externalGroupId: "stale-delete-group",
                },
            },
        })).resolves.toMatchObject({
            state: "active",
            externalDisplayName: "Still current group",
            externalUpdatedAt: newerAt,
        });
        await expect(db.teamDirectoryGroupMember.findUniqueOrThrow({
            where: {
                directorySourceId_externalGroupId_externalUserId: {
                    directorySourceId: source.id,
                    externalGroupId: "stale-delete-group",
                    externalUserId: "stale-delete-user",
                },
            },
        })).resolves.toMatchObject({ lastSeenReconcileRunId: "previous-run" });
        await expect(db.teamDirectoryGroupMember.findMany({
            where: { directorySourceId: source.id, externalGroupId: "current-group" },
        })).resolves.toEqual([{
            directorySourceId: source.id,
            externalGroupId: "current-group",
            externalUserId: "current-user",
            lastSeenReconcileRunId: "current-run",
        }]);

        expect(await finalizeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "current-run",
        })).toEqual({ applied: true });

        expect(await db.teamProvisionedIdentity.findUniqueOrThrow({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: source.id,
                    externalUserId: "missing-user",
                },
            },
        })).toMatchObject({ state: "deleted", lastSeenReconcileRunId: "current-run" });
        expect(await db.teamDirectoryGroup.findUniqueOrThrow({
            where: {
                directorySourceId_externalGroupId: {
                    directorySourceId: source.id,
                    externalGroupId: "missing-group",
                },
            },
        })).toMatchObject({ state: "deleted", lastSeenReconcileRunId: "current-run" });
        expect(await db.teamDirectoryGroupMember.findMany({
            where: { directorySourceId: source.id },
            orderBy: [{ externalGroupId: "asc" }, { externalUserId: "asc" }],
        })).toEqual([{
            directorySourceId: source.id,
            externalGroupId: "current-group",
            externalUserId: "current-user",
            lastSeenReconcileRunId: "current-run",
        }]);

        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
            state: "initializing",
            activeReconcileRunId: "current-run",
            lastSuccessAt: null,
            lastFullReconcileAt: null,
        });

        await db.teamDirectorySource.delete({ where: { id: source.id } });
        expect(await commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "current-run",
            people: [{ externalUserId: "after-delete", active: true }],
        })).toEqual({ applied: false, reason: "stale_run" });
        expect(await db.teamProvisionedIdentity.count({ where: { directorySourceId: source.id } })).toBe(0);
    });

    it("admits a new directory Group relationship without enrolling Follow or replacing retained membership custody", async () => {
        const team = await db.team.create({
            data: { name: "Mixed membership lifecycle", defaultSessionHistoryAccess: "all_existing" },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS mixed lifecycle",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
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
                state: "initializing",
                displayName: "Mixed lifecycle directory",
                externalSourceKey: `workos-mixed-lifecycle:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "mixed-lifecycle" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "mixed-lifecycle-run",
                activeReconcileStartedAt: new Date("2026-09-12T10:00:00.000Z"),
            },
        });
        const sessionOwner = await db.account.create({
            data: { publicKey: `mixed-session-owner-${team.id}`, encryptionMode: "plain" },
        });
        const newlyAdmitted = await db.account.create({
            data: {
                publicKey: `mixed-new-${team.id}`,
                encryptionMode: "plain",
                sessionAutoFollowGroup: true,
            },
        });
        const retained = await db.account.create({
            data: {
                publicKey: `mixed-retained-${team.id}`,
                encryptionMode: "plain",
                sessionAutoFollowGroup: true,
            },
        });
        const retainedMembership = await db.teamMembership.create({
            data: {
                teamId: team.id,
                accountId: retained.id,
                role: "member",
                status: "suspended",
                sessionAccessStartsAt: null,
            },
        });
        await db.teamProvisionedIdentity.createMany({
            data: [
                {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "newly-admitted",
                    state: "active",
                    boundAccountId: newlyAdmitted.id,
                    lastSeenReconcileRunId: "mixed-lifecycle-run",
                },
                {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "retained-reactivation",
                    state: "active",
                    boundAccountId: retained.id,
                    teamMembershipId: retainedMembership.id,
                    teamMembershipTeamId: team.id,
                    lastSeenReconcileRunId: "mixed-lifecycle-run",
                },
            ],
        });
        const directoryGroup = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "mixed-group",
                externalDisplayName: "Mixed Group",
                state: "active",
                lastSeenReconcileRunId: "mixed-lifecycle-run",
            },
        });
        await db.teamDirectoryGroupMember.createMany({
            data: ["newly-admitted", "retained-reactivation"].map((externalUserId) => ({
                directorySourceId: source.id,
                externalGroupId: directoryGroup.externalGroupId,
                externalUserId,
                lastSeenReconcileRunId: "mixed-lifecycle-run",
            })),
        });
        const nativeGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Mixed Group")},
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: source.id,
                externalGroupId: directoryGroup.externalGroupId,
                bindingMode: "directory_created",
            },
        });
        await db.teamGroupMembership.create({
            data: {
                teamId: team.id,
                teamGroupId: nativeGroup.id,
                teamMembershipId: retainedMembership.id,
                nativeContribution: false,
                sessionAccessStartsAt: null,
                externalContributions: {
                    create: { externalGroupBindingId: binding.id },
                },
            },
        });
        const session = await db.session.create({
            data: {
                accountId: sessionOwner.id,
                tag: crypto.randomUUID(),
                metadata: "{}",
                encryptionMode: "plain",
                currentStorageState: "hosted",
                groupGrants: {
                    create: { teamGroupId: nativeGroup.id, accessLevel: "edit", effectiveAt: new Date("2026-09-12T09:00:00.000Z") },
                },
            },
        });

        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "mixed-lifecycle-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-12T10:05:00.000Z"),
        })).resolves.toEqual({ applied: true });

        await expect(db.accountSessionFollow.findUnique({
            where: { accountId_sessionId: { accountId: newlyAdmitted.id, sessionId: session.id } },
        })).resolves.toBeNull();
        await expect(db.accountSessionFollow.findUnique({
            where: { accountId_sessionId: { accountId: retained.id, sessionId: session.id } },
        })).resolves.toBeNull();
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: retainedMembership.id },
        })).resolves.toMatchObject({
            id: retainedMembership.id,
            status: "active",
            sessionAccessStartsAt: retainedMembership.sessionAccessStartsAt,
        });
    });

    it("suppresses new directory membership while a Team is archived without rolling back retained offboarding", async () => {
        const team = await db.team.create({
            data: {
                name: "Archived Team directory suppression",
                archivedAt: new Date("2026-09-12T09:00:00.000Z"),
                defaultSessionHistoryAccess: "from_membership",
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "Archived Team WorkOS", enabled: true, config: { v: 1, kind: "workos_sso" } },
        });
        const connection = await db.teamIdentityConnection.create({
            data: { teamId: team.id, providerInstanceId: provider.id, externalReference: { v: 1 }, settings: { v: 1 } },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "initializing",
                displayName: "Archived Team directory",
                externalSourceKey: `workos-archived-team:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "archived-team" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "archived-team-run",
                activeReconcileStartedAt: new Date("2026-09-12T10:00:00.000Z"),
            },
        });
        const removedAccount = await db.account.create({ data: { publicKey: `archived-team-removed-${team.id}` } });
        const removedMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: removedAccount.id, role: "member" },
        });
        const newAccount = await db.account.create({ data: { publicKey: `archived-team-new-${team.id}` } });
        await db.teamProvisionedIdentity.createMany({
            data: [
                {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "removed-person",
                    state: "active",
                    boundAccountId: removedAccount.id,
                    teamMembershipId: removedMembership.id,
                    teamMembershipTeamId: team.id,
                    lastSeenReconcileRunId: "previous-run",
                },
                {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "new-person",
                    state: "active",
                    boundAccountId: newAccount.id,
                    lastSeenReconcileRunId: "archived-team-run",
                },
            ],
        });

        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "archived-team-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-12T10:05:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamMembership.findUnique({ where: { id: removedMembership.id } })).resolves.toBeNull();
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: newAccount.id } },
        })).resolves.toBeNull();

        await db.team.update({
            where: { id: team.id },
            data: { archivedAt: null, defaultSessionHistoryAccess: "all_existing" },
        });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: newAccount.id } },
        })).resolves.toBeNull();
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: {
                state: "initializing",
                activeReconcileRunId: "restored-team-run",
                activeReconcileStartedAt: new Date("2026-09-12T11:00:00.000Z"),
            },
        });
        await expect(commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "restored-team-run",
            people: [{ externalUserId: "new-person", active: true }],
        })).resolves.toEqual({ applied: true });
        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "restored-team-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-12T11:05:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: newAccount.id } },
        })).resolves.toMatchObject({ status: "active", sessionAccessStartsAt: null });
    });

    it("suppresses a new directory contribution while its mapped Group is archived without rolling back retained offboarding", async () => {
        const team = await db.team.create({ data: { name: "Archived Group directory suppression" } });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "Archived Group WorkOS", enabled: true, config: { v: 1, kind: "workos_sso" } },
        });
        const connection = await db.teamIdentityConnection.create({
            data: { teamId: team.id, providerInstanceId: provider.id, externalReference: { v: 1 }, settings: { v: 1 } },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "initializing",
                displayName: "Archived Group directory",
                externalSourceKey: `workos-archived-group:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "archived-group" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "archived-group-run",
                activeReconcileStartedAt: new Date("2026-09-12T10:00:00.000Z"),
            },
        });
        const removedAccount = await db.account.create({ data: { publicKey: `archived-group-removed-${team.id}` } });
        const removedMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: removedAccount.id, role: "member" },
        });
        const retainedAccount = await db.account.create({ data: { publicKey: `archived-group-retained-${team.id}` } });
        const retainedMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: retainedAccount.id, role: "member" },
        });
        await db.teamProvisionedIdentity.createMany({
            data: [
                {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "removed-person",
                    state: "active",
                    boundAccountId: removedAccount.id,
                    teamMembershipId: removedMembership.id,
                    teamMembershipTeamId: team.id,
                    lastSeenReconcileRunId: "previous-run",
                },
                {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "retained-person",
                    state: "active",
                    boundAccountId: retainedAccount.id,
                    teamMembershipId: retainedMembership.id,
                    teamMembershipTeamId: team.id,
                    lastSeenReconcileRunId: "archived-group-run",
                },
            ],
        });
        const projectedGroup = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "archived-group",
                externalDisplayName: "Archived Group",
                state: "active",
                lastSeenReconcileRunId: "archived-group-run",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: projectedGroup.externalGroupId,
                externalUserId: "retained-person",
                lastSeenReconcileRunId: "archived-group-run",
            },
        });
        const nativeGroup = await db.teamGroup.create({
            data: {
                teamId: team.id,
                name: storedPlainPrivateLabel("Archived Group"),
                archivedAt: new Date("2026-09-12T09:00:00.000Z"),
            },
        });
        await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: source.id,
                externalGroupId: projectedGroup.externalGroupId,
                bindingMode: "native_target",
            },
        });

        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "archived-group-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-12T10:05:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamMembership.findUnique({ where: { id: removedMembership.id } })).resolves.toBeNull();
        await expect(db.teamGroupMembership.findUnique({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: retainedMembership.id,
                },
            },
        })).resolves.toBeNull();

        await db.teamGroup.update({ where: { id: nativeGroup.id }, data: { archivedAt: null } });
        await expect(db.teamGroupMembership.findUnique({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: retainedMembership.id,
                },
            },
        })).resolves.toBeNull();
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: {
                state: "initializing",
                activeReconcileRunId: "restored-group-run",
                activeReconcileStartedAt: new Date("2026-09-12T11:00:00.000Z"),
            },
        });
        await expect(commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "restored-group-run",
            people: [{ externalUserId: "retained-person", active: true }],
            groups: [{ externalGroupId: projectedGroup.externalGroupId, displayName: "Archived Group" }],
            groupMembers: [{ externalGroupId: projectedGroup.externalGroupId, externalUserId: "retained-person" }],
        })).resolves.toEqual({ applied: true });
        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "restored-group-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-12T11:05:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamGroupMembership.findUnique({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: retainedMembership.id,
                },
            },
        })).resolves.not.toBeNull();
    });

    it("atomically activates the complete projection through native membership and Group owners", async () => {
        const team = await db.team.create({ data: { name: "Projection Completion Team" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
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
                state: "initializing",
                displayName: "WorkOS",
                externalSourceKey: `workos-complete:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "complete" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "complete-run",
                activeReconcileStartedAt: new Date("2026-09-05T10:00:00.000Z"),
                manualSyncRequestedAt: new Date("2026-09-05T09:00:00.000Z"),
            },
        });
        await commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "complete-run",
            people: [{ externalUserId: "unbound", active: true }],
        });

        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "complete-run",
            observedManualSyncRequestedAt: new Date("2026-09-05T09:00:00.000Z"),
            completedAt: new Date("2026-09-05T12:00:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).resolves.toMatchObject({
            state: "active",
            activeReconcileRunId: null,
            manualSyncRequestedAt: null,
            lastSuccessAt: new Date("2026-09-05T12:00:00.000Z"),
            lastFullReconcileAt: new Date("2026-09-05T12:00:00.000Z"),
            lastErrorCode: null,
        });

        const boundSource = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "initializing",
                displayName: "Bound WorkOS",
                externalSourceKey: `workos-bound:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "bound" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "bound-run",
                activeReconcileStartedAt: new Date("2026-09-05T10:00:00.000Z"),
            },
        });
        const account = await db.account.create({ data: { publicKey: `directory-bound-${team.id}` } });
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: boundSource.id,
                teamId: team.id,
                externalUserId: "bound-user",
                state: "active",
                boundAccountId: account.id,
                lastSeenReconcileRunId: "bound-run",
            },
        });
        const directoryGroup = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: boundSource.id,
                externalGroupId: "engineering",
                externalDisplayName: "Engineering",
                state: "active",
                lastSeenReconcileRunId: "bound-run",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: boundSource.id,
                externalGroupId: directoryGroup.externalGroupId,
                externalUserId: "bound-user",
                lastSeenReconcileRunId: "bound-run",
            },
        });
        const nativeGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Old Engineering")},
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: boundSource.id,
                externalGroupId: directoryGroup.externalGroupId,
                bindingMode: "directory_created",
            },
        });

        // One activation is one Team change: the admitted member, the Group
        // contribution and the managed Group rename below must wake this
        // Account exactly once, not once per materialized row.
        const cursorBeforeActivation = (await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).seq;
        await expect(completeDirectoryProjection({
            sourceId: boundSource.id,
            reconcileRunId: "bound-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-05T12:00:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: cursorBeforeActivation + 1 });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: boundSource.id } })).resolves.toMatchObject({
            state: "active",
            activeReconcileRunId: null,
            lastSuccessAt: new Date("2026-09-05T12:00:00.000Z"),
        });
        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        });
        expect(membership).toMatchObject({ status: "active", role: "member" });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: boundSource.id,
                    externalUserId: "bound-user",
                },
            },
        })).resolves.toMatchObject({ teamMembershipId: membership.id });
        await expect(db.teamGroup.findUniqueOrThrow({ where: { id: nativeGroup.id } })).resolves.toMatchObject({
            name: "Engineering",
            archivedAt: null,
        });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: membership.id,
                    externalGroupBindingId: binding.id,
                },
            },
        })).resolves.not.toBeNull();

        const conflictingAccount = await db.account.create({
            data: { publicKey: `directory-conflict-${team.id}` },
        });
        const conflictingMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: conflictingAccount.id, role: "member" },
        });
        await db.teamProvisionedIdentity.update({
            where: { id: (await db.teamProvisionedIdentity.findUniqueOrThrow({
                where: {
                    directorySourceId_externalUserId: {
                        directorySourceId: boundSource.id,
                        externalUserId: "bound-user",
                    },
                },
                select: { id: true },
            })).id },
            data: {
                teamMembershipId: conflictingMembership.id,
                teamMembershipTeamId: team.id,
            },
        });
        await db.teamDirectorySource.update({
            where: { id: boundSource.id },
            data: {
                state: "initializing",
                activeReconcileRunId: "conflict-run",
                activeReconcileStartedAt: new Date("2026-09-06T09:00:00.000Z"),
            },
        });
        await expect(completeDirectoryProjection({
            sourceId: boundSource.id,
            reconcileRunId: "conflict-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-06T09:05:00.000Z"),
        })).rejects.toThrow("bound identity disagrees with its Team membership owner");
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: boundSource.id } }))
            .resolves.toMatchObject({ state: "initializing", activeReconcileRunId: "conflict-run" });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: membership.id,
                    externalGroupBindingId: binding.id,
                },
            },
        })).resolves.not.toBeNull();
        await db.teamProvisionedIdentity.updateMany({
            where: { directorySourceId: boundSource.id, externalUserId: "bound-user" },
            data: { teamMembershipId: membership.id, teamMembershipTeamId: team.id },
        });

        await db.teamDirectorySource.update({
            where: { id: boundSource.id },
            data: {
                state: "initializing",
                activeReconcileRunId: "repair-run",
                activeReconcileStartedAt: new Date("2026-09-06T10:00:00.000Z"),
            },
        });
        await expect(completeDirectoryProjection({
            sourceId: boundSource.id,
            reconcileRunId: "repair-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-06T10:05:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamDirectoryGroup.findUniqueOrThrow({ where: { id: directoryGroup.id } }))
            .resolves.toMatchObject({ state: "deleted" });
        await expect(db.teamGroup.findUniqueOrThrow({ where: { id: nativeGroup.id } }))
            .resolves.toMatchObject({ name: "Engineering", archivedAt: null });
        await expect(db.teamExternalGroupBinding.findUnique({ where: { id: binding.id } }))
            .resolves.toBeNull();
        await expect(db.teamGroupMembershipExternalContribution.count({
            where: { externalGroupBindingId: binding.id },
        })).resolves.toBe(0);
        await expect(db.teamMembership.findUnique({ where: { id: membership.id } })).resolves.toBeNull();

        await db.teamDirectorySource.update({
            where: { id: boundSource.id },
            data: { eventCursor: "event_1" },
        });
        await expect(commitActiveWorkosProjectionEvent({
            sourceId: boundSource.id,
            expectedPosition: { eventCursor: "event_1" },
            eventId: "event_2",
            people: [{ externalUserId: "bound-user", active: true }],
            groups: [{ externalGroupId: "engineering", displayName: "Engineering" }],
            groupMembers: [{ externalGroupId: "engineering", externalUserId: "bound-user" }],
            completedAt: new Date("2026-09-06T10:10:00.000Z"),
        })).resolves.toEqual({ applied: true });
        const reactivatedMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: boundSource.id } }))
            .resolves.toMatchObject({
                eventCursor: "event_2",
                lastSuccessAt: new Date("2026-09-06T10:10:00.000Z"),
            });
        await expect(db.teamGroup.findUniqueOrThrow({ where: { id: nativeGroup.id } }))
            .resolves.toMatchObject({ archivedAt: null });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: reactivatedMembership.id,
                    externalGroupBindingId: binding.id,
                },
            },
        })).resolves.toBeNull();

        await db.teamProvisionedIdentity.createMany({
            data: ["failed-residue"].map((externalUserId) => ({
                directorySourceId: boundSource.id,
                teamId: team.id,
                externalUserId,
                state: "active" as const,
            })),
        });

        await expect(stageActiveWorkosGroupMemberEventPage({
            sourceId: boundSource.id,
            expectedPosition: { eventCursor: "event_2" },
            eventId: "event_3",
            attemptId: "failed-attempt",
            externalGroupId: "engineering",
            people: [{ externalUserId: "failed-residue", active: true }],
        })).resolves.toEqual({ applied: true });
        await expect(markActiveWorkosDirectoryPollFailed({
            sourceId: boundSource.id,
            expectedPosition: { eventCursor: "event_2" },
            reconcileRunId: "failed-attempt",
            errorCode: "directory_snapshot_incomplete",
            now: new Date("2026-09-06T10:20:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: boundSource.id } }))
            .resolves.toMatchObject({ state: "needs_attention", activeReconcileRunId: null });
        await expect(stageActiveWorkosGroupMemberEventPage({
            sourceId: boundSource.id,
            expectedPosition: { eventCursor: "event_2" },
            eventId: "event_3",
            attemptId: "retry-before-repair",
            externalGroupId: "engineering",
            people: [{ externalUserId: "retry-member", active: true }],
        })).resolves.toEqual({ applied: false, reason: "stale_run" });
        await expect(claimDirectorySourceFullReconcile({
            sourceId: boundSource.id,
            reconcileRunId: "failed-attempt-repair",
            now: new Date("2026-09-06T10:20:30.000Z"),
        })).resolves.toMatchObject({
            ok: true,
            source: { reconcileRunId: "failed-attempt-repair" },
        });
        await expect(commitDirectoryProjectionPage({
            sourceId: boundSource.id,
            reconcileRunId: "failed-attempt-repair",
            people: [
                { externalUserId: "bound-user", active: true },
                { externalUserId: "retry-member", active: true },
            ],
            groups: [{ externalGroupId: "engineering", displayName: "Engineering" }],
            groupMembers: [{ externalGroupId: "engineering", externalUserId: "bound-user" }],
        })).resolves.toEqual({ applied: true });
        await expect(completeDirectoryProjection({
            sourceId: boundSource.id,
            reconcileRunId: "failed-attempt-repair",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-06T10:21:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(stageActiveWorkosGroupMemberEventPage({
            sourceId: boundSource.id,
            expectedPosition: { eventCursor: "event_2" },
            eventId: "event_3",
            attemptId: "retry-attempt",
            externalGroupId: "engineering",
            people: [{ externalUserId: "retry-member", active: true }],
        })).resolves.toEqual({ applied: true });
        await expect(db.teamProvisionedIdentity.findUnique({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: boundSource.id,
                    externalUserId: "retry-member",
                },
            },
        })).resolves.toMatchObject({
            state: "active",
            lastSeenReconcileRunId: "workos-event:event_3:retry-attempt",
        });
        await expect(commitActiveWorkosProjectionEvent({
            sourceId: boundSource.id,
            expectedPosition: { eventCursor: "event_2" },
            eventId: "event_3",
            attemptId: "retry-attempt",
            replaceGroupMembers: [{ externalGroupId: "engineering" }],
        })).resolves.toEqual({ applied: true });
        await expect(db.teamDirectoryGroupMember.findMany({
            where: { directorySourceId: boundSource.id, externalGroupId: "engineering" },
            select: { externalUserId: true },
        })).resolves.toEqual([{ externalUserId: "retry-member" }]);
    });

    it("contributes Group rosters for a person whose Team lifetime another owner holds, without parking the source", async () => {
        const team = await db.team.create({ data: { name: "Natively seeded Team" } });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS", enabled: true, config: { v: 1, kind: "workos_sso" } },
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
                state: "initializing",
                displayName: "WorkOS",
                externalSourceKey: `workos-native:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "native" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "native-run",
                activeReconcileStartedAt: new Date("2026-09-10T10:00:00.000Z"),
            },
        });
        const account = await db.account.create({ data: { publicKey: `directory-native-${team.id}` } });
        // The administrator invited this person by hand before enabling the
        // directory, so the source will never own their lifetime.
        const nativeMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "admin" },
        });
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: team.id,
                externalUserId: "native-user",
                state: "active",
                boundAccountId: account.id,
                lastSeenReconcileRunId: "native-run",
            },
        });
        await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "engineering",
                externalDisplayName: "Engineering",
                state: "active",
                lastSeenReconcileRunId: "native-run",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "engineering",
                externalUserId: "native-user",
                lastSeenReconcileRunId: "native-run",
            },
        });
        const nativeGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Native Engineering")},
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: source.id,
                externalGroupId: "engineering",
                bindingMode: "native_target",
            },
        });

        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "native-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-10T12:00:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ state: "active", lastErrorCode: null, activeReconcileRunId: null });
        // The lifetime is untouched: no seizure, no role change, no manager.
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: nativeMembership.id },
            select: { role: true, provisionedIdentity: { select: { id: true } } },
        })).resolves.toEqual({ role: "admin", provisionedIdentity: null });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: nativeMembership.id,
                    externalGroupBindingId: binding.id,
                },
            },
        })).resolves.not.toBeNull();

        // The person leaves that directory Group. The next complete run sees
        // the identity and the Group but not the membership row, so the
        // contribution goes and the natively owned Team membership stays.
        await db.teamProvisionedIdentity.updateMany({
            where: { directorySourceId: source.id },
            data: { lastSeenReconcileRunId: "native-run-2" },
        });
        await db.teamDirectoryGroup.updateMany({
            where: { directorySourceId: source.id },
            data: { lastSeenReconcileRunId: "native-run-2" },
        });
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: {
                state: "initializing",
                activeReconcileRunId: "native-run-2",
                activeReconcileStartedAt: new Date("2026-09-11T10:00:00.000Z"),
            },
        });
        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "native-run-2",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-11T12:00:00.000Z"),
        })).resolves.toEqual({ applied: true });
        await expect(db.teamGroupMembershipExternalContribution.count({
            where: { externalGroupBindingId: binding.id },
        })).resolves.toBe(0);
        await expect(db.teamMembership.count({ where: { id: nativeMembership.id } })).resolves.toBe(1);
    });

    it("withdraws an inactive person's source contribution without touching a Team lifetime another owner keeps", async () => {
        const team = await db.team.create({ data: { name: "Offboarding Team" } });
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: team.id, kind: "workos_sso", displayName: "WorkOS", enabled: true, config: { v: 1, kind: "workos_sso" } },
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
                state: "initializing",
                displayName: "WorkOS",
                externalSourceKey: `workos-offboarding:${team.id}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "offboarding" },
                teamIdentityConnectionId: connection.id,
                activeReconcileRunId: "offboarding-run",
                activeReconcileStartedAt: new Date("2026-09-10T10:00:00.000Z"),
                eventCursor: "event-0",
            },
        });
        // Invited by hand before the directory existed: native owns this
        // lifetime and the directory only contributes Group evidence.
        const nativeAccount = await db.account.create({ data: { publicKey: `offboarding-native-${team.id}` } });
        const nativeMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: nativeAccount.id, role: "member" },
        });
        // Admitted by this directory: it owns this lifetime.
        const ownedAccount = await db.account.create({ data: { publicKey: `offboarding-owned-${team.id}` } });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Offboarding Engineering")},
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: group.id,
                directorySourceId: source.id,
                externalGroupId: "engineering",
                bindingMode: "native_target",
            },
        });

        await expect(commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId: "offboarding-run",
            people: [
                { externalUserId: "native-user", externalSubjectId: "subject-native", active: true },
                { externalUserId: "owned-user", externalSubjectId: "subject-owned", active: true },
            ],
            groups: [{ externalGroupId: "engineering", displayName: "Engineering" }],
            groupMembers: [
                { externalGroupId: "engineering", externalUserId: "native-user" },
                { externalGroupId: "engineering", externalUserId: "owned-user" },
            ],
        })).resolves.toEqual({ applied: true });
        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId: "offboarding-run",
            observedManualSyncRequestedAt: null,
            completedAt: new Date("2026-09-10T11:00:00.000Z"),
        })).resolves.toEqual({ applied: true });
        // Both people sign in through the real binder, which materializes this
        // source's share of the complete projection for each of them.
        for (const [account, subject] of [
            [nativeAccount, "subject-native"],
            [ownedAccount, "subject-owned"],
        ] as const) {
            await inTx(async (tx) => await bindDirectoryProvisionedIdentitiesInTx(tx, {
                accountId: account.id,
                teamId: team.id,
                match: { kind: "workos_directory", teamIdentityConnectionId: connection.id, externalSubjectId: subject },
            }));
        }
        const ownedMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: ownedAccount.id } },
        });
        const contributionFor = (teamMembershipId: string) => db.teamGroupMembershipExternalContribution.count({
            where: { externalGroupBindingId: binding.id, teamMembershipId },
        });
        await expect(contributionFor(nativeMembership.id)).resolves.toBe(1);
        await expect(contributionFor(ownedMembership.id)).resolves.toBe(1);

        // WorkOS deactivates both people.
        await expect(commitActiveWorkosProjectionEvent({
            sourceId: source.id,
            expectedPosition: { eventCursor: "event-0" },
            eventId: "event-deactivate",
            people: [
                { externalUserId: "native-user", active: false, externalUpdatedAt: new Date("2026-09-11T10:00:00.000Z") },
                { externalUserId: "owned-user", active: false, externalUpdatedAt: new Date("2026-09-11T10:00:00.000Z") },
            ],
        })).resolves.toEqual({ applied: true });

        // child 05 §8: deactivation suspends/removes that source's Team AND
        // Group facts only. The natively owned lifetime stays active and is not
        // seized, but this source's Group grant for it is withdrawn.
        await expect(db.teamMembership.findUniqueOrThrow({ where: { id: nativeMembership.id } }))
            .resolves.toMatchObject({ status: "active" });
        await expect(contributionFor(nativeMembership.id)).resolves.toBe(0);
        await expect(db.teamGroupMembership.count({
            where: { teamGroupId: group.id, teamMembershipId: nativeMembership.id },
        })).resolves.toBe(0);
        // The lifetime this source owns is suspended with its Group row and
        // horizon retained, exactly as before.
        await expect(db.teamMembership.findUniqueOrThrow({ where: { id: ownedMembership.id } }))
            .resolves.toMatchObject({ status: "suspended" });
        await expect(contributionFor(ownedMembership.id)).resolves.toBe(1);

        // Reactivation restores the source's contribution for both.
        await expect(commitActiveWorkosProjectionEvent({
            sourceId: source.id,
            expectedPosition: { eventCursor: "event-deactivate" },
            eventId: "event-reactivate",
            people: [
                { externalUserId: "native-user", active: true, externalUpdatedAt: new Date("2026-09-12T10:00:00.000Z") },
                { externalUserId: "owned-user", active: true, externalUpdatedAt: new Date("2026-09-12T10:00:00.000Z") },
            ],
        })).resolves.toEqual({ applied: true });
        await expect(contributionFor(nativeMembership.id)).resolves.toBe(1);
        await expect(db.teamMembership.findUniqueOrThrow({ where: { id: ownedMembership.id } }))
            .resolves.toMatchObject({ status: "active" });
        await expect(contributionFor(ownedMembership.id)).resolves.toBe(1);

        // A source-only change — a new person nobody has bound yet — changes
        // no native fact, but the mounted People list shows it, so the Team's
        // readers are woken.
        const seqBefore = (await db.account.findUniqueOrThrow({
            where: { id: nativeAccount.id },
            select: { seq: true },
        })).seq;
        await expect(commitActiveWorkosProjectionEvent({
            sourceId: source.id,
            expectedPosition: { eventCursor: "event-reactivate" },
            eventId: "event-new-person",
            people: [{ externalUserId: "new-user", displayName: "New person", active: true }],
        })).resolves.toEqual({ applied: true });
        await expect(db.teamProvisionedIdentity.count({
            where: { directorySourceId: source.id, externalUserId: "new-user", boundAccountId: null },
        })).resolves.toBe(1);
        expect((await db.account.findUniqueOrThrow({
            where: { id: nativeAccount.id },
            select: { seq: true },
        })).seq).toBeGreaterThan(seqBefore);
    });
});
