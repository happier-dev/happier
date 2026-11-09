import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { backgroundDeliveryAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createDiscussion, postDiscussionMessage } from "@/app/discussions/mutations";
import { removeDiscussionParticipant } from "@/app/discussions/accessService";
import { setDiscussionReadCursor } from "@/app/discussions/readState";

import {
    computeAccountActivityBadgeCounts,
    computeAccountActivityBadgeCountsInTx,
    computeAuthenticatedAccountActivityBadgeCount,
} from "./accountActivityBadge";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';

describe("Account activity badge admission (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "activity-badge-", initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => vi.unstubAllEnvs());

    it.each(["standalone", "tracked_anchor", "inaccessible_anchor", "deleted_anchor"] as const)(
        "counts a tracked Discussion once with a %s and clears on read or revocation",
        async (anchorKind) => {
            const authentication = createPresentUserSessionAccessAuthentication();
            const [owner, reader, outsider] = await Promise.all(Array.from({ length: 3 }, () =>
                db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
            const session = anchorKind === "standalone" ? null : await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            if (session && anchorKind === "tracked_anchor") {
                await db.sessionShare.create({ data: {
                    sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: "view",
                } });
                await db.accountSessionFollow.create({ data: {
                    sessionId: session.id, accountId: reader.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
                } });
                await db.accountSessionReadState.create({ data: {
                    sessionId: session.id, accountId: reader.id, lastViewedSessionSeq: 0,
                } });
            }
            await makeShareEligibleForTest(owner.id, [reader.id]);
            const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
                ...(session ? { anchor: { kind: "session", sessionId: session.id } as const } : {}),
                participants: [{ kind: "account", accountId: reader.id }],
                creationLocalId: randomUUID(), titleContent: { t: "plain", v: { v: 1, title: "Badge" } },
                firstMessage: { localId: randomUUID(), content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Baseline" }] } }, mentionedAccountIds: [] },
            } });
            expect(created.ok).toBe(true);
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            expect(await setDiscussionReadCursor({ actorAccountId: reader.id, discussionId, lastReadSeq: 1, authentication }))
                .toMatchObject({ ok: true });
            if (session && anchorKind === "deleted_anchor") await db.session.delete({ where: { id: session.id } });
            const counts = () => computeAccountActivityBadgeCounts([owner.id, reader.id, outsider.id]);
            expect(await counts()).toEqual(new Map([[owner.id, 0], [reader.id, 0], [outsider.id, 0]]));

            const postMention = () => postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication, request: {
                localId: randomUUID(), mentionedAccountIds: [reader.id],
                content: { t: "plain", v: { v: 1, parts: [
                    { t: "mention", participant: { kind: "account", accountId: reader.id } },
                    { t: "text", text: "Please review" },
                ] } },
            } });
            expect(await postMention()).toMatchObject({ ok: true });
            // A live tracked anchor already contributes one Session. The same
            // Discussion must not add a second badge entry through its own facts.
            expect(await counts()).toEqual(new Map([[owner.id, 0], [reader.id, 1], [outsider.id, 0]]));
            expect(await computeAuthenticatedAccountActivityBadgeCount(reader.id, authentication)).toBe(1);
            expect(await setDiscussionReadCursor({ actorAccountId: reader.id, discussionId, lastReadSeq: 2, authentication }))
                .toMatchObject({ ok: true });
            expect((await counts()).get(reader.id)).toBe(0);
            expect(await postMention()).toMatchObject({ ok: true });
            expect((await counts()).get(reader.id)).toBe(1);
            // Broad access without an established Discussion cursor is quiet;
            // neither ownership of its anchor nor a mention replays history.
            await db.discussionReadState.delete({ where: { discussionId_accountId: { discussionId, accountId: reader.id } } });
            expect((await counts()).get(reader.id)).toBe(0);
            await db.discussionReadState.create({ data: { discussionId, accountId: reader.id, lastReadSeq: 2 } });
            expect((await counts()).get(reader.id)).toBe(1);
            expect(await removeDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
                request: { participant: { kind: "account", accountId: reader.id } } })).toMatchObject({ ok: true });
            expect((await counts()).get(reader.id)).toBe(0);
        },
    );

    /**
     * The background badge count is produced with no request credential, so it
     * admits a restricted Team only when that Team currently qualifies without
     * evidence. Owner and inherited (unrestricted) Team arms keep contributing,
     * and the background answer matches the request-bound one for the same
     * recipient because both read the one access owner.
     */
    it("contributes a restricted-Team session only for a currently qualified recipient", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const restrictedFollower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const inheritFollower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const restrictedTeam = await db.team.create({ data: {
            name: `badge-restricted-${randomUUID()}`,
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "github" }] },
        } });
        const inheritTeam = await db.team.create({ data: { name: `badge-inherit-${randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: restrictedTeam.id, accountId: restrictedFollower.id, role: "member" as const },
            { teamId: inheritTeam.id, accountId: inheritFollower.id, role: "member" as const },
        ] });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            seq: 4,
            pendingBlockedCount: 1,
        } });
        await db.sessionTeamGrant.createMany({ data: [restrictedTeam, inheritTeam].map(team => ({
            sessionId: session.id, teamId: team.id, accessLevel: "view" as const, effectiveAt: new Date(0),
        })) });
        await db.accountSessionFollow.createMany({ data: [restrictedFollower, inheritFollower].map(account => ({
            sessionId: session.id, accountId: account.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        })) });
        // A `view` grant cannot act on the blocked count, so the followers'
        // attention is their own unread frontier; the owner's is the block.
        await db.accountSessionReadState.createMany({ data: [restrictedFollower, inheritFollower].map(account => ({
            sessionId: session.id, accountId: account.id, lastViewedSessionSeq: 0,
        })) });

        expect(await computeAccountActivityBadgeCounts([owner.id, inheritFollower.id, restrictedFollower.id]))
            .toEqual(new Map([
                [owner.id, 1],
                [inheritFollower.id, 1],
                [restrictedFollower.id, 0],
            ]));
        expect(await computeAuthenticatedAccountActivityBadgeCount(
            restrictedFollower.id,
            createPresentUserSessionAccessAuthentication(),
        )).toBe(0);
        expect(await computeAuthenticatedAccountActivityBadgeCount(
            inheritFollower.id,
            createPresentUserSessionAccessAuthentication(),
        )).toBe(1);
    });

    /**
     * One badge-refresh batch is one credential context — none — so the
     * memberships behind every recipient's admission are read once for the
     * batch, not once per Account inside the transaction.
     */
    it("reads Team memberships once for a batch of recipients", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const followers = await Promise.all([0, 1, 2].map(() =>
            db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const team = await db.team.create({ data: { name: `badge-batch-${randomUUID()}` } });
        await db.teamMembership.createMany({ data: followers.map(account => ({
            teamId: team.id, accountId: account.id, role: "member" as const,
        })) });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", seq: 4,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(0),
        } });
        await db.accountSessionFollow.createMany({ data: followers.map(account => ({
            sessionId: session.id, accountId: account.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        })) });
        await db.accountSessionReadState.createMany({ data: followers.map(account => ({
            sessionId: session.id, accountId: account.id, lastViewedSessionSeq: 0,
        })) });

        const counts = await inTx(async (tx) => {
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
            const resolved = await computeAccountActivityBadgeCountsInTx(
                reader,
                [owner.id, ...followers.map(account => account.id)],
                backgroundDeliveryAuthentication(),
            );
            expect(membershipReads).toBe(1);
            return resolved;
        });
        expect(counts).toEqual(new Map([
            [owner.id, 0],
            ...followers.map(account => [account.id, 1] as const),
        ]));
    });
});
