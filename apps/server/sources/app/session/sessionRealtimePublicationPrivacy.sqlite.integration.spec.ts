import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readSessionUsageAccountingChangedV1 } from "@happier-dev/protocol/changes";
import type { Socket } from "socket.io";

import { eventRouter, type ClientConnection, type UpdatePayload } from "@/app/events/eventRouter";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import {
    applySessionReadCursorOperation,
    type ApplySessionTurnMutationResult,
} from "@/app/session/sessionWriteService";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";
import { loadSessionTranscriptPublicationRecipientProjection } from "@/app/session/sessionTranscriptPublicationPolicy";
import { initializeSessionOwnerReadStateInTx } from "@/app/session/personal/readState";
import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

type ReceivedUpdate = Readonly<{ userId: string; payload: UpdatePayload }>;

const authentication = createPresentUserSessionAccessAuthentication();

function createUserConnection(
    userId: string,
    updates: ReceivedUpdate[],
): ClientConnection {
    const socket = {
        id: `session-realtime-publication-${userId}-${crypto.randomUUID()}`,
        data: {
            userId,
            clientType: "user-scoped",
            authAuthority: "present_user",
            authTokenAuthenticationEvidence: [],
        },
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
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.sessionGrant.deleteMany({ where: { principalKind: 'account' } }),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createHostedSharedSession() {
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
            }),
            db.account.create({
                data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
            }),
        ]);
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: crypto.randomUUID(),
                encryptionMode: "plain",
                metadata: "{}",
                currentStorageState: "hosted",
                seq: 7,
                lastViewedSessionSeq: 0,
                active: true,
            },
        });
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: session.id,
                createdByAccountId: owner.id,
                accountId: collaborator.id,
                accessLevel: "edit",
            },
        });
        await inTx(tx => initializeSessionOwnerReadStateInTx(tx, { accountId: owner.id, sessionId: session.id }));
        return { owner, collaborator, session };
    }

    it("publishes an owner's read operation only to that Account's devices", async () => {
        const { owner, collaborator, session } = await createHostedSharedSession();
        const updates: ReceivedUpdate[] = [];
        const ownerConnections = [
            createUserConnection(owner.id, updates),
            createUserConnection(owner.id, updates),
        ];
        const collaboratorConnection = createUserConnection(collaborator.id, updates);
        eventRouter.clearIo();
        for (const connection of ownerConnections) eventRouter.addConnection(owner.id, connection);
        eventRouter.addConnection(collaborator.id, collaboratorConnection);

        try {
            const result = await applySessionReadCursorOperation({
                actorUserId: owner.id,
                sessionId: session.id,
                operation: { kind: "mark-read" },
                authentication,
            });
            expect(result).toMatchObject({ ok: true, didChange: true, lastViewedSessionSeq: 7 });
            if (!result.ok) throw new Error(`Read operation failed: ${result.error}`);

            await publishSessionReadCursorUpdate({ sessionId: session.id, ...result, authentication });

            expect(updates.filter(({ userId }) => userId === collaborator.id)).toEqual([]);
            expect(updates.filter(({ userId }) => userId === owner.id)).toEqual([
                expect.objectContaining({
                    payload: expect.objectContaining({
                        body: expect.objectContaining({ lastViewedSessionSeq: 7,
                            viewer: expect.objectContaining({ readState: { state: "tracking", lastViewedSessionSeq: 7, unreadSince: null } }),
                        }),
                    }),
                }),
                expect.objectContaining({
                    payload: expect.objectContaining({
                        body: expect.objectContaining({ lastViewedSessionSeq: 7,
                            viewer: expect.objectContaining({ readState: { state: "tracking", lastViewedSessionSeq: 7, unreadSince: null } }),
                        }),
                    }),
                }),
            ]);
            expect(await db.accountChange.findMany({
                where: { accountId: collaborator.id, sessionId: session.id },
            })).toEqual([]);
        } finally {
            for (const connection of ownerConnections) eventRouter.removeConnection(owner.id, connection);
            eventRouter.removeConnection(collaborator.id, collaboratorConnection);
        }
    });

    it("refuses to enroll an unfollowed direct editor through a read operation", async () => {
        const { collaborator, session } = await createHostedSharedSession();
        const result = await applySessionReadCursorOperation({
            actorUserId: collaborator.id,
            sessionId: session.id,
            operation: { kind: "mark-read" },
            authentication,
        });

        expect(result).toEqual({ ok: false, error: "session-not-tracked" });
        expect(await db.accountChange.findMany({ where: { sessionId: session.id } })).toEqual([]);
    });

    it("filters rollback eligibility facts while suppressing unpublished finite turn state for collaborators", async () => {
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
        await db.sessionGrant.create({
            data: { principalKind: 'account',
                sessionId: session.id,
                createdByAccountId: owner.id,
                accountId: collaborator.id,
                accessLevel: "view",
            },
        });

        await inTx(tx => initializeSessionOwnerReadStateInTx(tx, {
            accountId: owner.id, sessionId: session.id, lastViewedSessionSeq: 9,
        }));
        const updates: ReceivedUpdate[] = [];
        const ownerConnection = createUserConnection(owner.id, updates);
        const collaboratorConnection = createUserConnection(collaborator.id, updates);
        eventRouter.clearIo();
        eventRouter.addConnection(owner.id, ownerConnection);
        eventRouter.addConnection(collaborator.id, collaboratorConnection);
        const recipientCursors = [
            { accountId: owner.id, cursor: 101 },
            { accountId: collaborator.id, cursor: 102 },
        ];
        try {
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
                rollbackEligibleTurnStarts: [2, 7],
                recipientCursors,
                badgeAttentionChanged: false,
                // The applied mutation's own update returns this row; the fixture reads the committed one.
                recipientProjection: await loadSessionTranscriptPublicationRecipientProjection(session.id),
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
                            rollbackEligibleTurnStarts: [2, 7],
                        }),
                    }),
                }),
                expect.objectContaining({
                    userId: collaborator.id,
                    payload: expect.objectContaining({
                        body: expect.objectContaining({ rollbackEligibleTurnStarts: [2] }),
                    }),
                }),
            ]);

            updates.length = 0;
            const accountsBeforeReady = await db.account.findMany({
                where: { id: { in: [owner.id, collaborator.id] } }, select: { id: true, seq: true },
            });
            await publishSessionReadyProjectionUpdate({
                sessionId: session.id,
                readyProjection: {
                    latestReadyEventSeq: 9,
                    latestReadyEventAt: 90_000,
                },
            });
            const readyChanges = await db.accountChange.findMany({
                where: { kind: "session", entityId: session.id },
                select: { accountId: true, kind: true, cursor: true, hint: true },
            });
            expect(readyChanges.map(change => change.accountId)).toEqual([owner.id]);
            expect(readyChanges.map(change => readSessionUsageAccountingChangedV1(change,
                accountsBeforeReady.find(account => account.id === change.accountId)!.seq)))
                .toEqual([false]);
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
