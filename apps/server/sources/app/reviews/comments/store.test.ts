import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import {
    buildReviewCommentEventRequestBindingV1,
    buildReviewCommentMutationEventEnvelopeV1,
    openReviewCommentSensitiveMigrationSourceV1,
    sealReviewCommentSensitiveEnvelopeV1,
    signAccountContentKeyBindingV1,
    splitReviewCommentV1,
    type ReviewCommentV1,
} from "@happier-dev/protocol";

import { createDbTransactionMock, inTxPostgresControlStatementMock, installDbModuleMock } from "@/app/api/testkit/dbMocks";

const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const contentKey = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(18));
const binding = {
    publicKey: Buffer.from(signing.publicKey).toString("hex"),
    contentPublicKey: contentKey.publicKey,
    contentPublicKeySig: signAccountContentKeyBindingV1({
        accountSigningSecretKey: signing.secretKey, contentPublicKey: contentKey.publicKey,
    }),
};
const currentAccount = { ...binding, encryptionMode: "e2ee", seq: 2, settings: null, settingsVersion: 0 };
// Only the persistent database adapter is substituted. Transaction, fence,
// Account admission, record/event encoding, and client opening remain real.
const tx = {
    ...inTxPostgresControlStatementMock,
    account: { findUnique: vi.fn(async () => currentAccount) },
    reviewComment: { create: vi.fn(async () => ({})) },
    $queryRawUnsafe: vi.fn(async () => [{ id: "account-1" }]),
    $queryRaw: vi.fn(async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
        "raw" in query ? await inTxPostgresControlStatementMock.$queryRaw(query, ...values) : []),
    $executeRaw: vi.fn(async () => 1),
};
const transactions = createDbTransactionMock(() => tx);
installDbModuleMock(() => ({ db: transactions.wrapDb(tx) }));
const { createSqlReviewCommentStore } = await import("./store");
const { deriveAccountEncryptionCurrentnessFromRow } = await import("@/app/encryption/accountContentKeyAdmission");

function mutation(mode: "plain" | "e2ee") {
    const actor = { kind: "user", userId: "account-1" } as const;
    const input = { projectId: "project-1", anchor: { kind: "run", runId: "run-1" } as const,
        snapshot: { kind: "none", capturedAt: 1 } as const, body: "Private finding", clientMutationId: "mutation-1" };
    const { clientMutationId, ...content } = input;
    const comment: ReviewCommentV1 = { v: 1, id: "comment-1", accountId: "account-1", ...content,
        bodyVersion: 1, author: actor, state: "proposed", flags: {}, dispositions: {}, edits: [],
        transitions: [], threadId: "comment-1", createdAt: 1, updatedAt: 1, serverRevision: 1 };
    const split = splitReviewCommentV1(comment);
    const crypto = mode === "plain" ? { mode } as const : { mode, material: {
        type: "dataKey", machineKey: new Uint8Array(32).fill(18),
    }, randomBytes } as const;
    const currentness = deriveAccountEncryptionCurrentnessFromRow({ ...currentAccount, encryptionMode: mode });
    if (currentness.status !== "ready") throw new Error("Invalid Account fixture");
    return { accountId: "account-1", storageMode: mode, accountVersion: 1,
        accountEncryptionCurrentness: currentness.currentness,
        comment: split.structural, sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, ...crypto }),
        event: { eventId: "event-1", commentId: comment.id, accountId: comment.accountId, projectId: input.projectId,
            eventKind: "created" as const, actor, createdAt: 1, serverRevision: 1, event: { clientMutationId } },
        eventEnvelope: buildReviewCommentMutationEventEnvelopeV1({ accountId: comment.accountId, actor,
            actionId: "reviews.comments.create", input, ...crypto }),
        requestBinding: buildReviewCommentEventRequestBindingV1({ accountId: comment.accountId,
            projectId: input.projectId, actor, actionId: "reviews.comments.create", input }),
        createClientMutationId: clientMutationId, createRequestFingerprint: "request-1" };
}

afterEach(() => {
    currentAccount.encryptionMode = "e2ee";
    currentAccount.contentPublicKey = binding.contentPublicKey;
    currentAccount.contentPublicKeySig = binding.contentPublicKeySig;
    vi.clearAllMocks();
});

describe("Review Comment SQL write currentness", () => {
    it('requests only a structural SQL candidate window with one lookahead row', async () => {
        await createSqlReviewCommentStore().listSources({ accountId: 'account-1', filters: {
            projectId: 'project-1', states: [], taxonomyIds: [], includeHistory: true, limit: 2,
        } });
        const query = tx.$queryRaw.mock.calls.at(-1)?.[0];
        if (!query || 'raw' in query) throw new Error('Missing comment SQL request');
        // SQL is the persistent-system boundary: the database must own the page window.
        expect(query.sql).toMatch(/LIMIT\s+\?/);
        expect(query.values.at(-1)).toBe(3);
    });

    it('restricts selected finding identities in the scoped SQL candidate window', async () => {
        await createSqlReviewCommentStore().listSources({ accountId: 'account-1', filters: {
            projectId: 'project-1', commentIds: ['selected-1', 'selected-2'], states: [], taxonomyIds: [], includeHistory: true, limit: 2,
        } });
        const query = tx.$queryRaw.mock.calls.at(-1)?.[0];
        if (!query || 'raw' in query) throw new Error('Missing comment SQL request');
        expect(query.sql).toMatch(/id IN \(\?,\?\)/);
        expect(query.values).toEqual(expect.arrayContaining(['selected-1', 'selected-2']));
        expect(query.values).toContain('account-1');
    });

    it.each(["plain", "e2ee"] as const)("admits %s content after an unrelated Account cursor advance", async (mode) => {
        currentAccount.encryptionMode = mode;
        const input = mutation(mode);
        const result = await createSqlReviewCommentStore().createCanonical(input);
        const opened = await openReviewCommentSensitiveMigrationSourceV1({ ...result.comment,
            ...(mode === "e2ee" ? { material: { type: "dataKey", machineKey: new Uint8Array(32).fill(18) } as const } : {}) });
        expect(result.replayed).toBe(false);
        expect(opened).toMatchObject({ status: "available", comment: { id: "comment-1", body: "Private finding" } });
    });

    it.each(["mode", "key"] as const)("refuses changed Account %s before persistence", async (change) => {
        const input = { ...mutation("e2ee"), accountVersion: currentAccount.seq };
        if (change === "mode") currentAccount.encryptionMode = "plain";
        else {
            const replacement = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(19));
            currentAccount.contentPublicKey = replacement.publicKey;
            currentAccount.contentPublicKeySig = signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: replacement.publicKey,
            });
        }
        await expect(createSqlReviewCommentStore().createCanonical(input)).rejects.toMatchObject({ code: "review_comment_encryption_mode_mismatch" });
        expect(tx.reviewComment.create).not.toHaveBeenCalled();
        expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
});
