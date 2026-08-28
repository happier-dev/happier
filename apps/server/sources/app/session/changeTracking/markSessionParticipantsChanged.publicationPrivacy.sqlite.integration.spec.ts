import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { markSessionParticipantsChanged } from "./markSessionParticipantsChanged";

describe("markSessionParticipantsChanged publication privacy (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-change-publication-privacy-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("does not create a collaborator AccountChange for post-publication private state", async () => {
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: {
                    publicKey: `pk-session-change-owner-${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            }),
            db.account.create({
                data: {
                    publicKey: `pk-session-change-collaborator-${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            }),
        ]);
        const session = await db.session.create({
            data: {
                tag: `session-change-finite-${crypto.randomUUID()}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: "{}",
                agentState: null,
                seq: 2,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 2,
                materializationPublicationId: "change-publication-v1",
                materializedThroughSourceAt: 20_000n,
                publishedThroughServerSeq: 2,
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: collaborator.id,
                accessLevel: "view",
            },
        });

        await inTx(async (tx) => await markSessionParticipantsChanged({
            tx,
            sessionId: session.id,
            hint: {
                latestTurnId: "post-publication-turn",
                latestTurnStatus: "failed",
                pendingPermissionRequestCount: 1,
                latestReadyEventSeq: 9,
                meaningfulActivityAt: 90_000,
            },
        }));

        const changes = await db.accountChange.findMany({
            where: { sessionId: session.id },
            orderBy: { accountId: "asc" },
            select: { accountId: true, hint: true },
        });
        expect(changes).toEqual([
            expect.objectContaining({
                accountId: owner.id,
                hint: expect.objectContaining({
                    latestTurnId: "post-publication-turn",
                    latestTurnStatus: "failed",
                }),
            }),
        ]);
        expect(changes.some((change) => change.accountId === collaborator.id)).toBe(false);
    });
});
