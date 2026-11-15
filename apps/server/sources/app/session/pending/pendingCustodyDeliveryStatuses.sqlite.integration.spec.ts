import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("claim-reply custody delivery statuses on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-pending-custody-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("reports a claiming host's held localIds exactly as the Pending list does", async () => {
        const { readPendingCustodyDeliveryStatusesInTx } = await import("./pendingMessageService");
        const account = await db.account.create({ data: { publicKey: "pk-pending-custody" }, select: { id: true } });
        const createSession = (tag: string) => db.session.create({ data: { accountId: account.id, tag, encryptionMode: "plain",
            metadata: "{}", metadataVersion: 1, agentState: null, agentStateVersion: 0, seq: 0, pendingVersion: 0, pendingCount: 0,
            active: true }, select: { id: true } });
        const session = await createSession("custody");
        const other = await createSession("custody-other");
        let position = 0;
        const row = (sessionId: string, localId: string, fields: Record<string, unknown>) => db.sessionPendingMessage.create({ data: {
            sessionId, localId, messageRole: "user", position: ++position, requestedAction: { v: 1, kind: "enqueue" },
            content: { t: "plain", v: { role: "user", content: { type: "text", text: localId } } }, ...fields } });
        await row(session.id, "held-blocked", { status: "queued", deliveryState: "blocked", deliveryBlockedReason: "team_access_removed" });
        await row(session.id, "held-archived", { status: "discarded", discardedAt: new Date(), discardedReason: "dismissed_uncertain" });
        await row(session.id, "held-hidden", { status: "discarded", discardedAt: new Date(), discardedReason: "resent_as_new" });
        await row(session.id, "held-run", { status: "queued", targetExecutionRunId: "run-1" });
        await row(session.id, "not-held", { status: "queued" });
        await row(other.id, "held-elsewhere", { status: "queued" });

        const statuses = await inTx(tx => readPendingCustodyDeliveryStatusesInTx(tx, { sessionId: session.id,
            localIds: ["held-blocked", "held-archived", "held-hidden", "held-run", "held-elsewhere", "held-absent"] }));

        expect([...statuses].sort((a, b) => a.localId.localeCompare(b.localId))).toEqual([
            { localId: "held-archived", deliveryStatus: { status: "discarded", reason: "dismissed_uncertain" } },
            { localId: "held-blocked", deliveryStatus: { status: "blocked", reason: "team_access_removed" } },
        ]);
    });
});
