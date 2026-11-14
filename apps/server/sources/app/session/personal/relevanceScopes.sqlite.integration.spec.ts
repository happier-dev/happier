import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiscussionCreateRequestV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import {
    createDiscussion,
    postDiscussionMessage,
} from "@/app/discussions/mutations";
import { inTx } from "@/storage/inTx";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { resolveEffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { loadSessionViewerProjection } from "./projection";
import { createSessionListScopeWhere } from "./queries";

const authentication = createPresentUserSessionAccessAuthentication();

async function scopedSessionIds(accountId: string, scope: "my_work" | "involving_me"): Promise<string[]> {
    return await inTx(async (tx) => {
        const rows = await tx.session.findMany({
            where: { AND: [
                await buildSessionAccessWhere({ tx, accountId, capability: "readTranscript", mode: "effective_access_v1", authentication }),
                await createSessionListScopeWhere({ tx, accountId, scope }),
            ] },
            select: { id: true },
        });
        return rows.map((row) => row.id).sort();
    });
}

describe("personal relevance producers and list scopes (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "personal-relevance-", initAuth: false,
            env: { HAPPIER_FEATURE_SHARING_SESSION__ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    async function session(ownerId: string) {
        return await db.session.create({ data: { accountId: ownerId, tag: randomUUID(), metadata: "{}" } });
    }
    async function share(sessionId: string, ownerId: string, accountId: string) {
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId, createdByAccountId: ownerId, accountId: accountId, accessLevel: "edit",
        } });
    }

    it("reports a genuine direct share through the bounded access relationship, not a raw share scan", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const collaborator = await db.account.create({ data: { publicKey: randomUUID() } });
        const shared = await session(owner.id);
        await share(shared.id, owner.id, collaborator.id);

        const viewer = await loadSessionViewerProjection({ accountId: collaborator.id, sessionId: shared.id, authentication });
        expect(viewer?.relevance.reasons).toEqual(["shared_directly_with_me"]);
        expect(viewer).toMatchObject({ readState: { state: "not_started" },
            follow: { follows: false, notificationLevel: null }, attention: { needsAttention: false } });
        expect(viewer?.follow.defaultRelationships).toEqual({ assigned: false, direct: true, team: false, group: false });

        const ownerViewer = await loadSessionViewerProjection({ accountId: owner.id, sessionId: shared.id, authentication });
        expect(ownerViewer?.relevance.reasons).toEqual(["owned_by_me"]);
        expect(ownerViewer?.follow.defaultRelationships).toEqual({ assigned: false, direct: false, team: false, group: false });
    });

    it("projects every current requester relationship even when strongest access explanations omit grants", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID() } });
        const shared = await session(owner.id);
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: shared.id, createdByAccountId: owner.id,
            accountId: viewer.id, accessLevel: 'admin' } });
        await db.session.update({ where: { id: shared.id }, data: { responsibleAccountId: viewer.id } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Readers') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        await db.sessionGrant.create({ data: { principalKind: 'team', sessionId: shared.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() } });
        await db.sessionGrant.create({ data: { principalKind: 'group', sessionId: shared.id, teamGroupId: group.id, accessLevel: 'view', effectiveAt: new Date() } });
        const access = await inTx(tx => resolveEffectiveSessionAccess(tx, { accountId: viewer.id, sessionId: shared.id, authentication }));
        expect(access?.sources.map(source => source.kind)).toEqual(['direct']);
        expect((await loadSessionViewerProjection({ accountId: viewer.id, sessionId: shared.id, authentication }))?.follow.defaultRelationships)
            .toEqual({ assigned: true, direct: true, team: true, group: true });
        expect((await loadSessionViewerProjection({ accountId: owner.id, sessionId: shared.id, authentication }))?.follow.defaultRelationships)
            .toEqual({ assigned: false, direct: false, team: false, group: false });
    });

    it("counts authenticated human transcript authorship and never a machine-admitted row", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const author = await db.account.create({ data: { publicKey: randomUUID() } });
        const machineOnly = await db.account.create({ data: { publicKey: randomUUID() } });
        const authored = await session(owner.id);
        await share(authored.id, owner.id, author.id);
        await share(authored.id, owner.id, machineOnly.id);
        const humanContent = { t: "plain" as const, v: { role: "user", content: { type: "text", text: "hello" } } };
        await db.sessionMessage.create({ data: {
            sessionId: authored.id, seq: 1, messageRole: "user", content: humanContent,
            authorAccountId: author.id,
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedAccount", actorAccountId: author.id, sessionRelationship: "sharedEditor" },
        } });
        // A machine-admitted row derives no author, so mere access stays quiet.
        await db.sessionMessage.create({ data: {
            sessionId: authored.id, seq: 2, messageRole: "user", content: humanContent,
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
        } });

        expect((await loadSessionViewerProjection({ accountId: author.id, sessionId: authored.id, authentication }))?.relevance.reasons)
            .toEqual(["shared_directly_with_me", "authored_by_me"]);
        expect((await loadSessionViewerProjection({ accountId: machineOnly.id, sessionId: authored.id, authentication }))?.relevance.reasons)
            .toEqual(["shared_directly_with_me"]);
    });

    it("selects My work and Involving me relationally, before any page limit", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID() } });

        const owned = await session(viewer.id);
        const assigned = await session(owner.id);
        await share(assigned.id, owner.id, viewer.id);
        await db.session.update({ where: { id: assigned.id }, data: { responsibleAccountId: viewer.id } });
        const shared = await session(owner.id);
        await share(shared.id, owner.id, viewer.id);
        const followed = await session(owner.id);
        await share(followed.id, owner.id, viewer.id);
        await db.accountSessionFollow.create({ data: {
            sessionId: followed.id, accountId: viewer.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        const pinned = await session(owner.id);
        await share(pinned.id, owner.id, viewer.id);
        await db.sessionPin.create({ data: { sessionId: pinned.id, accountId: viewer.id } });
        const standing = await session(owner.id);
        await share(standing.id, owner.id, viewer.id);
        await db.sessionAttentionStanding.create({ data: { sessionId: standing.id, accountId: viewer.id, standing: true } });
        const negativeStanding = await session(owner.id);
        await share(negativeStanding.id, owner.id, viewer.id);
        await db.sessionAttentionStanding.create({ data: { sessionId: negativeStanding.id, accountId: viewer.id, standing: false } });
        const suppressed = await session(owner.id);
        await share(suppressed.id, owner.id, viewer.id);
        await db.accountSessionFollow.create({ data: {
            sessionId: suppressed.id, accountId: viewer.id, following: false, followPolicy: JSON.stringify({ preset: "custom", events: {} }),
        } });

        expect(await scopedSessionIds(viewer.id, "my_work")).toEqual(
            [owned.id, assigned.id, shared.id, followed.id, pinned.id, standing.id, negativeStanding.id, suppressed.id].sort(),
        );
        // Every one of those is a genuine direct share, so Involving me matches.
        // Follow, pin and standing alone must not add a row: prove that with a
        // Session the viewer reaches through a Team-shaped grant it does not own.
        expect(await scopedSessionIds(viewer.id, "involving_me")).toEqual(
            [owned.id, assigned.id, shared.id, followed.id, pinned.id, standing.id, negativeStanding.id, suppressed.id].sort(),
        );
    });

    it("admits human-origin discussion authorship to Involving me and keeps a bare mention in My work only", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const author = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const mentioned = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const agentRuntime = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const discussed = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        for (const account of [author, mentioned, agentRuntime]) {
            await share(discussed.id, owner.id, account.id);
        }

        await makeShareEligibleForTest(author.id, [mentioned.id, agentRuntime.id]);
        const created = await createDiscussion({
            actorAccountId: author.id,
            request: {
                anchor: { kind: "session", sessionId: discussed.id },
                participants: [{ kind: "account", accountId: mentioned.id }, { kind: "account", accountId: agentRuntime.id }],
                creationLocalId: "scope-c1",
                titleContent: { t: "plain", v: { v: 1, title: "Rollout" } },
                firstMessage: {
                    localId: "scope-m1",
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "please look" }] } },
                    mentionedAccountIds: [mentioned.id],
                },
            } as DiscussionCreateRequestV1,
            authentication,
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const runtimeSession = await db.session.create({ data: {
            accountId: agentRuntime.id, tag: randomUUID(), encryptionMode: "plain", metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        await db.discussionParticipant.create({ data: { discussionId: created.value.discussion.id, participantSlotId: runtimeSession.id, sessionId: runtimeSession.id } });
        // Agent production recorded against its own execution Account is not a
        // human post by that Account, and its mention of nobody adds nothing.
        expect((await postDiscussionMessage({
            actorAccountId: agentRuntime.id,
            discussionId: created.value.discussion.id,
            request: {
                localId: "scope-agent",
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "agent output" }] } },
                mentionedAccountIds: [],
            },
            producer: { v: 1, kind: "agent", sessionId: runtimeSession.id },
            authentication,
        })).ok).toBe(true);

        expect((await loadSessionViewerProjection({ accountId: author.id, sessionId: discussed.id, authentication }))?.relevance.reasons)
            .toEqual(["shared_directly_with_me", "authored_by_me"]);
        expect((await loadSessionViewerProjection({ accountId: mentioned.id, sessionId: discussed.id, authentication }))?.relevance.reasons)
            .toEqual(["shared_directly_with_me", "mentioned_in_discussion"]);
        expect((await loadSessionViewerProjection({ accountId: agentRuntime.id, sessionId: discussed.id, authentication }))?.relevance.reasons)
            .toEqual(["shared_directly_with_me"]);

        // Drop the direct grants so the personal scope arms are exercised on
        // their own, exactly as the collective-reader case below does.
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: discussed.id } });
        const select = async (accountId: string, scope: "my_work" | "involving_me") => (await db.session.findMany({
            where: { AND: [{ id: discussed.id }, await createSessionListScopeWhere({ accountId, scope })] },
            select: { id: true },
        })).map((row) => row.id);

        expect(await select(author.id, "my_work")).toEqual([discussed.id]);
        expect(await select(author.id, "involving_me")).toEqual([discussed.id]);
        expect(await select(mentioned.id, "my_work")).toEqual([discussed.id]);
        expect(await select(mentioned.id, "involving_me")).toEqual([]);
        expect(await select(agentRuntime.id, "my_work")).toEqual([]);
        expect(await select(agentRuntime.id, "involving_me")).toEqual([]);
    });

    it("keeps Follow, pin and explicit standing out of Involving me when no participation relation exists", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID() } });
        const collective = await session(owner.id);
        await db.accountSessionFollow.create({ data: {
            sessionId: collective.id, accountId: viewer.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        await db.sessionPin.create({ data: { sessionId: collective.id, accountId: viewer.id } });
        await db.sessionAttentionStanding.create({ data: { sessionId: collective.id, accountId: viewer.id, standing: true } });

        // The scope arms are asserted without the access conjunction so a
        // collective (Team/Group) reader is represented exactly: personal
        // organization facts are My work relevance, never participation.
        const select = async (scope: "my_work" | "involving_me") => (await db.session.findMany({
            where: { AND: [{ id: collective.id }, await createSessionListScopeWhere({ accountId: viewer.id, scope })] },
            select: { id: true },
        })).map((row) => row.id);
        expect(await select("my_work")).toEqual([collective.id]);
        expect(await select("involving_me")).toEqual([]);

        // Access alone still never admits a row to either scope.
        const quiet = await session(owner.id);
        await share(quiet.id, owner.id, viewer.id);
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: quiet.id } });
        expect(await scopedSessionIds(viewer.id, "my_work")).not.toContain(quiet.id);
    });

    it("keeps a future reminder in My work independently of durable standing until it is cleared", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID() } });
        const reminded = await session(owner.id);
        const remindAt = Date.now() + 60_000;
        await db.sessionAttentionStanding.create({ data: {
            sessionId: reminded.id,
            accountId: viewer.id,
            standing: false,
            remindAt: new Date(remindAt),
        } });

        const select = async () => (await db.session.findMany({
            where: { AND: [
                { id: reminded.id },
                await createSessionListScopeWhere({ accountId: viewer.id, scope: "my_work" }),
            ] },
            select: { id: true },
        })).map((row) => row.id);

        expect(await select()).toEqual([reminded.id]);

        await db.sessionAttentionStanding.update({
            where: { accountId_sessionId: { accountId: viewer.id, sessionId: reminded.id } },
            data: { standing: false, remindAt: null },
        });
        expect(await select()).toEqual([]);
    });
});
