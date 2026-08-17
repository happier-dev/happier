import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

type Deferred = Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}>;

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function expectBarrierEnteredBeforeResponse(
    barrier: Readonly<{ reached: Promise<void> }>,
    response: Promise<unknown>,
): Promise<void> {
    await expect(Promise.race([
        barrier.reached.then(() => "barrier-entered" as const),
        response.then(() => "response-completed" as const),
    ])).resolves.toBe("barrier-entered");
}

function installPauseBeforeReadTransaction(): Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const reached = deferred();
    const release = deferred();
    const originalTransaction = db.$transaction;
    let paused = false;
    let restored = false;

    db.$transaction = (async (...args: unknown[]) => {
        if (!paused && typeof args[0] === "function") {
            paused = true;
            reached.resolve();
            await release.promise;
        }
        return await Reflect.apply(originalTransaction, undefined, args);
    }) as typeof db.$transaction;

    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            db.$transaction = originalTransaction;
        },
    };
}

function installPauseBeforeSessionTurnRead(): Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const reached = deferred();
    const release = deferred();
    const directDelegate = db.sessionTurn;
    const originalDirectFindMany = directDelegate.findMany.bind(directDelegate);
    const originalTransaction = db.$transaction;
    let paused = false;
    let restored = false;

    const pause = async (): Promise<void> => {
        if (paused) return;
        paused = true;
        reached.resolve();
        await release.promise;
    };

    Object.defineProperty(directDelegate, "findMany", {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => {
            await pause();
            return await Reflect.apply(originalDirectFindMany, directDelegate, args);
        },
    });
    db.$transaction = (async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") {
            return await Reflect.apply(originalTransaction, undefined, args);
        }

        return await Reflect.apply(originalTransaction, undefined, [
            async (tx: object) => {
                const transactionDelegate = Reflect.get(tx, "sessionTurn") as object;
                const originalFindMany = Reflect.get(transactionDelegate, "findMany") as Function;
                const wrappedDelegate = new Proxy(transactionDelegate, {
                    get(target, property, receiver) {
                        if (property !== "findMany") return Reflect.get(target, property, receiver);
                        return async (...findManyArgs: unknown[]) => {
                            await pause();
                            return await Reflect.apply(originalFindMany, target, findManyArgs);
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "sessionTurn") return wrappedDelegate;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            ...args.slice(1),
        ]);
    }) as typeof db.$transaction;

    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            Object.defineProperty(directDelegate, "findMany", {
                configurable: true,
                writable: true,
                value: originalDirectFindMany,
            });
            db.$transaction = originalTransaction;
        },
    };
}

async function createSharedSessionFixture(): Promise<Readonly<{
    ownerId: string;
    collaboratorId: string;
    sessionId: string;
    messageId: string;
    localId: string;
    observedRevision: string;
}>> {
    const owner = await db.account.create({
        data: { publicKey: `pk-current-member-owner-${crypto.randomUUID()}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const collaborator = await db.account.create({
        data: { publicKey: `pk-current-member-collaborator-${crypto.randomUUID()}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            tag: `current-member-${crypto.randomUUID()}`,
            accountId: owner.id,
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
            agentState: null,
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
    const message = await db.sessionMessage.create({
        data: {
            sessionId: session.id,
            localId: "input-1",
            seq: 1,
            messageRole: "user",
            content: {
                t: "plain",
                v: {
                    role: "user",
                    content: { type: "text", text: "private transcript content" },
                },
            },
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: collaborator.id,
                sessionRelationship: "sharedEditor",
            },
        },
        select: { id: true, updatedAt: true },
    });
    await db.sessionTurn.create({
        data: {
            sessionId: session.id,
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 2n,
        },
    });

    return {
        ownerId: owner.id,
        collaboratorId: collaborator.id,
        sessionId: session.id,
        messageId: message.id,
        localId: "input-1",
        observedRevision: `message-updated-at:${message.updatedAt.getTime()}`,
    };
}

async function revokeShare(params: Readonly<{ sessionId: string; collaboratorId: string }>): Promise<void> {
    await db.sessionShare.delete({
        where: {
            sessionId_sharedWithUserId: {
                sessionId: params.sessionId,
                sharedWithUserId: params.collaboratorId,
            },
        },
    });
}

describe("sessionRoutes current shared-participant reads (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-current-participant-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("returns only the server-derived coarse actor for an eligible external-shareable page", async () => {
        const fixture = await createSharedSessionFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/messages?projection=externalShareableV1&afterSeq=0`,
                    headers: { "x-test-user-id": fixture.collaboratorId },
                });

                expect(response.statusCode).toBe(200);
                const message = response.json().messages[0];
                expect(message).toMatchObject({
                    id: fixture.messageId,
                    externalShareableActor: "collaborator",
                });
                expect(message).not.toHaveProperty("inputAdmissionReceipt");
                expect(JSON.stringify(response.json())).not.toContain(fixture.collaboratorId);
                expect(JSON.stringify(response.json())).not.toContain("sharedEditor");
            },
        );
    });

    it("does not page messages after a collaborator share is revoked before the deciding transaction", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v1/sessions/${fixture.sessionId}/messages?projection=externalShareableV1&afterSeq=0`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("does not resolve a local message after a collaborator share is revoked before the deciding transaction", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v2/sessions/${fixture.sessionId}/messages/by-local-id/${fixture.localId}`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("returns unavailable rather than deleted or available after a share is revoked before action-reference lookup", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "POST",
                        url: `/v1/sessions/${fixture.sessionId}/messages/action-reference/resolve`,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": fixture.collaboratorId,
                        },
                        payload: {
                            v: 1,
                            sessionId: fixture.sessionId,
                            messageId: fixture.messageId,
                            observedRevision: fixture.observedRevision,
                        },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(200);
                    expect(response.json()).toEqual({ status: "unavailable" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("does not project turns after a collaborator share is revoked before the deciding turn query", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = installPauseBeforeSessionTurnRead();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v1/sessions/${fixture.sessionId}/turns`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it.each([
        ["owner", (fixture: Awaited<ReturnType<typeof createSharedSessionFixture>>) => fixture.ownerId],
        ["shared recipient", (fixture: Awaited<ReturnType<typeof createSharedSessionFixture>>) => fixture.collaboratorId],
    ])("keeps the %s turns projection at the server publication ceiling without a client projection query", async (_recipient, resolveUserId) => {
        const fixture = await createSharedSessionFixture();
        const publicationObservedAt = 1_700_000_000_000;
        const privateUpdatedAt = new Date(publicationObservedAt + 60_000);
        await db.sessionTurn.update({
            where: {
                sessionId_turnId: {
                    sessionId: fixture.sessionId,
                    turnId: "turn-1",
                },
            },
            data: {
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 1,
                    userMessageSeqs: [1],
                    startSeqInclusive: 1,
                    endSeqInclusive: 1,
                    finalAssistantMessageSeq: 1,
                }),
            },
        });
        await db.sessionTurn.create({
            data: {
                sessionId: fixture.sessionId,
                turnId: "turn-private-tail",
                status: "completed",
                startedAt: 2n,
                updatedAt: 3n,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 2,
                    userMessageSeqs: [2],
                    startSeqInclusive: 2,
                    endSeqInclusive: 2,
                    finalAssistantMessageSeq: 2,
                }),
            },
        });
        await db.session.update({
            where: { id: fixture.sessionId },
            data: {
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 2,
                materializationPublicationId: "publication-current-membership",
                materializedThroughSourceAt: BigInt(publicationObservedAt),
                publishedThroughServerSeq: 1,
                latestTurnId: "turn-private-tail",
                updatedAt: privateUpdatedAt,
            },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/turns`,
                    headers: { "x-test-user-id": resolveUserId(fixture) },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({
                    v: 1,
                    sessionId: fixture.sessionId,
                    updatedAt: publicationObservedAt,
                    turns: [expect.objectContaining({ turnId: "turn-1" })],
                });
            },
        );
    });

    it("rejects the retired external-shareable turns projection", async () => {
        const fixture = await createSharedSessionFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/turns?projection=externalShareableV1`,
                    headers: { "x-test-user-id": fixture.collaboratorId },
                });

                expect(response.statusCode).toBe(400);
            },
        );
    });
});
