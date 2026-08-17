import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX } from "@happier-dev/protocol";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("session update handler on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-update-handler-",
            sqliteConnectionLimit: 1,
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it("ACKs the canonical Runtime Activity publisher claim only after active reachability commits", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const socket = createFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence: createSessionPublisherPresence(),
                binding: {
                    accountId: owner.id,
                    machineId,
                    sessionId: session.id,
                },
            },
        );

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "unknown", activeCount: 0 },
        }, (value: unknown) => acknowledgements.push(value));

        expect(acknowledgements).toEqual([expect.objectContaining({
            status: "unchanged",
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            projection: expect.objectContaining({
                state: "unknown",
                activeCount: 0,
            }),
        })]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });

    it("advertises transcript observation support before the Antigravity publisher claim without admitting observations", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence,
                binding: {
                    accountId: owner.id,
                    machineId,
                    sessionId: session.id,
                },
            },
        );

        const observation = {
            v: 1 as const,
            sessionId: session.id,
            localId: `antigravity-${randomUUID()}`,
            messageRole: "agent" as const,
            content: "antigravity-ciphertext",
            createdAt: Date.parse("2026-07-28T18:00:02.000Z"),
            updatedAt: Date.parse("2026-07-28T18:00:02.000Z"),
            provenance: {
                kind: "non_dependent" as const,
                source: "external" as const,
            },
        };

        const capabilityAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: session.id },
            (value: unknown) => capabilityAcks.push(value),
        );

        const preclaimObservationAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            observation,
            (value: unknown) => preclaimObservationAcks.push(value),
        );
        const preclaimCount = await db.sessionMessage.count({
            where: { sessionId: session.id },
        });

        const claimAcks: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")(
            {
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "idle", activeCount: 0 },
            },
            (value: unknown) => claimAcks.push(value),
        );

        const claimedObservationAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            observation,
            (value: unknown) => claimedObservationAcks.push(value),
        );

        expect(capabilityAcks).toEqual([{
            ok: true,
            capability: "session-transcript-observation-v1",
        }]);
        expect(preclaimObservationAcks).toEqual([{
            ok: false,
            error: "forbidden",
        }]);
        expect(preclaimCount).toBe(0);
        expect(claimAcks).toEqual([expect.objectContaining({
            status: "applied",
            sessionId: session.id,
        })]);
        expect(claimedObservationAcks).toEqual([expect.objectContaining({
            ok: true,
            status: "observed",
            localId: observation.localId,
            didWrite: true,
        })]);
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: {
                localId: true,
                messageRole: true,
                content: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                transcriptObservationProvenance: true,
            },
        })).resolves.toEqual([{
            localId: observation.localId,
            messageRole: "agent",
            content: { t: "encrypted", c: "antigravity-ciphertext" },
            sourceCreatedAt: new Date(observation.createdAt),
            sourceUpdatedAt: new Date(observation.updatedAt),
            transcriptObservationProvenance: {
                kind: "non_dependent",
                source: "external",
            },
        }]);
    });

    it("refuses a reserved Agent-transition divider localId from the current transcript-observation publisher", async () => {
        // Being the claimed publisher grants the right to mirror provider output, not the
        // right to mint the owner-only transition divider. The identical observation with an
        // ordinary localId is admitted below, so this proves the refusal is the reserved
        // namespace rather than any authorization state.
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            { presence, binding: { accountId: owner.id, machineId, sessionId: session.id } },
        );

        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: session.id },
            () => {},
        );
        await getSocketHandler(socket, "session-runtime-activity-snapshot")(
            {
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "idle", activeCount: 0 },
            },
            () => {},
        );

        const baseObservation = {
            v: 1 as const,
            sessionId: session.id,
            messageRole: "agent" as const,
            content: "divider-ciphertext",
            createdAt: Date.parse("2026-07-28T18:00:02.000Z"),
            updatedAt: Date.parse("2026-07-28T18:00:02.000Z"),
            provenance: { kind: "non_dependent" as const, source: "external" as const },
        };

        const reservedAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            {
                ...baseObservation,
                localId: `${SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}${randomUUID()}`,
            },
            (value: unknown) => reservedAcks.push(value),
        );

        expect(reservedAcks).toEqual([{ ok: false, error: "invalid_observation" }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);

        const ordinaryLocalId = `ordinary-${randomUUID()}`;
        const ordinaryAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            { ...baseObservation, localId: ordinaryLocalId },
            (value: unknown) => ordinaryAcks.push(value),
        );

        expect(ordinaryAcks).toEqual([expect.objectContaining({
            ok: true,
            localId: ordinaryLocalId,
            didWrite: true,
        })]);
    });

    it("rejects active metadata publication from a publisher superseded after its runtime effect", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        let now = new Date("2026-07-22T07:00:01.000Z");
        const presence = createSessionPublisherPresence({ now: () => now });
        const bindPublisher = (socketId: string) => {
            const socket = createFakeSocket({ id: socketId });
            sessionUpdateHandler(
                owner.id,
                socket as never,
                {
                    connectionType: "session-scoped",
                    socket,
                    userId: owner.id,
                    sessionId: session.id,
                } as never,
                {
                    presence,
                    binding: {
                        accountId: owner.id,
                        machineId,
                        sessionId: session.id,
                    },
                },
            );
            return socket;
        };
        const predecessor = bindPublisher("predecessor");
        const successor = bindPublisher("successor");

        const predecessorClaim: unknown[] = [];
        await getSocketHandler(predecessor, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => predecessorClaim.push(value));
        expect(predecessorClaim).toEqual([expect.objectContaining({
            status: "applied",
        })]);

        now = new Date(now.getTime() + 1_000);
        const successorClaim: unknown[] = [];
        await getSocketHandler(successor, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => successorClaim.push(value));
        expect(successorClaim).toEqual([expect.objectContaining({
            status: "unchanged",
        })]);

        const stalePublication: unknown[] = [];
        await getSocketHandler(predecessor, "update-metadata")({
            sid: session.id,
            expectedVersion: 0,
            metadata: JSON.stringify({
                sessionModelsV1: {
                    v: 1,
                    agentId: "opencode",
                    updatedAt: 1,
                    currentModelId: "next-model",
                    availableModels: [{ id: "next-model", name: "Next model" }],
                },
            }),
        }, (value: unknown) => stalePublication.push(value));

        expect(stalePublication).toEqual([{ result: "publisher-superseded" }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadata: true, metadataVersion: true },
        })).resolves.toEqual({
            metadata: "{}",
            metadataVersion: 0,
        });
    });

    it("closes the exact current publisher through the canonical runtime-activity close event", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const turnId = `turn-${randomUUID()}`;
        await expect(applySessionTurnMutation({
            actorUserId: owner.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId,
                observedAt: Date.now() - 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const socket = createFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence: createSessionPublisherPresence(),
                binding: { accountId: owner.id, machineId, sessionId: session.id },
            },
        );

        const snapshotAcknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: "activity-1",
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => snapshotAcknowledgements.push(value));
        expect(snapshotAcknowledgements).toEqual([expect.objectContaining({
            status: "applied",
            sessionId: session.id,
            mutationId: "activity-1",
            projection: expect.objectContaining({ state: "idle", activeCount: 0 }),
        })]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-close")(
            { sessionId: session.id },
            (value: unknown) => acknowledgements.push(value),
        );

        expect(acknowledgements).toEqual([{ status: "closed", sessionId: session.id }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                latestTurnId: true,
                latestTurnStatus: true,
                thinking: true,
            },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
            latestTurnId: turnId,
            latestTurnStatus: "cancelled",
            thinking: false,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: "cancelled" });
    });

    it("does not let concurrent released alive sockets exhaust the single SQLite transaction connection", async () => {
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = "1000";

        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const presence = createSessionPublisherPresence();
        const sockets = [] as Array<Readonly<{ sessionId: string; alive: (value: unknown) => Promise<void> }>>;

        for (let index = 0; index < 12; index += 1) {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    active: false,
                    lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                    runtimeActivityState: "unknown",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: 0n,
                },
                select: { id: true },
            });
            await db.accessKey.create({
                data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
            });
            const socket = createFakeSocket();
            sessionUpdateHandler(
                owner.id,
                socket as never,
                {
                    connectionType: "session-scoped",
                    socket,
                    userId: owner.id,
                    sessionId: session.id,
                } as never,
                {
                    presence,
                    binding: { accountId: owner.id, machineId, sessionId: session.id },
                },
            );
            const handler = getSocketHandler(socket, "session-alive");
            const alive = async (value: unknown): Promise<void> => {
                await handler(value);
            };
            sockets.push({ sessionId: session.id, alive });
        }

        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        let resolveHolderEntered!: () => void;
        const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
        const holder = inTx(async () => {
            resolveHolderEntered();
            await holderRelease;
        });
        await holderEntered;

        const releaseTimer = setTimeout(releaseHolder, 850);
        try {
            await Promise.all(sockets.map(({ sessionId, alive }) => alive({
                sid: sessionId,
                time: Date.now(),
                thinking: false,
            })));
        } finally {
            clearTimeout(releaseTimer);
            releaseHolder();
            await holder;
        }

        await expect(db.session.count({
            where: {
                id: { in: sockets.map(({ sessionId }) => sessionId) },
                active: true,
            },
        })).resolves.toBe(sockets.length);
    });

    it("orders exact close behind an already accepted released alive backlog", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const createSession = async () => {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    active: false,
                    lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                    runtimeActivityState: "unknown",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: 0n,
                },
                select: { id: true },
            });
            await db.accessKey.create({
                data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
            });
            return session;
        };
        const blocker = await createSession();
        const target = await createSession();
        const presence = createSessionPublisherPresence();
        const blockerSocket = createFakeSocket();
        const targetSocket = createFakeSocket();
        sessionUpdateHandler(
            owner.id,
            blockerSocket as never,
            {
                connectionType: "session-scoped",
                socket: blockerSocket,
                userId: owner.id,
                sessionId: blocker.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: blocker.id },
            },
        );
        sessionUpdateHandler(
            owner.id,
            targetSocket as never,
            {
                connectionType: "session-scoped",
                socket: targetSocket,
                userId: owner.id,
                sessionId: target.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: target.id },
            },
        );

        await getSocketHandler(blockerSocket, "session-runtime-activity-snapshot")({
            sessionId: blocker.id,
            mutationId: `runtime-activity-snapshot:${blocker.id}`,
            snapshot: { state: "active", activeCount: 1 },
        }, () => {});
        let resolveBlockerEntered!: () => void;
        const blockerEntered = new Promise<void>((resolve) => { resolveBlockerEntered = resolve; });
        let releaseBlocker!: () => void;
        const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const heldBlockerOperation = presence.runAsCurrentPublisher({
            socket: blockerSocket,
            operation: async () => {
                resolveBlockerEntered();
                await blockerRelease;
            },
        });
        await blockerEntered;

        const blockerAlive = getSocketHandler(blockerSocket, "session-alive")({
            sid: blocker.id,
            time: Date.now(),
            thinking: false,
        });
        await Promise.resolve();
        const targetAlive = getSocketHandler(targetSocket, "session-alive")({
            sid: target.id,
            time: Date.now(),
            thinking: false,
        });
        const closeAcknowledgements: unknown[] = [];
        const targetClose = getSocketHandler(targetSocket, "session-runtime-activity-close")(
            { sessionId: target.id },
            (value: unknown) => closeAcknowledgements.push(value),
        );

        releaseBlocker();
        await Promise.all([heldBlockerOperation, blockerAlive, targetAlive, targetClose]);

        expect(closeAcknowledgements).toEqual([{ status: "closed", sessionId: target.id }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: target.id },
            select: { active: true, runtimeActivityState: true },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: "unknown",
        });
    });

    it("returns a typed retry ACK when provider acceptance cannot acquire a transaction", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-08-14T12:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });

        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: session.id },
            },
        );
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const previousMaxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const originalTransaction = db.$transaction;
        const transaction = vi.fn().mockRejectedValueOnce(acquisitionError);
        // Prisma's overloaded transaction boundary cannot be represented by one Vitest mock signature.
        db.$transaction = transaction as unknown as typeof db.$transaction;
        const unavailableAcknowledgements: unknown[] = [];
        try {
            await getSocketHandler(socket, "pending-delivery-accepted-v1")({
                v: 1,
                sessionId: session.id,
                localId: "pending-1",
            }, (value: unknown) => unavailableAcknowledgements.push(value));
        } finally {
            db.$transaction = originalTransaction;
            if (previousMaxRetries === undefined) {
                delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            } else {
                process.env.HAPPIER_DB_TX_MAX_RETRIES = previousMaxRetries;
            }
        }

        expect(unavailableAcknowledgements).toEqual([{
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: expect.stringMatching(/^[A-Za-z0-9_.:-]{1,160}$/u),
        }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);

        const continuedAcknowledgements: unknown[] = [];
        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: session.id,
            localId: "pending-1",
        }, (value: unknown) => continuedAcknowledgements.push(value));
        expect(continuedAcknowledgements).toEqual([{ ok: false, error: "not-found" }]);
    });
});
