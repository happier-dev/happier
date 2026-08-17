import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io";

import { eventRouter, type ClientConnection, type UpdatePayload } from "@/app/events/eventRouter";
import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import {
    type ApplySessionTurnMutationResult,
} from "@/app/session/sessionWriteService";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

type ReceivedUpdate = Readonly<{ userId: string; payload: UpdatePayload }>;

function createUserConnection(
    userId: string,
    updates: ReceivedUpdate[],
): ClientConnection {
    const socket = {
        emit(event: string, payload: UpdatePayload) {
            if (event === "update") updates.push({ userId, payload });
        },
    } as unknown as Socket;
    return { connectionType: "user-scoped", userId, socket };
}

describe("session realtime publication privacy (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-realtime-publication-privacy-",
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

    it("suppresses unpublished finite realtime fanout for collaborators without sanitizing a tuple", async () => {
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: {
                    publicKey: `pk-session-realtime-owner-${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            }),
            db.account.create({
                data: {
                    publicKey: `pk-session-realtime-collaborator-${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            }),
        ]);
        const session = await db.session.create({
            data: {
                tag: `session-realtime-finite-${crypto.randomUUID()}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: "{}",
                agentState: null,
                seq: 9,
                lastViewedSessionSeq: 9,
                latestReadyEventSeq: 9,
                latestReadyEventAt: new Date(90_000),
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: "realtime-publication-v1",
                materializedThroughSourceAt: 42_000n,
                publishedThroughServerSeq: 4,
                createdAt: new Date(10_000),
                updatedAt: new Date(90_000),
                meaningfulActivityAt: new Date(90_000),
                lastActiveAt: new Date(90_000),
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

        const updates: ReceivedUpdate[] = [];
        const ownerConnection = createUserConnection(owner.id, updates);
        const collaboratorConnection = createUserConnection(collaborator.id, updates);
        eventRouter.addConnection(owner.id, ownerConnection);
        eventRouter.addConnection(collaborator.id, collaboratorConnection);
        const participantCursors = [
            { accountId: owner.id, cursor: 101 },
            { accountId: collaborator.id, cursor: 102 },
        ];
        try {
            await publishSessionReadCursorUpdate({
                sessionId: session.id,
                lastViewedSessionSeq: 9,
                participantCursors,
                badgeAttentionChanged: false,
            });
            expect(updates).toEqual([
                expect.objectContaining({
                    userId: owner.id,
                    payload: expect.objectContaining({
                        body: expect.objectContaining({ lastViewedSessionSeq: 9 }),
                    }),
                }),
            ]);

            updates.length = 0;
            const turnResult: Extract<ApplySessionTurnMutationResult, { ok: true }> = {
                ok: true,
                didApply: true,
                receipt: {
                    v: 1,
                    sessionId: session.id,
                    mutationId: "realtime-publication-mutation-v1",
                    turnId: "realtime-publication-turn-v1",
                    action: "complete",
                    decision: "applied",
                    observedAt: 90_000,
                    appliedAt: 90_000,
                },
                latestTurnId: "realtime-publication-turn-v1",
                latestTurnStatus: "failed",
                latestTurnStatusObservedAt: 90_000,
                lastRuntimeIssue: null,
                participantCursors,
                badgeAttentionChanged: false,
            };
            await publishSessionTurnMutationUpdate({
                sessionId: session.id,
                actorUserId: owner.id,
                result: turnResult,
            });
            expect(updates).toEqual([
                expect.objectContaining({
                    userId: owner.id,
                    payload: expect.objectContaining({
                        body: expect.objectContaining({
                            latestTurnId: "realtime-publication-turn-v1",
                            latestTurnStatus: "failed",
                            latestTurnStatusObservedAt: 90_000,
                        }),
                    }),
                }),
            ]);

            updates.length = 0;
            await publishSessionReadyProjectionUpdate({
                sessionId: session.id,
                readyProjection: {
                    latestReadyEventSeq: 9,
                    latestReadyEventAt: 90_000,
                },
            });
            expect(updates).toEqual([
                expect.objectContaining({
                    userId: owner.id,
                    payload: expect.objectContaining({
                        body: expect.objectContaining({
                            latestReadyEventSeq: 9,
                            latestReadyEventAt: 90_000,
                        }),
                    }),
                }),
            ]);
        } finally {
            eventRouter.removeConnection(owner.id, ownerConnection);
            eventRouter.removeConnection(collaborator.id, collaboratorConnection);
        }
    });
});
