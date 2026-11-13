import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { db } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    applySessionAccessAccountStatusImpactInTx,
    captureSessionAccessAccountStatusImpactInTx,
} from "./sessionAccessAccountStatusImpact";
import { resolveStructuralSessionAccess } from "./sessionAccess";

describe("Account-status Session access effects (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-status-session-impact-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 180_000);

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.sessionFollowEdge.deleteMany(),
            () => db.accountSessionFollow.deleteMany(),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'group' } }),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'team' } }),
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'account' } }),
            () => db.teamGroupMembership.deleteMany(),
            () => db.teamGroup.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    async function fixture() {
        const target = await db.account.create({ data: { encryptionMode: "plain" } });
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const unrelatedAccount = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Lifecycle ${crypto.randomUUID()}` } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: target.id, role: "member" },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Lifecycle group", nameKey: `lifecycle-${crypto.randomUUID()}` },
        });
        await db.teamGroupMembership.create({
            data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id },
        });

        const createSession = async (accountId: string, responsible = true) => await db.session.create({
            data: {
                accountId,
                tag: crypto.randomUUID(),
                metadata: "{}",
                encryptionMode: "plain",
                currentStorageState: "hosted",
                responsibleAccountId: responsible ? target.id : null,
            },
        });
        const owned = await createSession(target.id);
        const direct = await createSession(owner.id);
        const teamDerived = await createSession(owner.id);
        const groupDerived = await createSession(owner.id);
        const unrelated = await createSession(unrelatedAccount.id, false);
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: direct.id,
                createdByAccountId: owner.id,
                accountId: target.id,
                accessLevel: "view",
            },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'team',
                sessionId: teamDerived.id,
                teamId: team.id,
                accessLevel: "edit",
                effectiveAt: new Date(),
            },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'group',
                sessionId: groupDerived.id,
                teamGroupId: group.id,
                accessLevel: "view",
                effectiveAt: new Date(),
            },
        });

        const affected = [owned, direct, teamDerived, groupDerived];
        for (const session of affected) {
            const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
            if (!key) throw new Error("expected Session draft key");
            await db.userKVStore.create({
                data: { accountId: target.id, key, value: new Uint8Array([1]), version: 1 },
            });
            await db.accountSessionFollow.create({
                data: { accountId: target.id, sessionId: session.id, following: true, followPolicy: JSON.stringify({ preset: "important" }) },
            });
        }
        await db.sessionFollowEdge.create({
            data: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: teamDerived.id }), sourceSessionId: teamDerived.id,
                destinationSessionId: owned.id, policyJson: JSON.stringify({ preset: 'quiet' }) },
        });
        return { target, affected, unrelated, teamDerived, owned };
    }

    async function transitionAccountStatus(
        accountId: string,
        status: "active" | "suspended",
        options: Readonly<{ abort?: boolean }> = {},
    ) {
        return await inTx(async (tx) => {
            const impact = await captureSessionAccessAccountStatusImpactInTx(tx, { accountId });
            await tx.account.update({ where: { id: accountId }, data: { status } });
            const effects = await applySessionAccessAccountStatusImpactInTx(tx, { impact });
            if (options.abort) throw new Error("abort Account lifecycle transition");
            return effects;
        });
    }

    it("applies canonical loss effects to owned, direct, Team and Group-derived Sessions only", async () => {
        const f = await fixture();

        const effects = await transitionAccountStatus(f.target.id, "suspended");

        expect(effects.changedSessionIds).toEqual(f.affected.map(session => session.id).sort());
        expect(effects.revokedSessionIds).toEqual(f.affected.map(session => session.id).sort());
        expect(await db.accountSessionFollow.count({ where: { accountId: f.target.id } })).toBe(0);
        expect(await db.sessionFollowEdge.findUnique({ where: {
            destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: f.owned.id,
                sourceSessionId: f.teamDerived.id,
                relation: 'follower',
            },
        } })).toBeNull();
        expect(await db.session.count({ where: {
            id: { in: f.affected.map(session => session.id) },
            responsibleAccountId: f.target.id,
        } })).toBe(0);
        expect(await db.userKVStore.count({ where: {
            accountId: f.target.id,
            value: { not: null },
        } })).toBe(0);
        expect(await db.accountChange.count({ where: {
            accountId: f.target.id,
            kind: "session",
            entityId: { in: f.affected.map(session => session.id) },
        } })).toBe(f.affected.length);
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: f.target.id,
            kind: "session",
            entityId: f.unrelated.id,
        } } })).toBeNull();
    });

    it("rolls back the Account status and every canonical Session effect together", async () => {
        const f = await fixture();

        await expect(transitionAccountStatus(f.target.id, "suspended", { abort: true }))
            .rejects.toThrow("abort Account lifecycle transition");

        expect((await db.account.findUniqueOrThrow({ where: { id: f.target.id } })).status).toBe("active");
        expect(await db.accountSessionFollow.count({ where: { accountId: f.target.id } })).toBe(f.affected.length);
        expect(await db.sessionFollowEdge.count()).toBe(1);
        expect(await db.session.count({ where: {
            id: { in: f.affected.map(session => session.id) },
            responsibleAccountId: f.target.id,
        } })).toBe(f.affected.length);
        expect(await db.userKVStore.count({ where: {
            accountId: f.target.id,
            value: { not: null },
        } })).toBe(f.affected.length);
        expect(await db.accountChange.count({ where: { accountId: f.target.id, kind: "session" } })).toBe(0);
    });

    it("publishes retained access on reactivation without resurrecting personal state", async () => {
        const f = await fixture();
        await transitionAccountStatus(f.target.id, "suspended");
        const cursorsAfterLoss = new Map((await db.accountChange.findMany({
            where: { accountId: f.target.id, kind: "session" },
            select: { entityId: true, cursor: true },
        })).map(row => [row.entityId, row.cursor]));

        const effects = await transitionAccountStatus(f.target.id, "active");

        expect(effects.changedSessionIds).toEqual(f.affected.map(session => session.id).sort());
        expect(effects.grantedSessionIds).toEqual(f.affected.map(session => session.id).sort());
        for (const session of f.affected) {
            expect(await resolveStructuralSessionAccess(db, {
                accountId: f.target.id,
                sessionId: session.id,
            })).not.toBeNull();
            const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: f.target.id,
                kind: "session",
                entityId: session.id,
            } } });
            expect(change.cursor).toBeGreaterThan(cursorsAfterLoss.get(session.id)!);
        }
        expect(await db.accountSessionFollow.count({ where: { accountId: f.target.id } })).toBe(0);
        expect(await db.sessionFollowEdge.count()).toBe(0);
        expect(await db.session.count({ where: { responsibleAccountId: f.target.id } })).toBe(0);
        expect(await db.userKVStore.count({ where: { accountId: f.target.id, value: { not: null } } })).toBe(0);
    });
});
