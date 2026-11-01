import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { captureSessionAccessMembershipImpactsInTx, applySessionAccessMembershipImpactsInTx } from "./sessionAccessMembershipImpact";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { putSessionAccessGrantInTx } from "./sessionAccessGrantService";
import { createPresentUserSessionAccessAuthentication } from "./sessionAccessAuthentication.testkit";
import { applySessionDataKeyEnvelopes, readSessionDataKeyEnvelopePage } from "@/app/session/encryption/sessionDataKeyEnvelopeService";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import { encodeBase64 } from "@happier-dev/protocol/crypto/base64";

describe("Membership Session access effects (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-membership-impact-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Membership impact" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Group", nameKey: "group" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            responsibleAccountId: member.id,
            teamGrants: { create: { teamId: team.id, accessLevel: "edit", effectiveAt: new Date() } },
            groupGrants: { create: { teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date() } },
        } });
        const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
        if (!key) throw new Error("expected Session draft key");
        await db.userKVStore.create({ data: { accountId: member.id, key, value: new Uint8Array([1]), version: 1 } });
        return { owner, member, team, membership, group, session, key };
    }

    /** Key delivery follows the audience owner: the wake carries no recipient, so the census alone decides who is owed. */
    it("wakes the E2EE Session owner for a member the horizon admits, never for an excluded or removed one", async () => {
        const authentication = createPresentUserSessionAccessAuthentication();
        const e2eeAccount = async () => {
            const binding = createSignedAccountContentBinding();
            const account = await db.account.create({ data: { publicKey: binding.publicKey, encryptionMode: "e2ee",
                contentPublicKey: Buffer.from(binding.contentPublicKey), contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
            return { ...account, contentPublicKey: binding.contentPublicKey };
        };
        const sealFor = (recipientPublicKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({
            dataKey: crypto.getRandomValues(new Uint8Array(32)), recipientPublicKey, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        });
        const [owner, admitted, excluded, stranger] = [await e2eeAccount(), await e2eeAccount(), await e2eeAccount(), await e2eeAccount()];
        const team = await db.team.create({ data: { name: "Key delivery" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "e2ee", metadata: JSON.stringify({ t: "encrypted", c: "" }), seq: 1,
            metadataLayoutVersion: 1, currentStorageState: "hosted",
            teamGrants: { create: { teamId: team.id, accessLevel: "view", effectiveAt: new Date(Date.now() - 60_000) } },
        } });
        await db.sessionDataKeyEnvelope.create({ data: { sessionId: session.id, recipientAccountId: owner.id, encryptedDataKey: Buffer.from(sealFor(owner.contentPublicKey)) } });
        const changeMembership = async (accountId: string, mutate: (tx: Parameters<Parameters<typeof inTx>[0]>[0]) => Promise<unknown>) => await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [accountId], changes: [{ kind: "teamMembership", teamId: team.id }] });
            await mutate(tx);
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        const ownerShareCursor = async () => (await db.accountChange.findFirst({
            where: { accountId: owner.id, kind: "share", entityId: session.id }, select: { cursor: true },
        }))?.cursor ?? null;
        const owedRecipients = async () => {
            const result = await readSessionDataKeyEnvelopePage({ actorAccountId: owner.id, sessionId: session.id, authentication, query: { state: "action_required", limit: 24 } });
            if (!result.ok || result.page.status !== "required") throw new Error("expected a required page");
            return result.page.items.map(item => item.recipientAccountId);
        };

        await changeMembership(admitted.id, tx => tx.teamMembership.create({ data: { teamId: team.id, accountId: admitted.id, role: "member", sessionAccessStartsAt: null } }));
        const woken = await ownerShareCursor();
        expect(woken).not.toBeNull();
        expect(await owedRecipients()).toEqual([admitted.id]);

        // `from_membership` never reaches a pre-existing grant, so no key is owed and no wake is spent.
        await changeMembership(excluded.id, tx => tx.teamMembership.create({ data: { teamId: team.id, accountId: excluded.id, role: "member", sessionAccessStartsAt: new Date() } }));
        expect(await ownerShareCursor()).toBe(woken);
        expect(await owedRecipients()).toEqual([admitted.id]);

        // Neither census page nor commit owner serves a non-member, whatever a client claims.
        expect(await applySessionDataKeyEnvelopes({ actorAccountId: owner.id, sessionId: session.id, authentication, entries: [{
            recipientAccountId: stranger.id, encryptedDataKey: encodeBase64(sealFor(stranger.contentPublicKey)),
        }] })).toEqual({ ok: false, error: "recipient_changed" });

        // Removal owes nothing new: no wake, and the removed member leaves the worklist.
        await changeMembership(admitted.id, tx => tx.teamMembership.deleteMany({ where: { teamId: team.id, accountId: admitted.id } }));
        expect(await ownerShareCursor()).toBe(woken);
        expect(await owedRecipients()).toEqual([]);
        expect(await applySessionDataKeyEnvelopes({ actorAccountId: owner.id, sessionId: session.id, authentication, entries: [{
            recipientAccountId: admitted.id, encryptedDataKey: encodeBase64(sealFor(admitted.contentPublicKey)),
        }] })).toEqual({ ok: false, error: "recipient_changed" });
    });

    it("preserves a readable draft and responsibility on role downgrade, then clears them after final Group loss", async () => {
        const f = await fixture();
        await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamRole", teamId: f.team.id }] });
            await tx.teamMembership.update({ where: { id: f.membership.id }, data: { role: "guest" } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: f.member.id });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: new Uint8Array([1]) });
        expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.session.id, kind: "session" } })).toBe(1);
        expect(await db.accountChange.count({ where: { entityId: f.session.id, kind: "share" } })).toBe(0);

        await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamGroupMembership", teamId: f.team.id, teamGroupIds: [f.group.id] }] });
            await tx.teamGroupMembership.deleteMany({ where: { teamGroupId: f.group.id, teamMembershipId: f.membership.id } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: null });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: null });
        expect(await db.accountChange.count({ where: { entityId: f.session.id, kind: "share" } })).toBe(0);
    });

    it("does not invalidate access after removal of a weaker overlapping membership", async () => {
        const f = await fixture();
        await db.sessionShare.create({ data: { sessionId: f.session.id, sharedByUserId: f.owner.id, sharedWithUserId: f.member.id, accessLevel: "admin" } });
        await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }] });
            await tx.teamMembership.delete({ where: { id: f.membership.id } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        // The decisive direct access survives, while the audience context loses
        // its Team relationship and therefore needs a projection refresh.
        expect(await db.accountChange.count({ where: { entityId: f.session.id } })).toBe(1);
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: f.member.id });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: new Uint8Array([1]) });
    });

    it("restores Group access without enrolling Follow and preserves explicit unfollow", async () => {
        const f = await fixture();
        await db.account.update({ where: { id: f.member.id }, data: { sessionAutoFollowTeam: false, sessionAutoFollowGroup: true } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        const reactivate = () => inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }] });
            await tx.teamMembership.update({ where: { id: f.membership.id }, data: { status: "active" } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        await reactivate();
        const where = { accountId_sessionId: { accountId: f.member.id, sessionId: f.session.id } };
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        expect(await db.accountSessionReadState.findUnique({ where })).toBeNull();
        await db.accountSessionFollow.create({ data: {
            accountId: f.member.id, sessionId: f.session.id, following: false, followPolicy: JSON.stringify({ preset: "custom", events: {} }),
        } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        await reactivate();
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({ following: false, followPolicy: JSON.stringify({ preset: "custom", events: {} }) });
    });

    it.each([0, 1])("wakes only a legacy metadata owner when membership admits a new reader (layout %s)", async layout => {
        const f = await fixture();
        await db.session.update({ where: { id: f.session.id }, data: { metadataLayoutVersion: layout,
            ...(layout === 1 ? { metadata: JSON.stringify({ v: 1 }), ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }) } : {}),
        } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");
        try {
            await inTx(async tx => {
                const impacts = await captureSessionAccessMembershipImpactsInTx(tx, {
                    accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }],
                });
                await tx.teamMembership.update({ where: { id: f.membership.id }, data: { status: "active" } });
                await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
            });
            expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.session.id, kind: "session" } })).toBe(1);
            expect(await db.accountChange.count({ where: { accountId: f.owner.id, entityId: f.session.id, kind: "share" } })).toBe(layout === 0 ? 1 : 0);
            const ownerWakes = emitUpdate.mock.calls.filter(([input]) => input.userId === f.owner.id && input.payload.body.t === 'account-change');
            expect(ownerWakes).toHaveLength(layout === 0 ? 1 : 0);
        } finally { emitUpdate.mockRestore(); }
    });

    it("keeps the grant owner's existing roster publication at one cursor and one wake", async () => {
        const f = await fixture();
        const reader = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        await db.team.create({ data: { name: "Grant collaborators", memberships: { create: [
            { accountId: f.owner.id, role: "owner" }, { accountId: reader.id, role: "member" },
        ] } } });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate");
        try {
            const result = await inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: f.owner.id, sessionId: f.session.id,
                subject: { kind: "account", accountId: reader.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: createPresentUserSessionAccessAuthentication(),
            }));
            if (!result.ok) throw new Error(result.error);
            expect(result).toMatchObject({ ok: true, changed: true });
            expect(await db.account.findUnique({ where: { id: f.owner.id }, select: { seq: true } })).toEqual({ seq: f.owner.seq + 1 });
            expect(await db.accountChange.count({ where: { accountId: f.owner.id, entityId: f.session.id, kind: "share" } })).toBe(1);
            expect(emitUpdate.mock.calls.filter(([input]) => input.userId === f.owner.id && input.payload.body.t === 'account-change')).toHaveLength(1);
        } finally { emitUpdate.mockRestore(); }
    });

    it("rolls back access effects with the native mutation", async () => {
        const f = await fixture();
        await expect(inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }] });
            await tx.teamMembership.delete({ where: { id: f.membership.id } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
            throw new Error("native transition aborted");
        })).rejects.toThrow("native transition aborted");
        expect(await db.teamMembership.findUnique({ where: { id: f.membership.id } })).not.toBeNull();
        expect(await db.accountChange.count({ where: { entityId: f.session.id } })).toBe(0);
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: f.member.id });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: new Uint8Array([1]) });
    });
});
