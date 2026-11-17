import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from './mutations';

import {
    isDiscussionCreationIdentityConflict,
    reconcileDiscussionCreationIdentityRace,
} from "./createIdentityReconciliation";

// Prisma 7 names the violated constraint in the driver cause: SQLite lists its fields,
// PostgreSQL (and MySQL) name its index.
const uniqueViolation = (constraint: { fields: string[] } | { index: string }) => ({
    code: "P2002",
    meta: { modelName: "Discussion", driverAdapterError: { name: "DriverAdapterError", cause: {
        kind: "UniqueConstraintViolation", originalCode: "fields" in constraint ? "2067" : "23505", constraint,
    } } },
});
const createIdentityFieldsError = () => uniqueViolation({ fields: ["createdByAccountId", "creationLocalId"] });

describe('Home Discussion creation identity', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-home-identity-', initAuth: false }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    it('creates without a Session and reconciles the same creator retry', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const request = {
            creationLocalId: crypto.randomUUID(),
            titleContent: { t: 'plain' as const, v: { v: 1, title: 'Independent' } },
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Hello' }] } }, mentionedAccountIds: [] },
        };
        const input = { actorAccountId: owner.id, authentication: createPresentUserSessionAccessAuthentication(), request };
        const first = await createDiscussion(input);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const retry = await createDiscussion(input);
        expect(retry).toMatchObject({ ok: true, value: { discussion: { id: first.value.discussion.id }, firstMessage: { id: first.value.firstMessage.id } } });
        const concurrentInput = { ...input, request: { ...request, creationLocalId: crypto.randomUUID(), firstMessage: { ...request.firstMessage, localId: crypto.randomUUID() } } };
        const concurrent = await Promise.all([createDiscussion(concurrentInput), createDiscussion(concurrentInput)]);
        expect(concurrent.every(result => result.ok)).toBe(true);
        expect(new Set(concurrent.flatMap(result => result.ok ? [result.value.discussion.id] : [])).size).toBe(1);
    });
});

describe("Discussion create identity reconciliation", () => {
    it("reruns the complete operation once for a field-list creation-identity P2002", async () => {
        let attempts = 0;
        const result = await reconcileDiscussionCreationIdentityRace(async () => {
            attempts += 1;
            if (attempts === 1) throw createIdentityFieldsError();
            return { ok: false as const, error: "discussion_idempotency_conflict" as const };
        });

        expect(result).toEqual({ ok: false, error: "discussion_idempotency_conflict" });
        expect(attempts).toBe(2);
    });

    it("recognizes the creation identity's constraint-name P2002 target", () => {
        expect(isDiscussionCreationIdentityConflict(uniqueViolation({ index: "Discussion_createdByAccountId_creationLocalId_key" })))
            .toBe(true);
    });

    it("does not retry unrelated or ambiguous unique failures", async () => {
        const errors = [
            uniqueViolation({ fields: ["discussionId", "localId"] }),
            uniqueViolation({ fields: ["discussionId", "seq"] }),
            uniqueViolation({ index: "DiscussionMessage_discussionId_seq_key" }),
            { code: "P2002", meta: {} },
            { ...uniqueViolation({ fields: ["createdByAccountId", "creationLocalId"] }), meta: {
                ...uniqueViolation({ fields: ["createdByAccountId", "creationLocalId"] }).meta, modelName: "OtherModel" } },
            { ...uniqueViolation({ fields: ["createdByAccountId", "creationLocalId"] }), code: "P2003" },
        ];

        for (const error of errors) {
            let attempts = 0;
            await expect(reconcileDiscussionCreationIdentityRace(async () => {
                attempts += 1;
                throw error;
            })).rejects.toBe(error);
            expect(attempts).toBe(1);
        }
    });

    it("bounds an exact identity-conflict retry to one", async () => {
        const error = createIdentityFieldsError();
        let attempts = 0;

        await expect(reconcileDiscussionCreationIdentityRace(async () => {
            attempts += 1;
            throw error;
        })).rejects.toBe(error);
        expect(attempts).toBe(2);
    });
});
