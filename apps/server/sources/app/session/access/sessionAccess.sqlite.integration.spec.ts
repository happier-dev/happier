import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "./sessionAccessAuthentication.testkit";
import { createSessionMessage, updateSessionReadCursor } from "@/app/session/sessionWriteService";
import { buildSessionAccessWhere, buildSessionReadableAccountWhereInTx, createApplicableAudienceWhere, buildMembershipHistorySessionAccessWhereInTx, resolveEffectiveSessionAccessWhere } from "./sessionAccessWhere";
import { assertSessionCapabilityInTx, resolveEffectiveSessionAccess, resolveEffectiveSessionAccessForSessionsInTx, resolveStructuralSessionAccessForAccountsInTx, resolveSessionAccessForOperation, SESSION_CAPABILITY_RULES, type SessionCapability, listCurrentSessionAudienceAccountsInTx, assertSessionTeamReadableGrantInTx, buildSessionAccessProjectionSelect, projectEffectiveSessionAccess } from "./sessionAccess";
import { inTx, type Tx } from "@/storage/inTx";
import { canApprovePermissions, canManagePermissionDelegation } from "@/app/session/access/sessionAccess";
import {
    resolveCurrentSessionRecipientAccountIdsBySessionInTx,
    resolveCurrentSessionRecipientAccountIdsInTx,
} from "./sessionRecipients";
import { loadSessionViewerProjection } from "@/app/session/personal/projection";
import { eventRouter } from "@/app/events/connectionEventRouter";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { setSessionPin } from "@/app/session/organization/organizationMutations";
import { RedisStreamsRoomEmitter } from "@/app/events/createRedisStreamsRoomEmitter";

const authentication = createPresentUserSessionAccessAuthentication({ env: {}, authenticationEvidence: [] });

describe("Session access owner/direct authority (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-session-access-", initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(level: "view" | "edit" | "admin", approval = false) {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const actor = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }), seq: 4,
        } });
        const share = await db.sessionShare.create({ data: {
            sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: actor.id,
            accessLevel: level, canApprovePermissions: approval,
        } });
        return { owner, actor, session, share };
    }

    async function enableKeyChallengeForAccount(accountId: string) {
        await db.account.update({
            where: { id: accountId },
            data: { encryptionMode: "e2ee" },
        });
    }

    it("rechecks the complete materialized Runner binding for every Session access decision", async () => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            id: `runner-session-${crypto.randomUUID()}`,
            accountId: account.id,
            tag: crypto.randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
        } });
        const machineId = `runner-machine-${crypto.randomUUID()}`;
        const installationId = `runner-installation-${crypto.randomUUID()}`;
        const installationPublicKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
        await db.machine.create({ data: {
            id: machineId,
            accountId: account.id,
            kind: "ephemeral_session_runner",
            metadata: "{}",
            installationId,
            installationPublicKey: Buffer.from(privacyKit.decodeBase64(installationPublicKey, "base64url")),
        } });
        await db.accessKey.create({ data: {
            accountId: account.id,
            sessionId: session.id,
            machineId,
            data: "runner-access-key",
        } });
        const activation = await db.ephemeralRunnerActivation.create({ data: {
            id: crypto.randomUUID(),
            creatorAccountId: account.id,
            creatorTokenEpoch: account.tokenEpoch,
            draftId: `runner-draft-${crypto.randomUUID()}`,
            sessionId: session.id,
            machineId,
            state: "materialized",
            workspacePolicy: "choose_on_endpoint",
            homeServerIdentityId: "srv_runner_access",
            activationSigningPublicKey: installationPublicKey,
            authoringCommitment: "a".repeat(43),
            artifact: {},
            endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
        } });
        const principal = {
            kind: "ephemeral_session_runner" as const,
            authority: "session_runtime" as const,
            accountId: account.id,
            activationId: activation.id,
            sessionId: session.id,
            machineId,
            installationId,
            installationPublicKey,
            creatorTokenEpoch: account.tokenEpoch,
        };
        const runnerAuthentication = {
            env: {},
            authority: "account_automation" as const,
            authenticationEvidence: undefined,
            sessionRuntimePrincipal: principal,
        };
        const sibling = await db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const batch = () => inTx(tx => resolveEffectiveSessionAccessForSessionsInTx(tx, {
            accountId: account.id, sessionIds: [session.id, sibling.id], authentication: runnerAuthentication,
        }));
        const decide = () => resolveSessionAccessForOperation(db, {
            accountId: account.id,
            sessionId: session.id,
            authentication: runnerAuthentication,
            capability: "readTranscript",
        });
        const query = () => inTx(async tx => await tx.session.findFirst({
            where: { AND: [
                { id: session.id },
                await buildSessionAccessWhere({
                    tx,
                    accountId: account.id,
                    capability: "readTranscript",
                    mode: "effective_access_v1",
                    authentication: runnerAuthentication,
                }),
            ] },
            select: { id: true },
        }));

        await expect(decide()).resolves.toMatchObject({ status: "allowed" });
        await expect(query()).resolves.toEqual({ id: session.id });
        expect([...(await batch()).keys()]).toEqual([session.id]);

        await db.machine.update({ where: { id: machineId }, data: { installationId: `${installationId}-substituted` } });
        await expect(decide()).resolves.toEqual({ status: "unavailable" });
        await expect(query()).resolves.toBeNull();
        expect((await batch()).size).toBe(0);
    });

    it("denies suspended owner and direct Accounts consistently without removing an active direct recipient", async () => {
        const { owner, actor, session } = await fixture("admin");
        const accounts = [owner.id, actor.id].sort();
        const admission = () => inTx(async tx => {
            const point: string[] = [];
            const query: string[] = [];
            const legacy: string[] = [];
            for (const accountId of accounts) {
                if (await resolveEffectiveSessionAccess(tx, { accountId, sessionId: session.id, authentication })) point.push(accountId);
                if (await tx.session.findFirst({ where: { AND: [{ id: session.id },
                    await buildSessionAccessWhere({ tx, accountId, capability: "readTranscript", mode: "effective_access_v1", authentication }),
                ] } })) query.push(accountId);
                if (await tx.session.findFirst({ where: { AND: [{ id: session.id },
                    buildSessionAccessWhere({ accountId, capability: "readTranscript", mode: "legacy_owner_or_direct" }),
                ] } })) legacy.push(accountId);
            }
            const inverse = (await tx.account.findMany({
                where: await buildSessionReadableAccountWhereInTx({ tx, sessionId: session.id }),
                select: { id: true }, orderBy: { id: "asc" },
            })).map(row => row.id);
            return { point, query, legacy, inverse };
        });
        expect(await admission()).toEqual({ point: accounts, query: accounts, legacy: accounts, inverse: accounts });
        await db.account.updateMany({ where: { id: { in: accounts } }, data: { status: "suspended" } });
        expect(await admission()).toEqual({ point: [], query: [], legacy: [], inverse: [] });
        await db.account.update({ where: { id: actor.id }, data: { status: "active" } });
        expect(await admission()).toEqual({ point: [actor.id], query: [actor.id], legacy: [actor.id], inverse: [actor.id] });
    });

    it("limits the inverse manager query to Accounts with the requested current capability", async () => {
        const { owner, actor, session, share } = await fixture("edit", true);
        const managers = () => inTx(async tx => {
            const input = { tx, sessionId: session.id, capability: "manageAccess" as const };
            return (await tx.account.findMany({ where: await buildSessionReadableAccountWhereInTx(input),
                select: { id: true }, orderBy: { id: "asc" },
            })).map(row => row.id);
        });
        expect(await managers()).toEqual([owner.id]);
        await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: "admin" } });
        expect(await managers()).toEqual([owner.id, actor.id].sort());
        await db.account.update({ where: { id: actor.id }, data: { status: "suspended" } });
        expect(await managers()).toEqual([owner.id]);
    });

    it("requires a published current exact Team grant for resource visibility, not authored context or a Group", async () => {
        const { owner, session } = await fixture("view");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const other = await db.team.create({ data: { name: crypto.randomUUID() } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Visibility", nameKey: "visibility" } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });
        await db.sessionGroupGrant.create({ data: { sessionId: session.id, teamGroupId: group.id, accessLevel: "admin", effectiveAt: new Date() } });
        const visible = (teamId = team.id) => inTx(tx => assertSessionTeamReadableGrantInTx({ tx, sessionId: session.id, teamId }));
        expect((await visible()).ok).toBe(false);
        const grant = await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
        expect((await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: owner.id, authentication }))?.sources).toEqual([{ kind: "owner" }]);
        expect((await visible()).ok).toBe(true);
        expect((await visible(other.id)).ok).toBe(false);
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect((await visible()).ok).toBe(false);
        await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "machine_only" } });
        expect((await visible()).ok).toBe(false);
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "hosted" } });
        expect((await visible()).ok).toBe(true);
        await db.session.update({ where: { id: session.id }, data: {
            currentStorageState: "snapshot_complete", materializationPublicationId: " ",
            materializedThroughSourceAt: 1n, publishedThroughServerSeq: 4,
        } });
        expect((await visible()).ok).toBe(false);
        await db.session.update({ where: { id: session.id }, data: { materializationPublicationId: "published" } });
        expect((await visible()).ok).toBe(true);
        harness.resetEnv({ HAPPIER_BUILD_FEATURES_DENY: "sharing.session" });
        try {
            expect((await visible()).ok).toBe(false);
        } finally {
            harness.restoreEnv();
        }
        await db.sessionTeamGrant.deleteMany({ where: { sessionId: session.id, teamId: team.id } });
        expect((await visible()).ok).toBe(false);
    });

    it("refuses write-service mutations by a direct editor after publication becomes unavailable", async () => {
        const { actor, session } = await fixture("edit");
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "machine_only" } });
        const readStateWhere = {
            accountId_sessionId: { accountId: actor.id, sessionId: session.id },
        };
        const before = await db.accountSessionReadState.findUnique({ where: readStateWhere });
        expect(await updateSessionReadCursor({
            actorUserId: actor.id,
            sessionId: session.id,
            lastViewedSessionSeq: 4,
            authentication,
        }))
            .toEqual({ ok: false, error: "forbidden" });
        const after = await db.accountSessionReadState.findUnique({ where: readStateWhere });
        expect(after).toEqual(before);
        expect(await db.accountChange.count({ where: { accountId: actor.id } })).toBe(0);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it("refuses viewer input even when a stale grant delegates permission approval", async () => {
        const { actor, session } = await fixture("view", true);
        expect(await createSessionMessage({ actorUserId: actor.id, sessionId: session.id,
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "denied" } } },
            inputAdmission: "authenticatedAccount",
            authentication,
        })).toEqual({ ok: false, error: "forbidden" });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        expect(await canApprovePermissions(actor.id, session.id, authentication)).toBe(false);
    });

    it("requires admin and delegated approval on the same direct grant", async () => {
        const { actor, session, share } = await fixture("admin");
        expect(await canManagePermissionDelegation(actor.id, session.id, authentication)).toBe(false);
        await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: "edit", canApprovePermissions: true } });
        expect(await canApprovePermissions(actor.id, session.id, authentication)).toBe(true);
        expect(await canManagePermissionDelegation(actor.id, session.id, authentication)).toBe(false);
        await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: "admin" } });
        expect(await canManagePermissionDelegation(actor.id, session.id, authentication)).toBe(true);
    });
    it("keeps relational admission and effective capabilities identical for current owner/direct facts", async () => {
        for (const level of ["view", "edit", "admin"] as const) {
            const { owner, actor, session, share } = await fixture(level, true);
            for (const accountId of [owner.id, actor.id]) {
                const access = await resolveEffectiveSessionAccess(db, { accountId, sessionId: session.id, authentication });
                for (const capability of Object.keys(SESSION_CAPABILITY_RULES) as SessionCapability[]) {
                    const row = await inTx(async tx => tx.session.findFirst({ where: { AND: [{ id: session.id },
                        await buildSessionAccessWhere({ tx, accountId, capability, mode: "effective_access_v1", authentication })] }, select: { id: true } }));
                    expect(row !== null).toBe(access?.capabilities[capability] === true);
                }
            }
            await db.sessionShare.delete({ where: { id: share.id } });
            expect(await resolveEffectiveSessionAccess(db, { accountId: actor.id, sessionId: session.id, authentication })).toBeNull();
            expect(await inTx(async tx => tx.session.findFirst({ where: { AND: [{ id: session.id }, await buildSessionAccessWhere({ tx,
                accountId: actor.id, capability: "readTranscript", mode: "effective_access_v1", authentication,
            })] }, select: { id: true } }))).toBeNull();
        }
    });

    it("pages the minimal audience without duplicate owner identity and removes unpublished recipients", async () => {
        const { owner, actor, session } = await fixture("view");
        const ids = [owner.id, actor.id].sort();
        const first = await inTx(tx => listCurrentSessionAudienceAccountsInTx({ tx, sessionId: session.id, limit: 1 }));
        expect(first).toEqual([{ accountId: ids[0] }]);
        const second = await inTx(tx => listCurrentSessionAudienceAccountsInTx({ tx, sessionId: session.id, afterAccountId: ids[0], limit: 1 }));
        expect(second).toEqual([{ accountId: ids[1] }]);
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "machine_only" } });
        expect(await inTx(tx => listCurrentSessionAudienceAccountsInTx({ tx, sessionId: session.id, limit: 10 })))
            .toEqual([{ accountId: owner.id }]);
    });

    it("filters complete applicable audiences independently of decisive sources and authored context", async () => {
        const { owner, actor, session, share } = await fixture("view");
        const team = await db.team.create({ data: { name: "Applicable" } });
        const hidden = await db.team.create({ data: { name: "Unrelated" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "guest" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Exact", nameKey: "exact" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        await db.sessionGroupGrant.create({ data: { sessionId: session.id, teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date() } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: hidden.id, accessLevel: "view", effectiveAt: new Date() } });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: hidden.id } });
        const count = (accountId: string, audiences: Parameters<typeof createApplicableAudienceWhere>[0]["audiences"]) => inTx(async tx => {
            const where = { AND: [{ id: session.id },
                await buildSessionAccessWhere({ tx, accountId, capability: "readTranscript", mode: "effective_access_v1", authentication }),
                await createApplicableAudienceWhere({ tx, accountId, audiences, authentication }),
            ] };
            const rows = await tx.session.findMany({ where, select: { id: true }, take: 1 });
            expect(await tx.session.count({ where })).toBe(rows.length);
            return rows.length;
        });
        expect(await count(actor.id, [{ kind: "team", teamId: team.id }])).toBe(1);
        expect(await count(actor.id, [{ kind: "group", teamId: team.id, groupId: group.id }])).toBe(1);
        expect(await count(actor.id, [{ kind: "group", teamId: hidden.id, groupId: group.id }])).toBe(0);
        expect(await count(actor.id, [{ kind: "team", teamId: hidden.id }])).toBe(0);
        expect(await count(actor.id, [{ kind: "outside_teams" }])).toBe(0);
        expect(await count(owner.id, [{ kind: "team", teamId: hidden.id }])).toBe(1);
        await db.teamGroupMembership.deleteMany({ where: { teamGroupId: group.id } });
        expect(await count(actor.id, [{ kind: "outside_teams" }])).toBe(1);
        expect(await count(actor.id, [{ kind: "team", teamId: hidden.id }, { kind: "outside_teams" }])).toBe(1);
        await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: "admin" } });
        expect(await count(actor.id, [{ kind: "team", teamId: hidden.id }])).toBe(1);
        await db.sessionTeamGrant.deleteMany({ where: { sessionId: session.id } });
        expect(await count(owner.id, [{ kind: "team", teamId: hidden.id }])).toBe(0);
    });

    it("compiles a large mixed audience selection from one qualified membership snapshot", async () => {
        const { actor } = await fixture("view");
        const team = await db.team.create({ data: { name: "Audience snapshot" } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: actor.id,
            role: "member",
        } });
        const group = await db.teamGroup.create({ data: {
            teamId: team.id,
            name: "Audience snapshot group",
            nameKey: "audience-snapshot-group",
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: membership.id,
        } });

        await inTx(async (tx) => {
            let membershipReads = 0;
            const reader = new Proxy(tx, {
                get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property !== "teamMembership" || typeof value !== "object" || value === null) return value;
                    return new Proxy(value, {
                        get(delegate, method, delegateReceiver) {
                            const member = Reflect.get(delegate, method, delegateReceiver);
                            if (method !== "findMany" || typeof member !== "function") return member;
                            return (...args: readonly unknown[]) => {
                                membershipReads += 1;
                                return Reflect.apply(member, delegate, args);
                            };
                        },
                    });
                },
            }) as Tx;
            const access = await resolveEffectiveSessionAccessWhere({
                tx: reader,
                accountId: actor.id,
                capability: "readTranscript",
                mode: "effective_access_v1",
                authentication,
            });
            await createApplicableAudienceWhere({
                tx: reader,
                accountId: actor.id,
                authentication,
                audiences: Array.from({ length: 200 }, (_, index) => index % 2 === 0
                    ? { kind: "team" as const, teamId: team.id }
                    : { kind: "group" as const, teamId: team.id, groupId: group.id }),
                collectiveAccessSnapshot: access.collectiveAccessSnapshot,
            });
            expect(membershipReads).toBe(1);
        });
    });

    it("restricts membership history to the exact qualifying grant before paging", async () => {
        const { owner, actor, session } = await fixture("view");
        const cutoff = new Date("2026-09-01T12:00:00.000Z");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: actor.id, role: "member", sessionAccessStartsAt: cutoff,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: cutoff,
        } });
        const visible = (actorAccountId = owner.id) => inTx(async tx => {
            const access = await buildMembershipHistorySessionAccessWhereInTx(tx, {
                actorAccountId,
                subject: { kind: "team", teamId: team.id, teamMembershipId: membership.id, expectedAccountId: actor.id },
                authentication,
            });
            if (!access.ok) return { rows: [], count: 0 };
            expect(access.recipientAccountId).toBe(actor.id);
            const where = { AND: [{ id: session.id }, access.where] };
            return {
                rows: await tx.session.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: 1 }),
                count: await tx.session.count({ where }),
            };
        });
        // The independent direct grant permits ordinary reads, not this membership's history.
        expect(await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: actor.id, authentication })).not.toBeNull();
        expect(await visible()).toEqual({ rows: [], count: 0 });
        await db.teamMembership.update({ where: { id: membership.id }, data: { sessionAccessStartsAt: null } });
        expect(await visible()).toEqual({ rows: [{ id: session.id }], count: 1 });
        // Reading the target history is not sufficient authority to prepare it.
        expect(await visible(actor.id)).toEqual({ rows: [], count: 0 });
        await db.team.update({ where: { id: team.id }, data: {
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "team_connection", connectionId: "company-sso" }] },
        } });
        // History preparation is structural and content-free; the eventual
        // recipient fetch rechecks that recipient's exact current credential.
        expect(await visible()).toEqual({ rows: [{ id: session.id }], count: 1 });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: getActivePrismaRuntime().DbNull } });
        expect(await visible()).toEqual({ rows: [{ id: session.id }], count: 1 });
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "machine_only" } });
        expect(await visible()).toEqual({ rows: [], count: 0 });
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "hosted" } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await visible()).toEqual({ rows: [], count: 0 });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
        expect(await visible()).toEqual({ rows: [], count: 0 });
        await db.teamMembership.update({ where: { id: membership.id }, data: { status: "active", accountId: owner.id } });
        // The URL lifetime survives provider replacement; the old discovery Account must not retarget.
        expect(await visible()).toEqual({ rows: [], count: 0 });
    });

    it("uses only the addressed Group's current membership horizon for history", async () => {
        const { owner, actor, session } = await fixture("view");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: actor.id, role: "guest", sessionAccessStartsAt: new Date("2026-09-02"),
        } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "History", nameKey: "history" } });
        const cutoff = new Date("2026-09-01");
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, sessionAccessStartsAt: cutoff,
        } });
        await db.sessionGroupGrant.create({ data: {
            sessionId: session.id, teamGroupId: group.id, accessLevel: "view", effectiveAt: cutoff,
        } });
        const visible = (teamId = team.id) => inTx(async tx => {
            const access = await buildMembershipHistorySessionAccessWhereInTx(tx, {
                actorAccountId: owner.id,
                subject: { kind: "group", teamId, groupId: group.id, accountId: actor.id },
                authentication,
            });
            if (!access.ok) return 0;
            expect(access.recipientAccountId).toBe(actor.id);
            return tx.session.count({ where: { AND: [{ id: session.id }, access.where] } });
        });
        expect(await visible()).toBe(0);
        await db.teamGroupMembership.update({ where: { teamGroupId_teamMembershipId: {
            teamGroupId: group.id, teamMembershipId: membership.id,
        } }, data: { sessionAccessStartsAt: null } });
        // A guest's later containing-Team horizon does not override the Group horizon.
        expect(await visible()).toBe(1);
        expect(await visible("unrelated-team")).toBe(0);
        await db.teamGroupMembership.deleteMany({ where: { teamGroupId: group.id, teamMembershipId: membership.id } });
        expect(await visible()).toBe(0);
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            sessionAccessStartsAt: new Date("2026-09-03"),
        } });
        expect(await visible()).toBe(0);
    });

    it("uses the same independent membership horizons for point, batch and bounded audience decisions", async () => {
        const { actor, session, share } = await fixture("view");
        await db.sessionShare.delete({ where: { id: share.id } });
        const cutoff = new Date("2026-09-01T12:00:00.000Z");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: actor.id, role: "member", sessionAccessStartsAt: cutoff,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "admin", effectiveAt: cutoff,
        } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Developers", nameKey: "developers" } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, sessionAccessStartsAt: null,
        } });
        await db.sessionGroupGrant.create({ data: {
            sessionId: session.id, teamGroupId: group.id, accessLevel: "edit", effectiveAt: cutoff,
            canApprovePermissions: true,
        } });
        const access = await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: actor.id, authentication });
        expect(access).toMatchObject({ level: "edit", capabilities: { approveRuntimePermissions: true, managePermissionDelegation: false } });
        expect(await inTx(async tx => (await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: session.id, accountIds: [actor.id],
        })).get(actor.id))).toEqual(access);
        expect(await inTx(tx => listCurrentSessionAudienceAccountsInTx({
            tx, sessionId: session.id, limit: 10,
        })))
            .toContainEqual({ accountId: actor.id });
        await inTx(async tx => {
            for (const capability of Object.keys(SESSION_CAPABILITY_RULES) as SessionCapability[]) {
                const matches = await tx.session.findFirst({ where: { AND: [
                    { id: session.id },
                    await buildSessionAccessWhere({ tx, accountId: actor.id, capability, mode: "effective_access_v1", authentication }),
                ] }, select: { id: true } });
                expect(matches !== null).toBe(access?.capabilities[capability] === true);
                const inverseInput = { tx, sessionId: session.id, capability };
                const inverseMatch = await tx.account.findFirst({ where: { AND: [
                    { id: actor.id }, await buildSessionReadableAccountWhereInTx(inverseInput),
                ] }, select: { id: true } });
                expect(inverseMatch !== null).toBe(access?.capabilities[capability] === true);
            }
        });
        await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
        expect(await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: actor.id, authentication })).toBeNull();
    });

    it("preserves direct sharing relevance when a stronger Team grant supplies the access explanation", async () => {
        const { owner, actor, session } = await fixture("view");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "admin", effectiveAt: new Date() } });
        const access = await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: actor.id, authentication });
        expect(access?.sources).toEqual([{ kind: "team", teamId: team.id, requiredByTeamPolicy: false }]);
        expect((await loadSessionViewerProjection({ sessionId: session.id, accountId: actor.id, authentication }))?.relevance.reasons)
            .toContain("shared_directly_with_me");
        expect((await loadSessionViewerProjection({ sessionId: session.id, accountId: owner.id, authentication }))?.relevance.reasons)
            .not.toContain("shared_directly_with_me");
        await db.session.update({ where: { id: session.id }, data: { currentStorageState: "machine_only" } });
        expect(await loadSessionViewerProjection({ sessionId: session.id, accountId: actor.id, authentication })).toBeNull();
    });

    it("keeps structural delivery/key preparation separate from restricted content authority", async () => {
        const { actor, session } = await fixture("view");
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "team_connection", connectionId: "company-sso" }] },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "admin", canApprovePermissions: true,
            effectiveAt: new Date("2026-09-01T12:00:00.000Z"),
        } });
        expect(await inTx(async tx => (await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: session.id, accountIds: [actor.id],
        })).get(actor.id))).toMatchObject({ level: "admin", capabilities: { manageAccess: true, approveRuntimePermissions: true } });
        await db.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: actor.id } });
        expect(await inTx(tx => resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: session.id })))
            .toContain(actor.id);
        await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: actor.id,
            sessionId: session.id,
            authentication: { env: {}, authority: "present_user", authenticationEvidence: [] },
        }))).resolves.toEqual({ status: "authentication_unavailable" });
    });

    it("keeps the batch recipient projection semantically identical to the paged audience owner", async () => {
        const viewer = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const collaborator = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const suspended = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", status: "suspended" },
        });
        const createSession = (
            suffix: string,
            currentStorageState: "hosted" | "machine_only" = "hosted",
        ) => db.session.create({ data: {
            accountId: viewer.id,
            tag: `${crypto.randomUUID()}-${suffix}`,
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
            currentStorageState,
        } });

        const direct = await createSession("direct");
        await db.sessionShare.create({ data: {
            sessionId: direct.id,
            sharedByUserId: viewer.id,
            sharedWithUserId: collaborator.id,
            accessLevel: "view",
        } });

        const effectiveAt = new Date("2026-09-01T12:00:00.000Z");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: collaborator.id,
            role: "member",
            sessionAccessStartsAt: new Date(effectiveAt.getTime() - 1),
        } });
        const teamSession = await createSession("team");
        await db.sessionTeamGrant.create({ data: {
            sessionId: teamSession.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt,
        } });

        const guestTeam = await db.team.create({ data: { name: crypto.randomUUID() } });
        const guestMembership = await db.teamMembership.create({ data: {
            teamId: guestTeam.id,
            accountId: collaborator.id,
            role: "guest",
        } });
        const groupName = crypto.randomUUID();
        const group = await db.teamGroup.create({ data: {
            teamId: guestTeam.id,
            name: groupName,
            nameKey: groupName,
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: guestTeam.id,
            teamGroupId: group.id,
            teamMembershipId: guestMembership.id,
        } });
        const groupSession = await createSession("group");
        await db.sessionGroupGrant.create({ data: {
            sessionId: groupSession.id,
            teamGroupId: group.id,
            accessLevel: "view",
            effectiveAt,
        } });

        const cutoffTeam = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: {
            teamId: cutoffTeam.id,
            accountId: collaborator.id,
            role: "member",
            sessionAccessStartsAt: effectiveAt,
        } });
        const cutoffSession = await createSession("cutoff");
        await db.sessionTeamGrant.create({ data: {
            sessionId: cutoffSession.id,
            teamId: cutoffTeam.id,
            accessLevel: "view",
            effectiveAt,
        } });

        const unpublished = await createSession("unpublished", "machine_only");
        await db.sessionShare.create({ data: {
            sessionId: unpublished.id,
            sharedByUserId: viewer.id,
            sharedWithUserId: collaborator.id,
            accessLevel: "view",
        } });
        const suspendedDirect = await createSession("suspended");
        await db.sessionShare.create({ data: {
            sessionId: suspendedDirect.id,
            sharedByUserId: viewer.id,
            sharedWithUserId: suspended.id,
            accessLevel: "view",
        } });

        const sessionIds = [
            direct.id,
            teamSession.id,
            groupSession.id,
            cutoffSession.id,
            unpublished.id,
            suspendedDirect.id,
        ];
        const { batch, point } = await inTx(async (tx) => ({
            batch: await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
                sessionIds: ["", ...sessionIds, direct.id],
            }),
            point: new Map(await Promise.all(sessionIds.map(async (sessionId) => [
                sessionId,
                (await listCurrentSessionAudienceAccountsInTx({ tx, sessionId, limit: 10 })).map(row => row.accountId),
            ] as const))),
        }));

        for (const sessionId of sessionIds) {
            expect(batch.get(sessionId)).toEqual(point.get(sessionId));
        }
        expect(batch.get(direct.id)).toEqual([collaborator.id, viewer.id].sort());
        expect(batch.get(teamSession.id)).toEqual([collaborator.id, viewer.id].sort());
        expect(batch.get(groupSession.id)).toEqual([collaborator.id, viewer.id].sort());
        expect(batch.get(cutoffSession.id)).toEqual([viewer.id]);
        expect(batch.get(unpublished.id)).toEqual([viewer.id]);
        expect(batch.get(suspendedDirect.id)).toEqual([viewer.id]);
        expect(batch.has("")).toBe(false);
    });

    it("qualifies only the exact credential for restricted Team point, query, and mutation access", async () => {
        const { actor, session, share } = await fixture("view");
        await enableKeyChallengeForAccount(actor.id);
        await db.sessionShare.delete({ where: { id: share.id } });
        const policy = {
            v: 1 as const,
            mode: "restricted" as const,
            accepted: [{ kind: "home_method" as const, methodId: "key_challenge" }],
        };
        const team = await db.team.create({ data: { name: crypto.randomUUID(), authenticationPolicy: policy } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "admin",
            effectiveAt: new Date(),
        } });
        const qualified = {
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
            authority: "present_user" as const,
            authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
        };
        const unqualified = { ...qualified, authenticationEvidence: [] };

        await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: actor.id,
            sessionId: session.id,
            authentication: qualified,
        }))).resolves.toMatchObject({ status: "allowed", access: { level: "admin" } });
        await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: actor.id,
            sessionId: session.id,
            authentication: unqualified,
        }))).resolves.toEqual({ status: "authentication_required" });
        await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: actor.id,
            sessionId: session.id,
            authentication: {
                ...qualified,
                authenticationEvidence: [{ kind: "home_method", methodId: "password" }],
            },
        }))).resolves.toEqual({ status: "authentication_required" });
        await expect(inTx(tx => listCurrentSessionAudienceAccountsInTx({
            tx,
            sessionId: session.id,
            limit: 10,
        }))).resolves.toContainEqual({ accountId: actor.id });

        await inTx(async tx => {
            const qualifiedRow = await tx.session.findFirst({ where: { AND: [
                { id: session.id },
                await buildSessionAccessWhere({ tx, accountId: actor.id, capability: "readTranscript", mode: "effective_access_v1", authentication: qualified }),
            ] } });
            const unqualifiedRow = await tx.session.findFirst({ where: { AND: [
                { id: session.id },
                await buildSessionAccessWhere({ tx, accountId: actor.id, capability: "readTranscript", mode: "effective_access_v1", authentication: unqualified }),
            ] } });
            expect(qualifiedRow?.id).toBe(session.id);
            expect(unqualifiedRow).toBeNull();
            await expect(assertSessionCapabilityInTx({
                tx,
                accountId: actor.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: qualified,
            })).resolves.toMatchObject({ ok: true });
            await expect(assertSessionCapabilityInTx({
                tx,
                accountId: actor.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: unqualified,
            })).resolves.toEqual({ ok: false, reason: "authentication_required" });
        });
    });

    it("preserves capability-specific authentication continuation without bypassing direct capability checks", async () => {
        const { actor, session, share } = await fixture("edit");
        await enableKeyChallengeForAccount(actor.id);
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "admin",
            effectiveAt: new Date(),
        } });
        await db.sessionShare.update({
            where: { id: share.id },
            data: { accessLevel: "edit", canApprovePermissions: false },
        });
        const enabled = {
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
            authority: "present_user" as const,
            authenticationEvidence: [],
        };

        await inTx(async tx => {
            await expect(resolveSessionAccessForOperation(tx, {
                accountId: actor.id,
                sessionId: session.id,
                authentication: enabled,
                capability: "readTranscript",
            })).resolves.toMatchObject({ status: "allowed", access: { level: "edit" } });
            await expect(resolveSessionAccessForOperation(tx, {
                accountId: actor.id,
                sessionId: session.id,
                authentication: enabled,
                capability: "manageAccess",
            })).resolves.toEqual({ status: "authentication_required" });
            await expect(resolveSessionAccessForOperation(tx, {
                accountId: actor.id,
                sessionId: session.id,
                authentication: {
                    ...enabled,
                    env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" },
                },
                capability: "manageAccess",
            })).resolves.toEqual({ status: "authentication_unavailable" });
            await expect(assertSessionCapabilityInTx({
                tx,
                accountId: actor.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: enabled,
            })).resolves.toEqual({ ok: false, reason: "authentication_required" });
            await expect(assertSessionCapabilityInTx({
                tx,
                accountId: actor.id,
                sessionId: session.id,
                capability: "manageAccess",
                authentication: {
                    ...enabled,
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            })).resolves.toMatchObject({ ok: true, access: { level: "admin" } });

            await tx.sessionTeamGrant.update({
                where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } },
                data: { accessLevel: "view" },
            });
            await expect(resolveSessionAccessForOperation(tx, {
                accountId: actor.id,
                sessionId: session.id,
                authentication: enabled,
                capability: "manageAccess",
            })).resolves.toEqual({ status: "unavailable" });
        });
    });

    it("keeps query admission, row projection and batch reads on the same exact Team qualification result", async () => {
        const { actor, session } = await fixture("view");
        await enableKeyChallengeForAccount(actor.id);
        const qualifiedTeam = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }] },
        } });
        const unqualifiedTeam = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }] },
        } });
        for (const team of [qualifiedTeam, unqualifiedTeam]) {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        }
        await db.sessionTeamGrant.createMany({ data: [
            { sessionId: session.id, teamId: qualifiedTeam.id, accessLevel: "edit", effectiveAt: new Date() },
            { sessionId: session.id, teamId: unqualifiedTeam.id, accessLevel: "admin", canApprovePermissions: true, effectiveAt: new Date() },
        ] });
        const authentication = {
            env: {
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
                HAPPIER_FEATURE_AUTH_LOGIN__NATIVE_PASSWORD_ENABLED: "1",
            },
            authority: "present_user" as const,
            authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
        };

        await inTx(async tx => {
            const resolution = await resolveEffectiveSessionAccessWhere({
                tx, accountId: actor.id, capability: "readTranscript", mode: "effective_access_v1", authentication,
            });
            expect([...resolution.qualifiedTeamIds]).toEqual([qualifiedTeam.id]);
            const row = await tx.session.findFirstOrThrow({
                where: { AND: [{ id: session.id }, resolution.where] },
                select: buildSessionAccessProjectionSelect(actor.id),
            });
            expect(projectEffectiveSessionAccess(row, actor.id, {
                qualifiedTeamIds: resolution.qualifiedTeamIds,
            })).toMatchObject({
                level: "edit",
                sources: [{ kind: "team", teamId: qualifiedTeam.id, requiredByTeamPolicy: false }],
                capabilities: { manageAccess: false, managePermissionDelegation: false },
            });
            const batch = await resolveEffectiveSessionAccessForSessionsInTx(tx, {
                accountId: actor.id, sessionIds: [session.id], authentication,
            });
            expect(batch.get(session.id)).toMatchObject({
                level: "edit", sources: [{ kind: "team", teamId: qualifiedTeam.id, requiredByTeamPolicy: false }],
                capabilities: { submitAgentInput: true, manageAccess: false },
            });
            const unqualified = await resolveEffectiveSessionAccessForSessionsInTx(tx, {
                accountId: actor.id, sessionIds: [session.id], authentication: { ...authentication, authenticationEvidence: [] },
            });
            expect(unqualified.get(session.id)).toMatchObject({ level: "view", capabilities: { submitAgentInput: false } });
        });
    });

    it("delivers protected Session events only to the qualified credential for one Account", async () => {
        const { actor, session, share } = await fixture("view");
        await enableKeyChallengeForAccount(actor.id);
        await db.sessionShare.delete({ where: { id: share.id } });
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(),
        } });
        const delivered: string[] = [];
        const connection = (id: string, evidence: readonly { kind: "home_method"; methodId: string }[]): ClientConnection => ({
            connectionType: "user-scoped",
            userId: actor.id,
            socket: {
                id,
                data: {
                    userId: actor.id,
                    clientType: "user-scoped",
                    authAuthority: "present_user",
                    authTokenAuthenticationEvidence: evidence,
                },
                emit: () => { delivered.push(id); },
            // Socket.IO is the external transport boundary; this fixture implements only the fields EventRouter reads.
            } as unknown as ClientConnection["socket"],
        });
        const qualified = connection("qualified", [{ kind: "home_method", methodId: "key_challenge" }]);
        const unqualified = connection("unqualified", []);
        const malformed = {
            connectionType: "user-scoped",
            userId: actor.id,
            socket: { id: "malformed", data: { userId: actor.id, clientType: "user-scoped" }, emit: () => { delivered.push("malformed"); } },
        // Deliberately malformed external socket metadata exercises fail-closed recipient filtering.
        } as unknown as ClientConnection;
        eventRouter.clearIo();
        eventRouter.addConnection(actor.id, malformed);
        eventRouter.addConnection(actor.id, qualified);
        eventRouter.addConnection(actor.id, unqualified);
        try {
            await eventRouter.emitUpdate({
                userId: actor.id,
                payload: { body: { t: "update-session", id: session.id } } as never,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
            });
            expect(delivered).toEqual(["qualified"]);

            delivered.length = 0;
            eventRouter.setIo({
                in: () => ({ fetchSockets: async () => [malformed.socket, qualified.socket, unqualified.socket] }),
                to: (socketId) => ({
                    emit: () => { delivered.push(String(socketId)); },
                    disconnectSockets: () => undefined,
                }),
            });
            await eventRouter.emitUpdate({
                userId: actor.id,
                payload: { body: { t: "update-session", id: session.id } } as never,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
            });
            expect(delivered).toEqual(["qualified"]);
        } finally {
            eventRouter.clearIo();
            eventRouter.removeConnection(actor.id, malformed);
            eventRouter.removeConnection(actor.id, qualified);
            eventRouter.removeConnection(actor.id, unqualified);
        }
    });

    it("forwards unresolved protected Session delivery from a headless Redis publisher", async () => {
        const { actor, session } = await fixture("view");
        const xadd = vi.fn(async () => "1-0");
        eventRouter.setIo(new RedisStreamsRoomEmitter({ xadd }, { maxLen: 100, streamName: "test-stream" }));
        try {
            const payload = { body: { t: "update-session", id: session.id } } as never;
            await eventRouter.emitUpdate({
                userId: actor.id,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
            });
            expect(xadd).toHaveBeenCalledTimes(1);
            const args = xadd.mock.calls[0];
            const fields = Object.fromEntries(Array.from(
                { length: (args.length - 5) / 2 },
                (_, index) => [args[5 + index * 2], args[6 + index * 2]],
            ));
            expect(fields.type).toBe("9");
            expect(JSON.parse(String(fields.data))).toEqual({
                packet: [
                    "happier:credential-qualified-session-delivery:v1",
                    {
                        v: 1,
                        accountId: actor.id,
                        sessionId: session.id,
                        eventName: "update",
                        payload,
                    },
                ],
            });
        } finally {
            eventRouter.clearIo();
        }
    });

    it("qualifies organization mutations against the acting credential", async () => {
        const { actor, session, share } = await fixture("view");
        await enableKeyChallengeForAccount(actor.id);
        await db.sessionShare.delete({ where: { id: share.id } });
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date() } });
        const base = {
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
            authority: "present_user" as const,
        };
        await expect(setSessionPin({
            accountId: actor.id,
            sessionId: session.id,
            request: { pinned: true, sortKey: null },
            authentication: { ...base, authenticationEvidence: [] },
        })).resolves.toEqual({ error: "session-not-found" });
        await expect(setSessionPin({
            accountId: actor.id,
            sessionId: session.id,
            request: { pinned: true, sortKey: null },
            authentication: { ...base, authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }] },
        })).resolves.toMatchObject({ pin: { sessionId: session.id } });
    });

    it("keeps a valid direct OR path when restricted Team qualification fails", async () => {
        const { actor, session } = await fixture("edit");
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id, accessLevel: "admin", effectiveAt: new Date() } });

        const independentTeam = await db.team.create({ data: { name: crypto.randomUUID() } });
        const independentMembership = await db.teamMembership.create({ data: {
            teamId: independentTeam.id,
            accountId: actor.id,
            role: "member",
        } });
        const group = await db.teamGroup.create({ data: {
            teamId: independentTeam.id,
            name: "Independent",
            nameKey: crypto.randomUUID(),
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: independentTeam.id,
            teamGroupId: group.id,
            teamMembershipId: independentMembership.id,
        } });
        await db.sessionGroupGrant.create({ data: {
            sessionId: session.id,
            teamGroupId: group.id,
            accessLevel: "edit",
            effectiveAt: new Date(),
        } });

        await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: actor.id,
            sessionId: session.id,
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user",
                authenticationEvidence: [],
            },
        }))).resolves.toMatchObject({ status: "allowed", access: { level: "edit", sources: [{ kind: "direct" }] } });

        await db.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: actor.id } });
        await expect(inTx(tx => resolveSessionAccessForOperation(tx, {
            accountId: actor.id,
            sessionId: session.id,
            authentication: {
                env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
                authority: "present_user",
                authenticationEvidence: [],
            },
        }))).resolves.toMatchObject({ status: "allowed", access: { level: "edit", sources: [{ kind: "group", teamId: independentTeam.id, groupId: group.id }] } });
    });

    it("keeps direct access available while disabled Session sharing cannot expand recipients", async () => {
        const { owner, actor, session, share } = await fixture("view");
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "admin", effectiveAt: new Date(),
        } });
        harness.resetEnv({ HAPPIER_BUILD_FEATURES_DENY: "sharing.session" });
        try {
            expect(await resolveEffectiveSessionAccess(db, { sessionId: session.id, accountId: actor.id, authentication }))
                .toMatchObject({ level: "view" });
            await db.sessionShare.delete({ where: { id: share.id } });
            expect(await inTx(tx => resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: session.id })))
                .toEqual([owner.id]);
        } finally {
            harness.restoreEnv();
        }
    });

});
