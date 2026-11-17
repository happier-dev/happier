import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createSessionPersonalAttentionProjectionSelect, loadSessionViewerProjection } from "./projection";
import { createSessionListScopeWhere, createSessionPersonalAttentionQueryInTx } from "./queries";

const authentication = createPresentUserSessionAccessAuthentication();

/**
 * UI list placement reads the batch-read row's `viewer.relevance.relevant` and
 * `viewer.attention.needsAttention` instead of re-querying a list. Those facts
 * must equal the server's own `my_work` scope and `needs_my_attention` admission.
 */
describe("viewer projection equals list membership (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "list-membership-parity-", initAuth: false,
            env: { HAPPIER_FEATURE_SHARING_SESSION__ENABLED: "true" } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("retires a canceled native approval with a retained summary from viewer attention and list membership", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const now = new Date();
        const { id: sessionId } = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}",
            active: true, lastActiveAt: now, latestTurnStatus: "in_progress",
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: now,
        } });
        const readAttention = async () => {
            const viewer = await loadSessionViewerProjection({ accountId: account.id, sessionId, authentication });
            const admitted = await inTx(async tx => {
                const query = createSessionPersonalAttentionQueryInTx(tx, { accountId: account.id });
                const rows = await tx.session.findMany({
                    where: { AND: [{ id: sessionId }, query.candidateWhere] },
                    select: createSessionPersonalAttentionProjectionSelect(account.id),
                });
                return (await query.admitRows(rows)).length > 0;
            });
            return { attention: viewer?.attention, admitted };
        };

        const pending = await readAttention();
        expect(pending.attention).toMatchObject({ needsAttention: true, primary: "permission_required" });
        expect(pending.admitted).toBe(true);

        // The publisher can disappear with a canceled turn and a retained native summary.
        await db.session.update({ where: { id: sessionId }, data: { active: false, latestTurnStatus: "cancelled" } });
        const canceled = await readAttention();
        expect(canceled.attention).toMatchObject({ needsAttention: false, reasons: [] });
        expect(canceled.admitted).toBe(false);

        // A shared Action confirmation has a separate settlement lifecycle.
        await db.session.update({ where: { id: sessionId }, data: { pendingSharedActionConfirmationCount: 1 } });
        const shared = await readAttention();
        expect(shared.attention).toMatchObject({ needsAttention: true, primary: "permission_required" });
        expect(shared.admitted).toBe(true);
        await db.session.update({ where: { id: sessionId }, data: { pendingSharedActionConfirmationCount: 0 } });
        expect(await readAttention()).toMatchObject({ attention: { needsAttention: false, reasons: [] }, admitted: false });
    });

    it("matches my_work and needs_my_attention for every relevance and attention case", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = async (ownerId: string, data: Record<string, unknown> = {}) =>
            await db.session.create({ data: { accountId: ownerId, tag: randomUUID(), metadata: "{}", ...data } });
        const share = async (sessionId: string) => await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: "edit",
        } });

        const ids: string[] = [];
        const add = async (ownerId: string, shareIt: boolean, data: Record<string, unknown> = {}) => {
            const created = await session(ownerId, data);
            if (shareIt) await share(created.id);
            ids.push(created.id);
            return created;
        };
        await add(viewer.id, false);
        await add(viewer.id, false, { seq: 5, pendingPermissionRequestCount: 1, active: true });
        await add(owner.id, true);
        await add(owner.id, true, { seq: 3, pendingUserActionRequestCount: 1, active: true });
        const assigned = await add(owner.id, true);
        await db.session.update({ where: { id: assigned.id }, data: { responsibleAccountId: viewer.id } });
        const followed = await add(owner.id, true);
        await db.accountSessionFollow.create({ data: { sessionId: followed.id, accountId: viewer.id, following: true,
            followPolicy: JSON.stringify({ preset: "important" }) } });
        const pinned = await add(owner.id, true);
        await db.sessionPin.create({ data: { sessionId: pinned.id, accountId: viewer.id } });
        const reminded = await add(owner.id, true);
        await db.sessionAttentionStanding.create({ data: { sessionId: reminded.id, accountId: viewer.id, standing: false,
            remindAt: new Date(Date.now() - 1_000) } });
        const standing = await add(owner.id, true);
        await db.sessionAttentionStanding.create({ data: { sessionId: standing.id, accountId: viewer.id, standing: true } });

        // Reachable only through a Team grant: readable, but no personal relevance.
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
        for (const data of [{}, { seq: 4, pendingPermissionRequestCount: 1, active: true }]) {
            const collective = await add(owner.id, false, data);
            await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: collective.id, teamId: team.id, accessLevel: "edit", effectiveAt: new Date() } });
        }

        const { myWork, attention, ordinary } = await inTx(async (tx) => {
            const accessWhere = await buildSessionAccessWhere({ tx, accountId: viewer.id, capability: "readTranscript",
                mode: "effective_access_v1", authentication });
            const myWorkRows = await tx.session.findMany({ where: { AND: [{ id: { in: ids } }, accessWhere,
                await createSessionListScopeWhere({ tx, accountId: viewer.id, scope: "my_work" })] }, select: { id: true } });
            const query = createSessionPersonalAttentionQueryInTx(tx, { accountId: viewer.id });
            const candidates = await tx.session.findMany({ where: { AND: [{ id: { in: ids } }, accessWhere, query.candidateWhere] },
                select: createSessionPersonalAttentionProjectionSelect(viewer.id) });
            const admitted = await query.admitRows(candidates);
            // The ordinary GET corpus (`listSessionsForAccount`) admits owner-or-direct readers.
            const ordinaryRows = await tx.session.findMany({ where: { AND: [{ id: { in: ids } },
                buildSessionAccessWhere({ accountId: viewer.id, capability: "readTranscript", mode: "legacy_owner_or_direct" })] },
                select: { id: true } });
            return { myWork: new Set(myWorkRows.map(row => row.id)), attention: new Set(admitted.map(row => row.id)),
                ordinary: new Set(ordinaryRows.map(row => row.id)) };
        });

        const projected = await Promise.all(ids.map(async (sessionId) => ({ sessionId,
            viewer: await loadSessionViewerProjection({ accountId: viewer.id, sessionId, authentication }) })));
        for (const { sessionId, viewer: projection } of projected) {
            expect(projection, sessionId).not.toBeNull();
            expect({ sessionId, myWork: projection!.relevance.relevant }).toEqual({ sessionId, myWork: myWork.has(sessionId) });
            expect({ sessionId, attention: projection!.attention.needsAttention })
                .toEqual({ sessionId, attention: attention.has(sessionId) });
            const ownerOrDirect = projection!.relevance.reasons.includes("owned_by_me")
                || projection!.relevance.reasons.includes("shared_directly_with_me");
            expect({ sessionId, ordinary: ownerOrDirect }).toEqual({ sessionId, ordinary: ordinary.has(sessionId) });
        }
        // The fixture must exercise both outcomes of both lenses.
        expect(attention.size).toBeGreaterThan(0);
        expect(attention.size).toBeLessThan(ids.length);
        expect(myWork.size).toBeGreaterThan(0);
        expect(myWork.size).toBeLessThan(ids.length);
    });
});
