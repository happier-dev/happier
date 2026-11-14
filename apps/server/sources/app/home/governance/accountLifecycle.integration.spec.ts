import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setAccountStatusInTx } from "./accountLifecycle";
import { readRunnerCreatorCurrentnessInTx } from "@/app/ephemeralRunner/activationCurrentness";
import { TEAM_CHANGE_ENTITY_ID } from "@/app/teams/teamChanges";
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from "@happier-dev/protocol/changes";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { preparePlainAccountApiTokenLabel, storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";

// Socket.IO transport is the boundary. Real transactions, lifecycle, Account
// change allocation, authorization and credential revocation all execute.
const disconnectedRooms: string[] = [];

describe("Account lifecycle", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-lifecycle-",
            initAuth: true,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 120_000);
    afterEach(async () => {
        eventRouter.clearIo();
        disconnectedRooms.length = 0;
        await db.machine.deleteMany();
        await db.session.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { await harness.close(); });

    function observeSocketTransport() {
        eventRouter.setIo({ to: (rooms) => ({
            emit: () => {},
            disconnectSockets: () => { disconnectedRooms.push(...(Array.isArray(rooms) ? rooms : [rooms])); },
        }) });
    }

    it("uses current Account status alone for Runner admission after the legacy marker cutover", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const marker = `auth_disabled_${account.id}`;
        await db.repeatKey.create({ data: { key: marker, value: "obsolete", expiresAt: new Date(Date.now() + 60_000) } });
        try {
            await expect(inTx((tx) => readRunnerCreatorCurrentnessInTx(tx, account.id))).resolves.toMatchObject({ status: "ready" });
            await inTx((tx) => setAccountStatusInTx(tx, {
                actorAccountId: account.id, targetAccountId: account.id,
                status: "disabled", authority: "account_erasure",
            }));
            await expect(inTx((tx) => readRunnerCreatorCurrentnessInTx(tx, account.id))).resolves.toEqual({ status: "creator_unavailable" });
        } finally {
            await db.repeatKey.delete({ where: { key: marker } });
        }
    });

    it("atomically disables, revokes and invalidates once; re-enable retains keys and never revives credentials", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner" } });
        const account = await db.account.create({ data: { publicKey: "invalid-key-is-still-disableable", encryptionMode: "e2ee", settings: "retained" } });
        const machine = await db.machine.create({ data: { id: "lifecycle-retained-machine", accountId: account.id, metadata: "retained" } });
        const signed = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Before disable") });
        observeSocketTransport();
        const disable = () => inTx((tx) => setAccountStatusInTx(tx, {
            actorAccountId: actor.id, targetAccountId: account.id, status: "suspended", authority: "home_administration",
        }));
        await expect(disable()).resolves.toMatchObject({ status: "applied" });
        const disabled = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        expect(disabled).toEqual({ ...account, status: "suspended", tokenEpoch: 1, seq: account.seq + 1, updatedAt: expect.any(Date) });
        expect(disconnectedRooms.sort()).toEqual([
            `account-revocation:${account.id}`,
            `user:${account.id}`,
            `user-machines:${account.id}`,
        ].sort());
        expect(await db.machine.findUnique({ where: { id: machine.id } })).toEqual(machine);
        await expect(disable()).resolves.toMatchObject({ status: "unchanged" });
        expect(await db.account.findUnique({ where: { id: account.id } })).toEqual(disabled);
        expect(disconnectedRooms).toHaveLength(3);
        await expect(inTx((tx) => setAccountStatusInTx(tx, {
            actorAccountId: actor.id, targetAccountId: account.id, status: "active", authority: "home_administration",
        }))).resolves.toMatchObject({ status: "applied" });
        await expect(auth.verifyToken(signed)).resolves.toBeNull();
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).tokenEpoch).toBe(1);
        await expect(auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" })).resolves.toEqual(expect.any(String));
    });

    it("rolls back status, cursor and complete credentials without disconnecting", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner" } });
        const target = await db.account.create({ data: {} });
        const pat = await auth.createApiToken({ accountId: target.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(target.id, "Retained") });
        const row = await db.accountApiToken.findUniqueOrThrow({ where: { id: pat.tokenId } });
        observeSocketTransport();
        await expect(inTx(async (tx) => {
            await setAccountStatusInTx(tx, { actorAccountId: actor.id, targetAccountId: target.id, status: "suspended", authority: "home_administration" });
            expect(disconnectedRooms).toEqual([]);
            throw new Error("abort lifecycle");
        })).rejects.toThrow("abort lifecycle");
        expect(await db.account.findUnique({ where: { id: target.id } })).toEqual(target);
        expect(await db.accountApiToken.findUnique({ where: { id: row.id } })).toEqual(row);
        expect(disconnectedRooms).toEqual([]);
    });

    it("invalidates affected Team viewers on lifecycle changes, but not rollback or an unchanged retry", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const target = await db.account.create({ data: { encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
        const unrelated = await db.account.create({ data: { encryptionMode: "plain" } });
        await db.team.create({ data: { name: "Lifecycle observers", memberships: { create: [
            { accountId: target.id, role: "owner" },
            { accountId: viewer.id, role: "member" },
        ] } } });
        await db.team.create({ data: { name: "Shared lifecycle observers", memberships: { create: [
            { accountId: target.id, role: "owner" },
            { accountId: viewer.id, role: "member" },
        ] } } });
        const transition = (status: "active" | "suspended") => inTx(tx => setAccountStatusInTx(tx, {
            actorAccountId: actor.id, targetAccountId: target.id, status, authority: "home_administration",
        }));
        const change = () => db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: viewer.id, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID,
        } } });

        await expect(inTx(async tx => {
            await setAccountStatusInTx(tx, {
                actorAccountId: actor.id, targetAccountId: target.id, status: "suspended", authority: "home_administration",
            });
            throw new Error("abort Team lifecycle wake");
        })).rejects.toThrow("abort Team lifecycle wake");
        expect(await change()).toBeNull();
        expect(await transition("suspended")).toEqual({ status: "applied" });
        const suspendedChange = await change();
        expect(suspendedChange).toMatchObject({ hint: null, cursor: viewer.seq + 1 });
        expect(await transition("suspended")).toEqual({ status: "unchanged" });
        expect(await change()).toEqual(suspendedChange);
        expect(await transition("active")).toEqual({ status: "applied" });
        expect((await change())?.cursor).toBeGreaterThan(suspendedChange!.cursor);
        expect(await db.accountChange.count({ where: { accountId: unrelated.id } })).toBe(0);
    });

    it("invalidates other Home administrators after lifecycle changes, but not rollback or an unchanged retry", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const administrator = await db.account.create({ data: { homeRole: "admin", encryptionMode: "plain" } });
        const target = await db.account.create({ data: { encryptionMode: "plain" } });
        const ordinaryMember = await db.account.create({ data: { encryptionMode: "plain" } });
        const transition = (status: "active" | "suspended") => inTx(tx => setAccountStatusInTx(tx, {
            actorAccountId: actor.id,
            targetAccountId: target.id,
            status,
            authority: "home_administration",
        }));
        const administratorChange = () => db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: administrator.id,
            kind: "account",
            entityId: HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
        } } });

        await expect(inTx(async tx => {
            await setAccountStatusInTx(tx, {
                actorAccountId: actor.id,
                targetAccountId: target.id,
                status: "suspended",
                authority: "home_administration",
            });
            throw new Error("abort Home governance wake");
        })).rejects.toThrow("abort Home governance wake");
        expect(await administratorChange()).toBeNull();

        expect(await transition("suspended")).toEqual({ status: "applied" });
        const suspendedChange = await administratorChange();
        expect(suspendedChange).toMatchObject({ hint: null, cursor: administrator.seq + 1 });
        expect(await db.accountChange.count({ where: {
            accountId: ordinaryMember.id,
            kind: "account",
            entityId: HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
        } })).toBe(0);

        expect(await transition("suspended")).toEqual({ status: "unchanged" });
        expect(await administratorChange()).toEqual(suspendedChange);
        expect(await transition("active")).toEqual({ status: "applied" });
        expect((await administratorChange())?.cursor).toBeGreaterThan(suspendedChange!.cursor);
    });

    it("clears responsibility atomically on suspension and never restores it on reactivation", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const target = await db.account.create({ data: { encryptionMode: "plain" } });
        const shared = await db.session.create({ data: {
            accountId: actor.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
            responsibleAccountId: target.id,
            shares: { create: { sharedByUserId: actor.id, sharedWithUserId: target.id, accessLevel: "view" } },
        } });
        const owned = await db.session.create({ data: {
            accountId: target.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
            responsibleAccountId: target.id,
        } });
        const suspend = (tx: Parameters<typeof setAccountStatusInTx>[0]) => setAccountStatusInTx(tx, {
            actorAccountId: actor.id, targetAccountId: target.id, status: "suspended", authority: "home_administration",
        });
        await expect(inTx(async tx => {
            await suspend(tx);
            throw new Error("abort responsibility cleanup");
        })).rejects.toThrow("abort responsibility cleanup");
        expect(await db.session.count({ where: { responsibleAccountId: target.id } })).toBe(2);

        expect(await inTx(suspend)).toEqual({ status: "applied" });
        expect(await db.session.findMany({ where: { id: { in: [shared.id, owned.id] } },
            select: { responsibleAccountId: true },
        })).toEqual([{ responsibleAccountId: null }, { responsibleAccountId: null }]);
        const change = await db.accountChange.findFirst({ where: {
            accountId: actor.id, kind: "session", entityId: shared.id,
        } });
        expect(change?.hint).toMatchObject({ responsibleAccountId: null });

        await inTx(tx => setAccountStatusInTx(tx, {
            actorAccountId: actor.id, targetAccountId: target.id, status: "active", authority: "home_administration",
        }));
        expect(await db.session.count({ where: { responsibleAccountId: target.id } })).toBe(0);
    });

    it("reconciles owned, direct, Team, and Group Session access without restoring personal state", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const target = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Lifecycle access" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: target.id, role: "member" },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Operators") },
        });
        await db.teamGroupMembership.create({
            data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id },
        });
        const common = {
            tag: crypto.randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            currentStorageState: "hosted",
            responsibleAccountId: target.id,
        } as const;
        const owned = await db.session.create({ data: { ...common, accountId: target.id } });
        const direct = await db.session.create({ data: {
            ...common,
            accountId: actor.id,
            tag: crypto.randomUUID(),
            shares: { create: { sharedByUserId: actor.id, sharedWithUserId: target.id, accessLevel: "view" } },
        } });
        const teamSession = await db.session.create({ data: {
            ...common,
            accountId: actor.id,
            tag: crypto.randomUUID(),
            teamGrants: { create: { teamId: team.id, accessLevel: "edit", effectiveAt: new Date() } },
        } });
        const groupSession = await db.session.create({ data: {
            ...common,
            accountId: actor.id,
            tag: crypto.randomUUID(),
            groupGrants: { create: { teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date() } },
        } });
        const unrelated = await db.session.create({ data: {
            accountId: actor.id,
            tag: crypto.randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            currentStorageState: "hosted",
        } });
        const affected = [owned, direct, teamSession, groupSession];
        for (const session of affected) {
            const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
            if (!key) throw new Error("expected Session draft key");
            await db.userKVStore.create({ data: {
                accountId: target.id,
                key,
                value: new Uint8Array([1]),
                version: 1,
            } });
            await db.accountSessionFollow.create({ data: {
                id: randomUUID(),
                accountId: target.id,
                sessionId: session.id,
                following: true,
            } });
        }

        const changeStatus = (status: "active" | "suspended") => inTx((tx) => setAccountStatusInTx(tx, {
            actorAccountId: actor.id,
            targetAccountId: target.id,
            status,
            authority: "home_administration",
        }));
        expect(await changeStatus("suspended")).toEqual({ status: "applied" });

        expect(await db.accountSessionFollow.count({ where: { accountId: target.id } })).toBe(0);
        expect(await db.session.count({ where: {
            id: { in: affected.map(session => session.id) },
            responsibleAccountId: target.id,
        } })).toBe(0);
        for (const session of affected) {
            const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
            if (!key) throw new Error("expected Session draft key");
            expect(await db.userKVStore.findUnique({
                where: { accountId_key: { accountId: target.id, key } },
                select: { value: true, version: true },
            })).toEqual({ value: null, version: 2 });
            expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: target.id,
                kind: "session",
                entityId: session.id,
            } } })).not.toBeNull();
        }
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: target.id,
            kind: "session",
            entityId: unrelated.id,
        } } })).toBeNull();

        expect(await changeStatus("active")).toEqual({ status: "applied" });
        expect(await db.accountSessionFollow.count({ where: { accountId: target.id } })).toBe(0);
        expect(await db.session.count({ where: { responsibleAccountId: target.id } })).toBe(0);
        for (const session of affected) {
            const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
            if (!key) throw new Error("expected Session draft key");
            expect(await db.userKVStore.findUnique({
                where: { accountId_key: { accountId: target.id, key } },
                select: { value: true, version: true },
            })).toEqual({ value: null, version: 2 });
        }
    });

    it("rolls back Account status and Session access effects together", async () => {
        const actor = await db.account.create({ data: { homeRole: "owner", encryptionMode: "plain" } });
        const target = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: actor.id,
            tag: crypto.randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            currentStorageState: "hosted",
            responsibleAccountId: target.id,
            shares: { create: { sharedByUserId: actor.id, sharedWithUserId: target.id, accessLevel: "view" } },
        } });
        const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
        if (!key) throw new Error("expected Session draft key");
        await db.userKVStore.create({ data: {
            accountId: target.id,
            key,
            value: new Uint8Array([1]),
            version: 1,
        } });
        await db.accountSessionFollow.create({ data: { id: randomUUID(), accountId: target.id, sessionId: session.id } });

        await expect(inTx(async tx => {
            expect(await setAccountStatusInTx(tx, {
                actorAccountId: actor.id,
                targetAccountId: target.id,
                status: "suspended",
                authority: "home_administration",
            })).toEqual({ status: "applied" });
            throw new Error("abort Account and Session effects");
        })).rejects.toThrow("abort Account and Session effects");

        expect(await db.account.findUnique({ where: { id: target.id }, select: { status: true } }))
            .toEqual({ status: "active" });
        expect(await db.accountSessionFollow.findUnique({ where: {
            accountId_sessionId: { accountId: target.id, sessionId: session.id },
        } })).not.toBeNull();
        expect(await db.userKVStore.findUnique({
            where: { accountId_key: { accountId: target.id, key } },
            select: { value: true, version: true },
        })).toEqual({ value: new Uint8Array([1]), version: 1 });
        expect(await db.session.findUnique({ where: { id: session.id }, select: { responsibleAccountId: true } }))
            .toEqual({ responsibleAccountId: target.id });
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: target.id,
            kind: "session",
            entityId: session.id,
        } } })).toBeNull();
    });

    it("checks current actor authority even for an idempotent result and retains the final active owner", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const admin = await db.account.create({ data: { homeRole: "admin" } });
        const secondOwner = await db.account.create({ data: { homeRole: "owner" } });
        const change = (actorAccountId: string, targetAccountId: string, status: "active" | "suspended") => inTx((tx) => setAccountStatusInTx(tx, {
            actorAccountId, targetAccountId, status, authority: "home_administration",
        }));
        await expect(change(admin.id, owner.id, "active")).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });
        await expect(change(admin.id, owner.id, "suspended")).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });
        await expect(change(owner.id, secondOwner.id, "suspended")).resolves.toMatchObject({ status: "applied" });
        await expect(change(owner.id, owner.id, "suspended")).resolves.toMatchObject({ status: "rejected", code: "home_owner_transfer_required" });
        await expect(change(secondOwner.id, admin.id, "active")).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });
        await expect(inTx((tx) => setAccountStatusInTx(tx, {
            actorAccountId: owner.id, targetAccountId: admin.id, status: "disabled", authority: "account_erasure",
        }))).resolves.toMatchObject({ status: "applied" });
        await expect(change(owner.id, admin.id, "active")).resolves.toMatchObject({ status: "rejected", code: "home_account_inactive" });
    });
});
