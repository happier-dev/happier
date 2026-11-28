import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscussionCreateRequestV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

import { createDiscussion, postDiscussionMessage } from "./mutations";
import { setDiscussionReadCursor } from "./readState";

const authentication = createPresentUserSessionAccessAuthentication();

/**
 * The Expo push transport is the one genuine boundary here. Everything beneath
 * it — the tracked-relation candidate query, the personal attention predicate
 * and the badge count — runs for real against SQLite, because those are exactly
 * the decisions this contract is about.
 */
const badgePushes = vi.hoisted(() => [] as { accountId: string; badge: number | undefined; type: unknown }[]);
vi.mock("expo-server-sdk", async (importOriginal) => {
    const { Expo } = await importOriginal<typeof import("expo-server-sdk")>();
    return {
        Expo: class extends Expo {
            override async sendPushNotificationsAsync(messages: import("expo-server-sdk").ExpoPushMessage[]) {
                return messages.map((message) => {
                    badgePushes.push({
                        accountId: String(message.to).slice("ExponentPushToken[".length, -1),
                        badge: message.badge,
                        type: message.data?.type,
                    });
                    return { status: "ok" as const, id: "discussion-test-ticket" };
                });
            }
        },
    };
});

/** The refresh is coalesced on a 25 ms timer, so settle before asserting. */
async function settledBadgePushes(): Promise<Map<string, number | undefined>> {
    const deadline = Date.now() + 5_000;
    while (badgePushes.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Map(badgePushes.map((push) => [push.accountId, push.badge]));
}

const plainTitle = (title: string) => ({ t: "plain" as const, v: { v: 1, title } });
const plainBody = (text: string) => ({ t: "plain" as const, v: { v: 1, parts: [{ t: "text", text }] } });

describe("Discussion grants control Account badge facts (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "discussion-badge-refresh-", initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    beforeEach(() => { badgePushes.length = 0; });

    async function fixture() {
        const account = async () => await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const owner = await account();
        const follower = await account();
        const browser = await account();
        await makeShareEligibleForTest(owner.id, [follower.id, browser.id]);
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        } });
        for (const reader of [follower, browser]) {
            await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: reader.id, accessLevel: "edit",
            } });
            await db.accountPushToken.create({ data: {
                accountId: reader.id, token: `ExponentPushToken[${reader.id}]`,
            } });
        }
        await db.accountPushToken.create({ data: {
            accountId: owner.id, token: `ExponentPushToken[${owner.id}]`,
        } });
        // Tracking is owner-or-active-Follow with an established Lane 09B
        // baseline. `browser` has the same access and no Follow, so it is the
        // control for "broad access is never badge fanout".
        await db.accountSessionFollow.create({ data: {
            sessionId: session.id, accountId: follower.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        for (const tracked of [owner, follower]) {
            await db.accountSessionReadState.create({ data: {
                sessionId: session.id, accountId: tracked.id, lastViewedSessionSeq: 0,
            } });
        }
        return { owner, follower, browser, session };
    }

    it.each(["anchored", "standalone"])("schedules a badge refresh when a %s discussion message lands", async (kind) => {
        const { owner, follower, browser, session } = await fixture();

        const created = await createDiscussion({
            actorAccountId: owner.id,
            request: {
                ...(kind === "anchored" ? { anchor: { kind: "session", sessionId: session.id } } : {}),
                participants: [{ kind: "account", accountId: follower.id }],
                creationLocalId: "badge-c1",
                titleContent: plainTitle("Rollout"),
                firstMessage: { localId: "badge-m1", content: plainBody("please look"), mentionedAccountIds: [] },
            } as DiscussionCreateRequestV1,
            authentication,
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const afterCreate = await settledBadgePushes();
        // The follower's private discussion baseline started at zero, so the
        // first message is genuinely unread for exactly that Account.
        expect(afterCreate.get(follower.id)).toBe(1);
        // The author's own post is never news to its author.
        expect(afterCreate.get(owner.id)).toBe(0);
        expect(afterCreate.has(browser.id)).toBe(false);

        badgePushes.length = 0;
        expect((await setDiscussionReadCursor({
            actorAccountId: follower.id,
            discussionId: created.value.discussion.id,
            lastReadSeq: 1,
            authentication,
        })).ok).toBe(true);
        expect((await settledBadgePushes()).get(follower.id)).toBe(0);

        badgePushes.length = 0;
        expect((await postDiscussionMessage({
            actorAccountId: owner.id,
            discussionId: created.value.discussion.id,
            request: { localId: "badge-m2", content: plainBody("and this"), mentionedAccountIds: [follower.id] },
            authentication,
        })).ok).toBe(true);

        const afterPost = await settledBadgePushes();
        expect(afterPost.get(follower.id)).toBe(1);
        expect(afterPost.has(browser.id)).toBe(false);
    });

    it.each(["anchored", "standalone"])("refreshes only the acting Account's badge when its private %s discussion cursor advances", async (kind) => {
        const { owner, follower, session } = await fixture();
        const created = await createDiscussion({
            actorAccountId: owner.id,
            request: {
                ...(kind === "anchored" ? { anchor: { kind: "session", sessionId: session.id } } : {}),
                participants: [{ kind: "account", accountId: follower.id }],
                creationLocalId: "badge-c2",
                titleContent: plainTitle("Cursor"),
                firstMessage: { localId: "badge-m3", content: plainBody("look"), mentionedAccountIds: [] },
            } as DiscussionCreateRequestV1,
            authentication,
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        // The creating write schedules its own tracked-Account refresh on the
        // shared coalescing timer. Settle it before clearing, otherwise that
        // fanout arrives afterwards and is misread as the cursor advance's.
        await settledBadgePushes();
        badgePushes.length = 0;
        expect((await setDiscussionReadCursor({
            actorAccountId: follower.id,
            discussionId: created.value.discussion.id,
            lastReadSeq: 1,
            authentication,
        })).ok).toBe(true);

        const settled = await settledBadgePushes();
        expect([...settled.keys()]).toEqual([follower.id]);
        expect(settled.get(follower.id)).toBe(0);
        const change = await db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: follower.id, kind: 'discussion', entityId: created.value.discussion.id } },
            select: { hint: true },
        });
        // A private cursor never erases the pending first-message invalidation.
        expect(change.hint).toEqual({ v: 1, discussions: true, changes: { resource: true, readState: true } });
    });
});
