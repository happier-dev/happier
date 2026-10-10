import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionDiscussionCreateRequestV1 } from "@happier-dev/protocol";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, initDbMysql, initDbPostgres, requireDbProviderFromEnv, shutdownDbClient } from "@/storage/db";

import { createSessionDiscussion, postSessionDiscussionMessage } from "./mutations";

const authentication = createPresentUserSessionAccessAuthentication();

describe("Session discussion provider contract", () => {
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("The disposable DB-contract DATABASE_URL is required");
        const provider = requireDbProviderFromEnv(process.env, "postgres");
        if (provider === "mysql") await initDbMysql();
        else if (provider === "postgres") initDbPostgres();
        else throw new Error("This DB-contract lane requires postgres or mysql; SQLite has its own integration suite");
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await shutdownDbClient();
    });

    it("allocates concurrent sequences and enforces Account and Session lifecycle constraints", async () => {
        const owner = await db.account.create({
            data: { publicKey: `discussion-contract-owner-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const author = await db.account.create({
            data: { publicKey: `discussion-contract-author-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `discussion-contract-${randomUUID()}`,
                encryptionMode: "plain",
                metadata: "{}",
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: author.id,
                accessLevel: "edit",
            },
        });

        try {
            const createRequest = {
                creationLocalId: `create-${randomUUID()}`,
                titleContent: { t: "plain", v: { v: 1, title: "Provider contract" } },
                firstMessage: {
                    localId: `message-${randomUUID()}`,
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "First" }] } },
                    mentionedAccountIds: [author.id],
                },
            } satisfies SessionDiscussionCreateRequestV1;
            const created = await createSessionDiscussion({
                authentication,
                actorAccountId: owner.id,
                sessionId: session.id,
                request: createRequest,
            });
            expect(created.ok).toBe(true);
            if (!created.ok) return;

            const posts = await Promise.all(["second", "third"].map(async (text) => postSessionDiscussionMessage({
                authentication,
                actorAccountId: author.id,
                sessionId: session.id,
                discussionId: created.value.discussion.id,
                request: {
                    localId: `${text}-${randomUUID()}`,
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text }] } },
                    mentionedAccountIds: [],
                },
            })));
            expect(posts.every((post) => post.ok)).toBe(true);
            expect((await db.sessionDiscussionMessage.findMany({
                where: { discussionId: created.value.discussion.id },
                orderBy: { seq: "asc" },
                select: { seq: true },
            })).map((row) => row.seq)).toEqual([1, 2, 3]);
            expect(await db.sessionDiscussionMessageMention.count({
                where: {
                    accountId: author.id,
                    message: { discussionId: created.value.discussion.id },
                },
            })).toBe(1);

            await db.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: author.id } });
            await db.account.delete({ where: { id: author.id } });
            expect(await db.sessionDiscussionMessage.count({
                where: { discussionId: created.value.discussion.id, authorAccountId: null },
            })).toBe(2);
            expect(await db.sessionDiscussionMessageMention.count({
                where: { message: { discussionId: created.value.discussion.id } },
            })).toBe(0);
            await db.session.delete({ where: { id: session.id } });
            expect(await db.sessionDiscussion.count({ where: { id: created.value.discussion.id } })).toBe(0);
            expect(await db.sessionDiscussionMessage.count({
                where: { discussionId: created.value.discussion.id },
            })).toBe(0);
        } finally {
            await db.session.deleteMany({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, author.id] } } });
        }
    });
});
