import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionExternalShareableMessagesPageV1Schema } from "@happier-dev/protocol/sessions/messages/sessionMessagesPageV1";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionMessageRoutes } from "@/app/api/routes/session/registerSessionMessageRoutes";
import { backfillSessionTurnTranscriptAnchorProjectionPage, ensureSessionTurnTranscriptAnchorProjection } from "./sessionTurnTranscriptAnchorProjectionBackfill";

describe("automatic Session turn transcript-anchor conversion", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-turn-anchor-demand-",
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("prepares only the admitted Session when its first projected read needs predecessor anchors", async () => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const otherAccount = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const createSession = (accountId: string) => db.session.create({ data: {
            accountId, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", seq: 2,
        } });
        const requested = await createSession(account.id);
        const unrelated = await createSession(otherAccount.id);
        for (const session of [requested, unrelated]) {
            await db.sessionTurn.create({ data: {
                sessionId: session.id, turnId: "lazy-turn", status: "completed", startedAt: 1n, updatedAt: 2n,
                transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1],
                    startSeqInclusive: 1, endSeqInclusive: 2, finalAssistantMessageSeq: 2 }),
            } });
            await db.sessionMessage.createMany({ data: [1, 2].map(seq => ({
                sessionId: session.id, seq, messageRole: seq === 1 ? "user" : "agent",
                content: { t: "plain", v: { role: seq === 1 ? "user" : "agent", content: { type: "text", text: "message" } } },
                ...(seq === 1 ? { inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" } } : {}),
            })) });
        }
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v1/sessions/${requested.id}/messages?afterSeq=0&projection=externalShareableV1`;
            const denied = await app.inject({ method: "GET", url, headers: { "x-test-user-id": otherAccount.id } });
            expect(denied.statusCode).toBe(404);
            expect(await db.sessionTurn.count({ where: { transcriptAnchorProjectionVersion: 1,
                sessionId: { in: [requested.id, unrelated.id] } } })).toBe(0);
            const read = await app.inject({ method: "GET", url, headers: {
                "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4",
            } });
            expect(read.statusCode).toBe(200);
            expect(SessionExternalShareableMessagesPageV1Schema.parse(read.json())).toMatchObject({ hasMore: false,
                externalShareableSnapshot: { turns: [expect.objectContaining({ turnId: "lazy-turn" })] } });
            expect(await db.sessionTurn.count({ where: { sessionId: requested.id, transcriptAnchorProjectionVersion: 1 } })).toBe(1);
            expect(await db.sessionTurn.count({ where: { sessionId: unrelated.id, transcriptAnchorProjectionVersion: 1 } })).toBe(0);
        });
    });

    it.each([1, 0])("projects v%s turns on demand without operator state", async (version) => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", seq: 2,
        } });
        const turn = await db.sessionTurn.create({ data: {
            sessionId: session.id, turnId: "completed-turn", status: "completed",
            startedAt: 1n, updatedAt: 2n, terminalAt: 2n,
            transcriptAnchorsJson: JSON.stringify({
                startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
                endSeqInclusive: 2, finalAssistantMessageSeq: 2,
            }),
            transcriptAnchorProjectionVersion: version,
            ...(version === 1 ? { transcriptAnchorMinSeq: 1, transcriptAnchorMaxSeq: 2 } : {}),
        } });
        await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 1, messageRole: "user",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "question" } } },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
        } });
        await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 2, messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "answer" } } },
        } });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const read = async () => {
                const response = await app.inject({ method: "GET",
                    url: `/v1/sessions/${session.id}/messages?afterSeq=0&projection=externalShareableV1`,
                    headers: { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" },
                });
                expect(response.statusCode).toBe(200);
                return SessionExternalShareableMessagesPageV1Schema.parse(response.json());
            };
            // The lane brief replaces startup conversion with admitted on-demand preparation.
            const projected = await read();
            expect(await db.sessionTurn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({
                transcriptAnchorProjectionVersion: 1, transcriptAnchorMinSeq: 1, transcriptAnchorMaxSeq: 2,
            });
            expect(projected).toMatchObject({ hasMore: false,
                externalShareableSnapshot: { turns: [expect.objectContaining({ turnId: "completed-turn", status: "completed" })] } });
            expect(projected.externalShareableSnapshot).not.toHaveProperty("turnSettlementBlockedFromSeq");
            // Repeated preparation is idempotent and does not require a marker.
            await ensureSessionTurnTranscriptAnchorProjection(session.id);
            expect(await read()).toEqual(projected);
            // A predecessor row introduced later is prepared by the next admitted read.
            await db.sessionTurn.update({ where: { id: turn.id }, data: {
                transcriptAnchorProjectionVersion: 0, transcriptAnchorMinSeq: null, transcriptAnchorMaxSeq: null,
            } });
            expect(await read()).toEqual(projected);
        });
    });

    it("resumes committed page conversion and drains beyond one page without a manual cursor", async () => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.sessionTurn.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
            id: `automatic-anchor-${String(index).padStart(3, "0")}`,
            sessionId: session.id, turnId: `turn-${index}`, status: "completed", startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 2 }),
        })) });
        await inTx(tx => backfillSessionTurnTranscriptAnchorProjectionPage({ db: tx, sessionId: session.id, limit: 1 }));
        expect(await db.sessionTurn.count({ where: { sessionId: session.id, transcriptAnchorProjectionVersion: 1 } })).toBe(1);
        const controller = new AbortController();
        const interrupted = new Error("preparation interrupted");
        controller.abort(interrupted);
        await expect(ensureSessionTurnTranscriptAnchorProjection(session.id, controller.signal)).rejects.toBe(interrupted);
        expect(await db.sessionTurn.count({ where: { sessionId: session.id, transcriptAnchorProjectionVersion: 1 } })).toBe(1);
        await ensureSessionTurnTranscriptAnchorProjection(session.id);
        expect(await db.sessionTurn.count({ where: {
            sessionId: session.id, transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 1, transcriptAnchorMaxSeq: 2,
        } })).toBe(101);
    });
});
