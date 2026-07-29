import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

    it("ACKs the legacy Runtime Activity publisher claim only after active reachability commits", async () => {
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
        await getSocketHandler(socket, "runtime-activity-snapshot")({
            sid: session.id,
            state: "unknown",
            runtimeActivityActiveCount: 0,
        }, (value: unknown) => acknowledgements.push(value));

        expect(acknowledgements).toEqual([expect.objectContaining({
            result: "success",
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
        })]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
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
});
