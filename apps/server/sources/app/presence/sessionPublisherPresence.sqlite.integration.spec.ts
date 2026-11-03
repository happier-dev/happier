import { preparePresenceTimeouts } from './timeout';
import type { ClientConnection } from '@/app/events/eventPayloadTypes';
import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import {
    UpdateBodySchema,
    MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
    MachineSessionTerminalCaptureResponseV1Schema,
} from "@happier-dev/protocol";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { machineUpdateHandler } from "@/app/api/socket/machineUpdateHandler";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eventRouter } from "@/app/events/eventRouter";
import { publishSessionPublisherClose } from "./publishSessionPublisherClose";
import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import {
    applySessionTurnMutation,
    updateSessionMetadataEnvelopeTuple,
} from "@/app/session/sessionWriteService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { holdSqliteWriteLock } from "@/testkit/sqliteWriteLock";

import { createSessionPublisherPresence, expireSessionPublisherCandidates, readSessionPublisherAuthorityProjection } from "./sessionPublisherPresence";
import { resolveCurrentSessionPublisherFromServer } from "@/app/api/socket/externalActionDispatcher";
import { blockPendingDelivery, enqueuePendingMessage, materializeNextPendingMessage, resolveAcceptedPendingDelivery } from "@/app/session/pending/pendingMessageService";
import { logger } from '@/utils/logging/log';
import { withWebLatencyTrace } from '@/utils/webLatencyTrace';
import { hasExactCurrentPublisherAuthorityInTx } from '@/app/session/pending/hasExactCurrentPublisherAuthorityInTx';

const authentication = createPresentUserSessionAccessAuthentication();

describe("session publisher presence on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-session-publisher-presence-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({
            data: createSignedAccountContentBinding(),
            select: { id: true },
        });
        const participant = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const fence = new Date("2026-07-15T10:00:00.000Z");
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: fence,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: participant.id,
                accessLevel: "view",
            },
        });
        return {
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            participantIds: [owner.id, participant.id].sort(),
            fence,
        };
    }

    it('expires Session presence at 120 seconds after restart while renewals preserve content clocks', async () => {
        const seeded = await seed();
        const base = Date.now();
        let clock = new Date(base);
        const presence = createSessionPublisherPresence({ now: () => clock });
        const socket = {};
        await presence.registerPublisher({ socket, binding: seeded.binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        const read = () => db.session.findUniqueOrThrow({ where: { id: seeded.binding.sessionId }, select: {
            active: true, lastActiveAt: true, updatedAt: true, metadataVersion: true,
            agentStateVersion: true, runtimeActivityRevision: true, seq: true,
        } });
        const registered = await read();
        const reader = createFakeSocket({ data: { clientType: 'user-scoped' } });
        const connection: ClientConnection = { userId: seeded.binding.accountId, connectionType: 'user-scoped',
            socket: reader as unknown as Socket };
        eventRouter.addConnection(connection.userId, connection);
        const offline = () => reader.emit.mock.calls.filter(([event, value]) => event === 'ephemeral'
            && value?.type === 'activity' && value.id === seeded.binding.sessionId);
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        let deadlines = preparePresenceTimeouts();
        try {
            await deadlines.start();
            await vi.advanceTimersByTimeAsync(60_000);
            clock = new Date(Date.now());
            expect(await presence.touchPublisher({ socket, observedAt: clock })).toMatchObject({ status: 'touched' });
            expect.soft(await read()).toEqual({ ...registered, lastActiveAt: clock });
            await vi.advanceTimersByTimeAsync(60_000);
            expect((await read()).active).toBe(true);
            await deadlines.stop();
            deadlines = preparePresenceTimeouts();
            await deadlines.start();
            await vi.advanceTimersByTimeAsync(59_999);
            expect((await read()).active).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect(await read()).toEqual({ ...registered, active: false, lastActiveAt: clock }));
            await vi.waitFor(() => expect(offline().map(([, value]) => value)).toEqual([
                expect.objectContaining({ id: seeded.binding.sessionId, active: false, activeAt: clock.getTime() }),
            ]));
            await vi.advanceTimersByTimeAsync(120_000);
            expect(offline()).toHaveLength(1);
        } finally {
            eventRouter.removeConnection(connection.userId, connection);
            await deadlines.stop();
            vi.useRealTimers();
        }
    });

    it("observes publisher queue admission separately from the active operation for each request", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => seeded.fence });
        const socket = {};
        const registered = await presence.registerPublisher({ socket, binding: seeded.binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('expected registration');
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const firstId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        const secondId = '33b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        let enter!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const first = withWebLatencyTrace(firstId, () => presence.runAsCurrentPublisher({ socket,
            operation: async () => { enter(); await held; return 'first'; } }));
        await entered;
        const second = withWebLatencyTrace(secondId, () => presence.runAsCurrentPublisher({ socket,
            operation: async () => 'second' }));
        try {
            expect(sink).toHaveBeenCalledWith(expect.objectContaining({ phase: 'session.publisher.queue', requestId: firstId }), '[web-latency]');
            expect(sink.mock.calls.some(([value]) => typeof value === 'object' && value !== null && 'requestId' in value && value.requestId === secondId)).toBe(false);
            release();
            expect(await Promise.all([first, second])).toEqual(['first', 'second']);
            for (const requestId of [firstId, secondId]) {
                for (const phase of ['session.publisher.queue', 'session.publisher.operation']) {
                    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ phase, requestId, elapsedMs: expect.any(Number) }), '[web-latency]');
                }
            }
        } finally { release(); await Promise.all([first, second]); sink.mockRestore(); vi.unstubAllEnvs(); }
    });

    it("does not replace a newer snapshot registration fence with a delayed heartbeat observation", async () => {
        const seeded = await seed();
        let clock = new Date(seeded.fence.getTime() + 20);
        const presence = createSessionPublisherPresence({ now: () => clock });
        const socket = {};
        await presence.publishSnapshot({ socket, binding: seeded.binding, completeSnapshot: { state: "active", activeCount: 1 } });
        const registered = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGenerationLastActiveAt: true, runtimeActivityRevision: true },
        });
        clock = new Date(seeded.fence.getTime() + 60_000);
        await expect(presence.touchPublisher({ socket, observedAt: new Date(seeded.fence.getTime() + 10) }))
            .resolves.toEqual({ status: "stale_observation" });
        await expect(presence.registerPublisher({
            socket, binding: seeded.binding, completeActivitySnapshot: { state: "unknown", activeCount: 0 },
            observedAt: new Date(seeded.fence.getTime() + 10),
        })).resolves.toEqual({ status: "rejected", reason: "contention" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGenerationLastActiveAt: true, runtimeActivityRevision: true },
        })).resolves.toEqual(registered);
    });

    it("reads current publisher authority while an unrelated database writer holds its lock", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => seeded.fence });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket, binding: seeded.binding,
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const writer = await holdSqliteWriteLock();
        let observed: Awaited<ReturnType<typeof presence.readCurrentPublisherPrecondition>> | undefined;
        const read = presence.readCurrentPublisherPrecondition({ socket }).then(value => { observed = value; });
        try {
            // Observation window only: authority is a read and must finish before writer release.
            await vi.waitFor(() => expect(observed).toEqual({
                machineId: seeded.binding.machineId,
                committedFenceMs: registered.committedFence.getTime(),
                publisherGeneration: registered.publisherGeneration.toString(),
            }), { timeout: 1_000 });
        } finally {
            await writer.release();
            await read;
        }
        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: new Date() } });
        await expect(presence.readCurrentPublisherPrecondition({ socket })).resolves.toBeNull();
    });

    async function seedEphemeralRunner() {
        const seeded = await seed();
        await db.machine.update({
            where: { id: seeded.binding.machineId },
            data: {
                kind: "ephemeral_session_runner",
                installationId: `runner-installation-${randomUUID()}`,
                installationPublicKey: new Uint8Array(32).fill(7),
            },
        });
        await db.ephemeralRunnerActivation.create({
            data: {
                id: randomUUID(),
                creatorAccountId: seeded.binding.accountId,
                creatorTokenEpoch: 0,
                draftId: `runner-draft-${randomUUID()}`,
                sessionId: seeded.binding.sessionId,
                machineId: seeded.binding.machineId,
                state: "materialized",
                workspacePolicy: "choose_on_endpoint",
                activationExpiresAt: null,
                homeServerIdentityId: `runner-home-${randomUUID()}`,
                activationSigningPublicKey: "a".repeat(43),
                authoringCommitment: "b".repeat(43),
                artifact: {
                    product: "happier-runner",
                    version: "0.3.0",
                    target: "linux-x64",
                    sha256: "c".repeat(64),
                },
                endpointFactsRecipient: {
                    mode: "plain",
                    creatorAccountId: seeded.binding.accountId,
                },
            },
        });
        return seeded;
    }

    it("registers only an exact current machine-bound publisher for an unarchived session", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => seeded.fence });

        await expect(presence.registerPublisher({
            socket: {},
            binding: { ...seeded.binding, machineId: "wrong-machine" },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });

        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: new Date() } });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: null } });
        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { archivedAt: new Date() } });
        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "archived" });
    });

    it("rejects publisher generation overflow without changing reachability", async () => {
        const seeded = await seed();
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { publisherGeneration: 9_223_372_036_854_775_807n },
        });
        const presence = createSessionPublisherPresence();

        await expect(presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "revision_overflow" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, publisherGeneration: true },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: seeded.fence,
            publisherGeneration: 9_223_372_036_854_775_807n,
        });
    });

    it.each(["heartbeat", "replacement"] as const)("keeps publisher tuple authority across %s only when the publisher is unchanged", async (change) => {
        const seeded = await seed();
        const previousOwnerMetadataCiphertext =
            "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==";
        const nextOwnerMetadataCiphertext =
            "oRohIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh6m869PVe0miAb8CnDsASVAnt9+tG1Zg==";
        const previousOwnerMetadata = {
            t: "encrypted",
            c: previousOwnerMetadataCiphertext,
        } as const;
        const nextOwnerMetadata = {
            t: "encrypted",
            c: nextOwnerMetadataCiphertext,
        } as const;
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: {
                metadataLayoutVersion: 1,
                metadata: "shared-before",
                metadataVersion: 4,
                ownerMetadata: JSON.stringify(previousOwnerMetadata),
                agentState: "agent-before",
                agentStateVersion: 8,
            },
        });
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessorSocket = {};
        const predecessor = await presence.registerPublisher({
            socket: predecessorSocket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(predecessor.status).toBe("registered");
        if (predecessor.status !== "registered") {
            throw new Error("expected predecessor registration");
        }
        now = new Date(predecessor.committedFence.getTime() + 10);
        const publisherPrecondition = await presence.readCurrentPublisherPrecondition({ socket: predecessorSocket });
        if (!publisherPrecondition) throw new Error("expected current publisher authority");
        const successor = change === "heartbeat"
            ? await presence.touchPublisher({ socket: predecessorSocket })
            : await presence.registerPublisher({
                socket: {},
                binding: seeded.binding,
                completeActivitySnapshot: { state: "idle", activeCount: 0 },
            });
        expect(successor.status).toBe(change === "heartbeat" ? "touched" : "registered");
        if (successor.status !== "registered" && successor.status !== "touched") {
            throw new Error("expected publisher activity commit");
        }

        const capturedPublisherPatch = {
            mode: "owner" as const,
            actorUserId: seeded.binding.accountId,
            sessionId: seeded.binding.sessionId,
            metadataLayoutVersion: 1 as const,
            publisherPrecondition,
            expectedOwnerMetadata: previousOwnerMetadata,
            sharedMetadata: {
                ciphertext: "shared-after",
                expectedVersion: 4,
            },
            ownerMetadata: nextOwnerMetadata,
            agentState: {
                ciphertext: "agent-after",
                expectedVersion: 8,
            },
        };
        await expect(updateSessionMetadataEnvelopeTuple(
            capturedPublisherPatch,
        )).resolves.toMatchObject(change === "heartbeat"
            ? { ok: true }
            : { ok: false, error: "publisher-superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                metadata: true,
                metadataVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
                lastActiveAt: true,
            },
        })).resolves.toEqual({
            metadata: change === "heartbeat" ? "shared-after" : "shared-before",
            metadataVersion: change === "heartbeat" ? 5 : 4,
            ownerMetadata: JSON.stringify(change === "heartbeat" ? nextOwnerMetadata : previousOwnerMetadata),
            agentState: change === "heartbeat" ? "agent-after" : "agent-before",
            agentStateVersion: change === "heartbeat" ? 9 : 8,
            lastActiveAt: successor.committedFence,
        });
    });

    it.each(['heartbeat', 'replacement'] as const)("rechecks snapshot publisher authority after database admission (%s)", async change => {
        const seeded = await seed();
        let clock = seeded.fence;
        const presence = createSessionPublisherPresence({ now: () => clock });
        const socket = {};
        const successorSocket = {};
        expect(await presence.registerPublisher({ socket, binding: seeded.binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
        let prepared = false;
        try {
            const result = await presence.runAsCurrentPublisherInTx({ socket,
                authorityMode: 'snapshot', isolationLevel: 'Serializable',
                // Database admission can await while the same socket heartbeat
                // commits. Exercise that interval without sleeps or mocked logic.
                prepare: async () => {
                    if (!prepared) {
                        prepared = true;
                        clock = new Date(seeded.fence.getTime() + 1_000);
                        if (change === 'heartbeat') {
                            expect(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
                        } else {
                            expect(await presence.registerPublisher({ socket: successorSocket, binding: seeded.binding,
                                completeActivitySnapshot: { state: 'idle', activeCount: 0 } }))
                                .toMatchObject({ status: 'registered' });
                        }
                    }
                    return async () => {};
                },
                operation: async (authority, tx) => await hasExactCurrentPublisherAuthorityInTx(
                    tx, authority, seeded.binding.accountId, seeded.binding.sessionId),
            });
            expect(result === true).toBe(change === 'heartbeat');
        } finally {
            await presence.forgetDisconnectedPublisher({ socket: successorSocket });
            await presence.forgetDisconnectedPublisher({ socket });
        }
    });

    it("expires a queued current-publisher operation without running it after the held neighbor settles", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 1) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");

        let releaseFirst!: () => void;
        const first = presence.runAsCurrentPublisher({
            socket,
            operation: async () => await new Promise<void>((resolve) => { releaseFirst = resolve; }),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const secondOperation = vi.fn(async () => "started");
        const second = presence.runAsCurrentPublisherInTx({
            socket,
            deadlineAtMs: Date.now() + 25,
            operation: secondOperation,
        });
        await expect(second).rejects.toMatchObject({ name: "LockAdmissionDeadlineExceededError" });

        releaseFirst();
        await first;
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(secondOperation).not.toHaveBeenCalled();
    });

    it("makes registration the positive transition and fences a replaced publisher's writes and close", async () => {
        const seeded = await seed();
        const turnId = `turn-${randomUUID()}`;
        await expect(applySessionTurnMutation({
            actorUserId: seeded.binding.accountId,
            authentication,
            mutation: {
                v: 1,
                sessionId: seeded.binding.sessionId,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId,
                observedAt: seeded.fence.getTime() - 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessor = {};
        const successor = {};

        const first = await presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(first.status).toBe("registered");
        if (first.status !== "registered") throw new Error("expected registration");
        expect(first.badgeAttentionChanged).toBe(false);
        const registeredRow = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, updatedAt: true },
        });
        expect(registeredRow).toMatchObject({
            active: true,
            lastActiveAt: first.committedFence,
        });
        await expect(presence.checkCurrentPublisher({
            socket: predecessor,
        })).resolves.toBe(true);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { updatedAt: true },
        })).resolves.toEqual({ updatedAt: registeredRow.updatedAt });

        now = new Date(first.committedFence.getTime() + 10);
        const replacement = await presence.registerPublisher({
            socket: successor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(replacement.status).toBe("registered");
        if (replacement.status !== "registered") throw new Error("expected replacement");
        expect(replacement.badgeAttentionChanged).toBe(false);
        await expect(presence.checkCurrentPublisher({
            socket: predecessor,
        })).resolves.toBe(false);
        await expect(presence.checkCurrentPublisher({
            socket: successor,
        })).resolves.toBe(true);

        await expect(presence.publishSnapshot({
            socket: predecessor,
            binding: seeded.binding,
            completeSnapshot: { state: "active", activeCount: 2 },
        })).resolves.toEqual({ status: "rejected", reason: "superseded" });
        await expect(presence.publishSnapshot({
            socket: predecessor, binding: seeded.binding,
            completeSnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "superseded" });
        await expect(presence.touchPublisher({ socket: predecessor })).resolves.toEqual({ status: "superseded" });
        await expect(presence.closePublisher({ socket: predecessor })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { latestTurnStatus: true, thinking: true },
        })).resolves.toEqual({ latestTurnStatus: "in_progress", thinking: true });

        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: replacement.committedFence,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
        });

        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: {
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: now,
            },
        });
        const closed = await presence.closePublisher({ socket: successor });
        expect(closed.status).toBe("closed");
        if (closed.status !== "closed") throw new Error("expected close");
        expect(closed.turnProjection).toMatchObject({
            latestTurnId: turnId,
            latestTurnStatus: "cancelled",
        });
        expect(closed.badgeAttentionChanged).toBe(false);
        // Only fanout is replaced; the real publisher close transaction feeds the real publisher.
        const updates = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        try {
            await publishSessionPublisherClose({
                sessionId: seeded.binding.sessionId,
                publisherAccountId: seeded.binding.accountId,
                closed,
            });
            const terminalUpdates = updates.mock.calls.filter(([update]) =>
                update.payload.body.t === "update-session" && update.payload.body.latestTurnStatus === "cancelled",
            );
            expect(terminalUpdates).toHaveLength(seeded.participantIds.length);
            for (const [update] of terminalUpdates) {
                const body = UpdateBodySchema.parse(update.payload.body);
                expect(body).not.toHaveProperty("pendingPermissionRequestCount");
                expect(body).not.toHaveProperty("pendingUserActionRequestCount");
                expect(body).not.toHaveProperty("pendingRequestObservedAt");
            }
        } finally {
            updates.mockRestore();
        }
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: {
                sessionId_turnId: {
                    sessionId: seeded.binding.sessionId,
                    turnId,
                },
            },
            select: { status: true },
        })).resolves.toEqual({ status: "cancelled" });
        await expect(presence.closePublisher({ socket: successor })).resolves.toEqual({
            status: "closed_replay",
            activeAt: closed.activeAt,
        });
    });

    it("reclaims a proven undispatched initial prompt once after a planned publisher replacement", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const first = await presence.registerPublisher({ socket, binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 } });
        if (first.status !== "registered") throw new Error("expected registration");
        const request = { actorUserId: seeded.binding.accountId, sessionId: seeded.binding.sessionId,
            localId: `initial-prompt-${randomUUID()}` };
        expect(await enqueuePendingMessage({ ...request, authentication, ciphertext: "initial-assistant-marker",
            requestedAction: { v: 1, kind: "enqueue" } })).toMatchObject({ ok: true });
        const authority = { ...seeded.binding, committedFence: first.committedFence };
        expect(await materializeNextPendingMessage({ actorUserId: request.actorUserId, sessionId: request.sessionId,
            publisherAuthority: authority, deliveryState: "provider", deliveryTiming: "after_foreground_ready",
            foregroundState: "ready" })).toMatchObject({ ok: true, didMaterialize: true });
        expect(await blockPendingDelivery({ ...request, reason: "host_retired_before_dispatch" }))
            .toMatchObject({ ok: true, didUpdate: true });
        await presence.closePublisher({ socket });

        const replacementSocket = {};
        const replacement = await presence.registerPublisher({ socket: replacementSocket, binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 } });
        if (replacement.status !== "registered") throw new Error("expected successor registration");
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
            sessionId: request.sessionId, localId: request.localId } },
            select: { deliveryState: true, deliveryBlockedReason: true, providerAction: true } }))
            .toEqual({ deliveryState: null, deliveryBlockedReason: null, providerAction: null });
        const successor = { ...seeded.binding, committedFence: replacement.committedFence };
        const delivery = await materializeNextPendingMessage({ actorUserId: request.actorUserId, sessionId: request.sessionId,
            publisherAuthority: successor, deliveryState: "provider", deliveryTiming: "after_foreground_ready", foregroundState: "ready" });
        expect(delivery).toMatchObject({ ok: true, didMaterialize: true, message: { localId: request.localId,
            content: { t: "encrypted", c: "initial-assistant-marker" }, providerAction: "send" } });
        expect(await resolveAcceptedPendingDelivery({ ...request, publisherAuthority: successor }))
            .toMatchObject({ ok: true, pendingCount: 0, pendingBlockedCount: 0 });
        expect(await materializeNextPendingMessage({ actorUserId: request.actorUserId, sessionId: request.sessionId,
            publisherAuthority: successor, deliveryState: "provider", deliveryTiming: "after_foreground_ready",
            foregroundState: "ready" })).toMatchObject({ ok: true, didMaterialize: false });
        expect(await db.sessionMessage.count({ where: { sessionId: request.sessionId, localId: request.localId } })).toBe(1);
    });

    it("keeps handing a proven undispatched prompt back through repeated planned replacements and delivers it once", async () => {
        const seeded = await seed();
        let tick = 10;
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + tick++) });
        const localId = `initial-prompt-${randomUUID()}`;
        const identity = { actorUserId: seeded.binding.accountId, sessionId: seeded.binding.sessionId, localId };
        expect(await enqueuePendingMessage({ ...identity, authentication, ciphertext: "repeated-marker",
            requestedAction: { v: 1, kind: "enqueue" } })).toMatchObject({ ok: true });
        const claim = async (committedFence: Date) => await materializeNextPendingMessage({
            actorUserId: identity.actorUserId, sessionId: identity.sessionId,
            publisherAuthority: { ...seeded.binding, committedFence }, deliveryState: "provider",
            deliveryTiming: "after_foreground_ready", foregroundState: "ready" });
        // Each retiring runner claims the prompt, is replaced before native dispatch and hands it back.
        for (let replacement = 0; replacement < 2; replacement++) {
            const socket = {};
            const registered = await presence.registerPublisher({ socket, binding: seeded.binding,
                completeActivitySnapshot: { state: "idle", activeCount: 0 } });
            if (registered.status !== "registered") throw new Error("expected registration");
            expect(await claim(registered.committedFence)).toMatchObject({ ok: true, didMaterialize: true,
                message: { localId } });
            expect(await blockPendingDelivery({ ...identity, reason: "host_retired_before_dispatch" }))
                .toMatchObject({ ok: true, didUpdate: true });
            await presence.closePublisher({ socket });
        }
        const finalSocket = {};
        const final = await presence.registerPublisher({ socket: finalSocket, binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 } });
        if (final.status !== "registered") throw new Error("expected final registration");
        expect(await claim(final.committedFence)).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
        expect(await resolveAcceptedPendingDelivery({ ...identity,
            publisherAuthority: { ...seeded.binding, committedFence: final.committedFence } }))
            .toMatchObject({ ok: true, pendingCount: 0, pendingBlockedCount: 0 });
        expect(await db.sessionMessage.count({ where: { sessionId: identity.sessionId, localId } })).toBe(1);
    });

    it("contracts inherited provider delivery before successor publisher authority becomes usable", async () => {
        const seeded = await seed();
        await db.sessionPendingMessage.createMany({
            data: [{
                sessionId: seeded.binding.sessionId,
                authorAccountId: seeded.binding.accountId,
                localId: `inherited-action-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext" },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: "send",
                status: "queued",
                deliveryState: "delivering",
                position: 1,
            }, {
                sessionId: seeded.binding.sessionId,
                authorAccountId: seeded.binding.accountId,
                localId: `inherited-actionless-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext-actionless" },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: null,
                status: "queued",
                deliveryState: "delivering",
                position: 2,
            }, {
                sessionId: seeded.binding.sessionId,
                authorAccountId: seeded.binding.accountId,
                localId: `historical-disposal-${randomUUID()}`,
                content: { t: "encrypted", c: "historical-ciphertext" },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: "send",
                status: "queued",
                deliveryState: "blocked",
                deliveryBlockedReason: "runtime_disposed_before_delivery",
                position: 3,
            }],
        });
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { pendingCount: 3 },
        });
        const presence = createSessionPublisherPresence({
            now: () => new Date(seeded.fence.getTime() + 10),
        });

        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });

        expect(registered.status).toBe("registered");
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: seeded.binding.sessionId },
            orderBy: { position: "asc" },
            select: { deliveryState: true, deliveryBlockedReason: true, providerAction: true },
        })).resolves.toEqual([
            { deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain", providerAction: "send" },
            { deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain", providerAction: null },
            { deliveryState: "blocked", deliveryBlockedReason: "runtime_disposed_before_delivery", providerAction: "send" },
        ]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { pendingBlockedCount: true, pendingVersion: true, active: true },
        })).resolves.toEqual({ pendingBlockedCount: 3, pendingVersion: 1, active: true });
        const uncertain = await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: seeded.binding.sessionId },
            orderBy: { position: "asc" }, select: { localId: true } });
        expect(await blockPendingDelivery({ actorUserId: seeded.binding.accountId, sessionId: seeded.binding.sessionId,
            localId: uncertain.localId, reason: "host_retired_before_dispatch" }))
            .toEqual({ ok: false, error: "delivery-settlement-conflict" });
    });

    it("does not let a queued touch reactivate a cleanly closed publisher fence", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const closed = await presence.closePublisher({ socket });
        expect(closed.status).toBe("closed");
        await expect(presence.publishSnapshot({
            socket,
            binding: seeded.binding,
            completeSnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "superseded" });
        await expect(presence.publishSnapshot({ socket, binding: seeded.binding,
            completeSnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "superseded" });
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true },
        })).resolves.toEqual({ active: false, lastActiveAt: registered.committedFence });

        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { active: true, archivedAt: new Date() },
        });
        await expect(presence.publishSnapshot({
            socket,
            binding: seeded.binding,
            completeSnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "archived" });
        await expect(presence.publishSnapshot({ socket, binding: seeded.binding,
            completeSnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "archived" });

        await db.session.update({ where: { id: seeded.binding.sessionId }, data: { archivedAt: null } });
        const replacementMachineId = `replacement-${randomUUID()}`;
        await db.machine.create({
            data: { id: replacementMachineId, accountId: seeded.binding.accountId, metadata: "{}" },
        });
        await db.machine.update({
            where: { id: seeded.binding.machineId },
            data: { replacedByMachineId: replacementMachineId },
        });
        await expect(presence.publishSnapshot({
            socket,
            binding: seeded.binding,
            completeSnapshot: { state: "active", activeCount: 1 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await expect(presence.publishSnapshot({ socket, binding: seeded.binding,
            completeSnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
    });

    it("projects unknown on an exact current disconnect without clearing reachability or a successor baseline", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessor = {};
        const first = await presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected registration");

        const disconnected = await presence.forgetDisconnectedPublisher({ socket: predecessor });
        expect(disconnected.status).toBe("applied");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, runtimeActivityState: true, runtimeActivityRevision: true },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: first.committedFence,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: 2n,
        });

        now = new Date(first.committedFence.getTime() + 10);
        const successorSocket = {};
        const successor = await presence.registerPublisher({
            socket: successorSocket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (successor.status !== "registered") throw new Error("expected successor registration");
        await expect(presence.forgetDisconnectedPublisher({ socket: predecessor })).resolves.toEqual({ status: "unregistered" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, runtimeActivityState: true },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: successor.committedFence,
            runtimeActivityState: "idle",
        });
    });

    it("does not report badge attention changes for reachability-only register and close transactions", async () => {
        const seeded = await seed();
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { seq: 2 },
        });
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};

        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        expect(registered.badgeAttentionChanged).toBe(false);
        expect(registered.recipientCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

        const closed = await presence.closePublisher({ socket });
        if (closed.status !== "closed") throw new Error("expected close");
        expect(closed.badgeAttentionChanged).toBe(false);
        expect(closed.recipientCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

        const successorSocket = {};
        const successor = await presence.registerPublisher({
            socket: successorSocket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (successor.status !== "registered") throw new Error("expected successor registration");

        await expect(presence.closePublisher({ socket })).resolves.toEqual({
            status: "closed_replay",
            activeAt: closed.activeAt,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: successor.committedFence,
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 1,
        });
    });

    it("expires an exact fence with full cursors and no badge change while leaving Activity byte-identical", async () => {
        const seeded = await seed();
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { seq: 2 },
        });
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const activityBefore = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });

        const [expired] = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        });
        expect(expired?.status).toBe("expired");
        if (expired?.status !== "expired") throw new Error("expected expiry");
        expect(expired.badgeAttentionChanged).toBe(false);
        expect(expired.recipientCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
        expect(expired.recipientCursors).toEqual(await db.accountChange.findMany({
            where: { kind: "session", entityId: seeded.binding.sessionId },
            orderBy: { accountId: "asc" },
            select: { accountId: true, cursor: true },
        }));
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({ active: false, ...activityBefore });

        await expect(expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        })).resolves.toEqual([{ status: "stale", sessionId: seeded.binding.sessionId }]);
    });

    it("recovers the same still-open publisher after timeout without changing Activity or reviving a replaced socket", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const activityBeforeTimeout = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });

        const [expired] = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        });
        expect(expired?.status).toBe("expired");
        await expect(db.machine.findUniqueOrThrow({
            where: { id: seeded.binding.machineId },
            select: { revokedAt: true },
        })).resolves.toEqual({ revokedAt: null });
        expect(await db.accessKey.count({
            where: {
                accountId: seeded.binding.accountId,
                machineId: seeded.binding.machineId,
                sessionId: seeded.binding.sessionId,
            },
        })).toBe(1);

        now = new Date(registered.committedFence.getTime() + 20);
        const recovered = await presence.touchPublisher({ socket });
        expect(recovered.status).toBe("touched");
        if (recovered.status !== "touched") throw new Error("expected same-socket timeout recovery");
        expect(recovered.committedFence.getTime()).toBeGreaterThan(registered.committedFence.getTime());
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: recovered.committedFence,
            ...activityBeforeTimeout,
        });

        now = new Date(recovered.committedFence.getTime() + 20);
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (successor.status !== "registered") throw new Error("expected replacement registration");
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
    });

    it("writes unknown when the exact still-current socket disconnects after timeout", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        });

        const disconnected = await presence.forgetDisconnectedPublisher({ socket });
        expect(disconnected.status).toBe("applied");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: registered.committedFence,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: 2n,
        });
    });

    it.each([
        { initial: { state: "idle", activeCount: 0 } as const, expectedState: "idle", expectedRevision: 1n },
        { initial: { state: "active", activeCount: 1 } as const, expectedState: "unknown", expectedRevision: 2n },
    ])("clean close preserves only a durably published idle projection ($expectedState)", async ({ initial, expectedState, expectedRevision }) => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: initial,
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const closed = await presence.closePublisher({ socket });
        expect(closed.status).toBe("closed");
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await presence.forgetDisconnectedPublisher({ socket });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: expectedState,
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: expectedRevision,
        });
    });

    it("closes the exact active publisher after an explicit machine stop proves physical termination", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        expect(captured.status).toBe("captured");
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");

        const closed = await presence.finalizeExplicitMachineStop({ target: captured.target });
        expect(closed.status).toBe("closed");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: registered.committedFence,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
        });
    });

    it("reports unavailable machine control when the session is not bound to that machine", async () => {
        const seeded = await seed();
        await db.accessKey.deleteMany({
            where: {
                accountId: seeded.binding.accountId,
                machineId: seeded.binding.machineId,
                sessionId: seeded.binding.sessionId,
            },
        });

        const presence = createSessionPublisherPresence();
        await expect(presence.captureExplicitMachineStop({ binding: seeded.binding })).resolves.toEqual({
            status: "rejected",
            reason: "machine_control_unavailable",
        });

        const socket = createFakeSocket({ data: {
            clientType: "machine-scoped",
            machineId: seeded.binding.machineId,
        } });
        // FakeSocket models only the Socket.IO transport; admission and storage stay real.
        machineUpdateHandler(seeded.binding.accountId, socket as unknown as Socket, {
            operationSocketBatchLimits: {
                ok: true,
                limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            },
            sessionPublisherPresence: presence,
        });
        const callback = vi.fn();
        await getSocketHandler(socket, MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1)(
            { v: 1, sessionId: seeded.binding.sessionId },
            callback,
        );
        expect(MachineSessionTerminalCaptureResponseV1Schema.parse(callback.mock.calls[0]?.[0])).toEqual({
            v: 1,
            status: "rejected",
            sessionId: seeded.binding.sessionId,
            reason: "unauthorized",
        });
    });

    it("lets a proven explicit stop close the captured publisher after its heartbeat advances", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");
        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        expect(touched.status).toBe("touched");
        if (touched.status !== "touched") throw new Error("expected touch");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                publisherGeneration: true,
                publisherGenerationLastActiveAt: true,
            },
        })).resolves.toEqual({
            publisherGeneration: registered.publisherGeneration,
            publisherGenerationLastActiveAt: touched.committedFence,
        });

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toMatchObject({ status: "closed" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: false });
    });

    it("does not let a terminalized publisher heartbeat reactivate the session", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toMatchObject({ status: "closed" });
        now = new Date(registered.committedFence.getTime() + 10);
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true },
        })).resolves.toEqual({ active: false });
    });

    it("keeps a timeout-recoverable publisher terminal after the captured daemon proof arrives", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const captured = await presence.captureMachineSessionTerminal({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected machine-terminal capture");

        await expect(expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        })).resolves.toMatchObject([{ status: "expired" }]);
        await expect(presence.finalizeMachineSessionTerminal({ target: captured.target }))
            .resolves.toEqual({ status: "already_inactive" });
        now = new Date(registered.committedFence.getTime() + 10);
        await expect(presence.touchPublisher({ socket })).resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, publisherGenerationLastActiveAt: true },
        })).resolves.toEqual({ active: false, publisherGenerationLastActiveAt: null });
    });

    it("keeps an exact-heartbeat fallback for a publisher registered by an older server", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence();
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { active: true },
        });

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        expect(captured).toMatchObject({
            status: "captured",
            target: {
                authority: { kind: "legacy-heartbeat", committedFence: seeded.fence },
            },
        });
        if (captured.status !== "captured") throw new Error("expected legacy capture");

        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { lastActiveAt: new Date(seeded.fence.getTime() + 1) },
        });
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toEqual({ status: "superseded" });
    });

    it("does not let a completed generation stop close a later old-server publisher", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toMatchObject({ status: "closed" });

        const oldServerFence = new Date(registered.committedFence.getTime() + 10);
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { active: true, lastActiveAt: oldServerFence },
        });
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toEqual({ status: "superseded" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true },
        })).resolves.toEqual({ active: true, lastActiveAt: oldServerFence });
    });

    it("makes a duplicate exact-fence machine terminal finalize a no-op", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const captured = await presence.captureMachineSessionTerminal({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected machine-terminal capture");

        await expect(presence.finalizeMachineSessionTerminal({ target: captured.target }))
            .resolves.toMatchObject({ status: "closed" });
        const afterFirst = await db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                seq: true,
                runtimeActivityRevision: true,
                active: true,
            },
        });

        await expect(presence.finalizeMachineSessionTerminal({ target: captured.target }))
            .resolves.toEqual({ status: "already_inactive" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                seq: true,
                runtimeActivityRevision: true,
                active: true,
            },
        })).resolves.toEqual(afterFirst);
    });

    it.each(["explicit_stop", "process_terminal"] as const)(
        "atomically revokes an ephemeral Runner binding through canonical %s finalization",
        async (kind) => {
            const seeded = await seedEphemeralRunner();
            const presence = createSessionPublisherPresence({
                now: () => new Date(seeded.fence.getTime() + 10),
            });
            const registered = await presence.registerPublisher({
                socket: {},
                binding: seeded.binding,
                completeActivitySnapshot: { state: "active", activeCount: 1 },
            });
            if (registered.status !== "registered") throw new Error("expected registration");

            const captured = kind === "explicit_stop"
                ? await presence.captureExplicitMachineStop({ binding: seeded.binding })
                : await presence.captureMachineSessionTerminal({ binding: seeded.binding });
            if (captured.status !== "captured") throw new Error("expected terminal capture");

            const closed = kind === "explicit_stop"
                ? await presence.finalizeExplicitMachineStop({ target: captured.target })
                : await presence.finalizeMachineSessionTerminal({ target: captured.target });
            expect(closed).toMatchObject({ status: "closed" });

            const machine = await db.machine.findUniqueOrThrow({
                where: { id: seeded.binding.machineId },
                select: { active: true, revokedAt: true },
            });
            expect(machine).toMatchObject({ active: false, revokedAt: expect.any(Date) });
            expect(await db.accessKey.count({
                where: {
                    accountId: seeded.binding.accountId,
                    machineId: seeded.binding.machineId,
                    sessionId: seeded.binding.sessionId,
                },
            })).toBe(0);
            expect(await db.session.findUniqueOrThrow({
                where: { id: seeded.binding.sessionId },
                select: { active: true },
            })).toEqual({ active: false });

            const repeated = kind === "explicit_stop"
                ? await presence.finalizeExplicitMachineStop({ target: captured.target })
                : await presence.finalizeMachineSessionTerminal({ target: captured.target });
            expect(repeated).toEqual({ status: "already_inactive" });
            expect((await db.machine.findUniqueOrThrow({
                where: { id: seeded.binding.machineId },
                select: { revokedAt: true },
            })).revokedAt).toEqual(machine.revokedAt);
        },
    );

    it("keeps the exact ephemeral Runner binding recoverable when temporary presence expiry wins", async () => {
        const seeded = await seedEphemeralRunner();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const [expired] = await expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        });
        expect(expired?.status).toBe("expired");

        await expect(db.machine.findUniqueOrThrow({
            where: { id: seeded.binding.machineId },
            select: { revokedAt: true },
        })).resolves.toEqual({ revokedAt: null });
        expect(await db.accessKey.count({
            where: {
                accountId: seeded.binding.accountId,
                machineId: seeded.binding.machineId,
                sessionId: seeded.binding.sessionId,
            },
        })).toBe(1);

        // Presence loss is reachability only: the same still-current publisher can
        // reconnect without acquiring a replacement Machine or AccessKey.
        now = new Date(registered.committedFence.getTime() + 20);
        const recovered = await presence.touchPublisher({ socket });
        expect(recovered.status).toBe("touched");
        if (recovered.status !== "touched") throw new Error("expected same Runner publisher recovery");
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { active: true, lastActiveAt: true, archivedAt: true },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: recovered.committedFence,
            archivedAt: null,
        });

        // A normal reconnect registration is likewise admitted by the retained
        // exact binding and supersedes the old socket through the existing fence.
        const reconnected = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(reconnected.status).toBe("registered");

        await expect(db.machine.findUniqueOrThrow({
            where: { id: seeded.binding.machineId },
            select: { revokedAt: true },
        })).resolves.toEqual({ revokedAt: null });
        expect(await db.accessKey.count({
            where: {
                accountId: seeded.binding.accountId,
                machineId: seeded.binding.machineId,
                sessionId: seeded.binding.sessionId,
            },
        })).toBe(1);
    });

    it.each(["explicit_stop", "process_terminal"] as const)(
        "still durably revokes an ephemeral Runner when canonical %s evidence arrives after presence expiry",
        async (kind) => {
            const seeded = await seedEphemeralRunner();
            const presence = createSessionPublisherPresence({
                now: () => new Date(seeded.fence.getTime() + 10),
            });
            const registered = await presence.registerPublisher({
                socket: {},
                binding: seeded.binding,
                completeActivitySnapshot: { state: "active", activeCount: 1 },
            });
            if (registered.status !== "registered") throw new Error("expected registration");

            await expect(expireSessionPublisherCandidates({
                candidates: [{
                    sessionId: seeded.binding.sessionId,
                    observedFence: registered.committedFence,
                }],
            })).resolves.toMatchObject([{ status: "expired" }]);

            const captured = kind === "explicit_stop"
                ? await presence.captureExplicitMachineStop({ binding: seeded.binding })
                : await presence.captureMachineSessionTerminal({ binding: seeded.binding });
            expect(captured.status).toBe("captured");
            if (captured.status !== "captured") throw new Error("expected terminal capture after timeout");

            const closed = kind === "explicit_stop"
                ? await presence.finalizeExplicitMachineStop({ target: captured.target })
                : await presence.finalizeMachineSessionTerminal({ target: captured.target });
            expect(closed).toEqual({ status: "already_inactive" });
            await expect(db.machine.findUniqueOrThrow({
                where: { id: seeded.binding.machineId },
                select: { active: true, revokedAt: true },
            })).resolves.toEqual({ active: false, revokedAt: expect.any(Date) });
            expect(await db.accessKey.count({
                where: {
                    accountId: seeded.binding.accountId,
                    machineId: seeded.binding.machineId,
                    sessionId: seeded.binding.sessionId,
                },
            })).toBe(0);
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.binding.sessionId },
                select: { active: true, archivedAt: true },
            })).resolves.toEqual({ active: false, archivedAt: null });
        },
    );

    it("does not let machine terminal finalize select a newer latest turn", async () => {
        const seeded = await seed();
        const oldTurnId = `turn-old-${randomUUID()}`;
        const newerTurnId = `turn-new-${randomUUID()}`;
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        await expect(applySessionTurnMutation({
            actorUserId: seeded.binding.accountId,
            authentication,
            mutation: {
                v: 1,
                sessionId: seeded.binding.sessionId,
                mutationId: `begin-old-${randomUUID()}`,
                action: "begin",
                turnId: oldTurnId,
                observedAt: registered.committedFence.getTime() + 1,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        const captured = await presence.captureMachineSessionTerminal({
            binding: seeded.binding,
        });
        if (captured.status !== "captured") throw new Error("expected machine-terminal capture");
        await expect(applySessionTurnMutation({
            actorUserId: seeded.binding.accountId,
            authentication,
            mutation: {
                v: 1,
                sessionId: seeded.binding.sessionId,
                mutationId: `end-old-${randomUUID()}`,
                action: "end_session",
                turnId: oldTurnId,
                observedAt: registered.committedFence.getTime() + 2,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(applySessionTurnMutation({
            actorUserId: seeded.binding.accountId,
            authentication,
            mutation: {
                v: 1,
                sessionId: seeded.binding.sessionId,
                mutationId: `begin-new-${randomUUID()}`,
                action: "begin",
                turnId: newerTurnId,
                observedAt: registered.committedFence.getTime() + 3,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                latestTurnId: true,
                latestTurnStatus: true,
                thinking: true,
            },
        })).resolves.toEqual({
            latestTurnId: newerTurnId,
            latestTurnStatus: "in_progress",
            thinking: true,
        });
        now = new Date(registered.committedFence.getTime() + 20);

        await expect(presence.finalizeMachineSessionTerminal({
            target: captured.target,
        })).resolves.toMatchObject({ status: "closed" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                latestTurnId: true,
                latestTurnStatus: true,
                thinking: true,
            },
        })).resolves.toEqual({
            active: false,
            latestTurnId: newerTurnId,
            latestTurnStatus: "in_progress",
            thinking: true,
        });
    });

    it("does not let a completed explicit stop close a successor publisher that registered meanwhile", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const first = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected first registration");

        const captured = await presence.captureExplicitMachineStop({ binding: seeded.binding });
        if (captured.status !== "captured") throw new Error("expected explicit-stop capture");

        now = new Date(first.committedFence.getTime() + 10);
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (successor.status !== "registered") throw new Error("expected successor registration");

        await expect(presence.finalizeExplicitMachineStop({ target: captured.target })).resolves.toEqual({
            status: "superseded",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        })).resolves.toEqual({
            active: true,
            lastActiveAt: successor.committedFence,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
        });
    });

    it("makes a touch winner and concurrent timeout loser produce no timeout cursors", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        if (touched.status !== "touched") throw new Error("expected touch");

        await expect(expireSessionPublisherCandidates({
            candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }],
        })).resolves.toEqual([{ status: "stale", sessionId: seeded.binding.sessionId }]);
    });

    it("lets only one of two timeout owners expire the same exact fence", async () => {
        const seeded = await seed();
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const registered = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");

        const results = await Promise.all([
            expireSessionPublisherCandidates({ candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }] }),
            expireSessionPublisherCandidates({ candidates: [{ sessionId: seeded.binding.sessionId, observedFence: registered.committedFence }] }),
        ]);
        expect(results.flat().map(({ status }) => status).sort()).toEqual(["expired", "stale"]);
        const expired = results.flat().find((result) => result.status === "expired");
        if (!expired || expired.status !== "expired") throw new Error("expected exactly one expiry");
        expect(expired.recipientCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
    });

    it("projects the exact committed publisher authority onto socket data after register and touch", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = { data: {} as Record<string, unknown> };

        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        expect(socket.data.sessionPublisherAuthority).toEqual({
            v: 1,
            ...seeded.binding,
            committedFenceMs: registered.committedFence.getTime(),
            publisherGeneration: registered.publisherGeneration.toString(),
        });

        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        if (touched.status !== "touched") throw new Error("expected touch");
        expect(socket.data.sessionPublisherAuthority).toEqual({
            v: 1,
            ...seeded.binding,
            committedFenceMs: touched.committedFence.getTime(),
            publisherGeneration: registered.publisherGeneration.toString(),
        });
    });

    it("keeps the Session Action target current when its publisher heartbeat advances during socket discovery", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = { data: {} as Record<string, unknown> };
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        let currentFence = registered.committedFence;
        // Socket.IO discovery crosses an asynchronous transport boundary. Its
        // captured data can arrive after this same publisher's next heartbeat.
        const io = {
            in: () => ({
                fetchSockets: async () => {
                    const capturedData = structuredClone(socket.data);
                    now = new Date(registered.committedFence.getTime() + 10);
                    const touched = await presence.touchPublisher({ socket });
                    if (touched.status !== "touched") throw new Error("expected heartbeat");
                    currentFence = touched.committedFence;
                    return [{ data: capturedData }];
                },
            }),
        } as unknown as Server;

        const resolved = await resolveCurrentSessionPublisherFromServer({
            io, presence, accountId: seeded.binding.accountId, sessionId: seeded.binding.sessionId,
        });
        expect(resolved).toEqual({ ...seeded.binding, committedFence: currentFence });
    });

    it.each(["closed", "archived", "access_withdrawn", "legacy_heartbeat", "machine_retired", "machine_replaced", "forged_generation", "malformed_generation"] as const)(
        "refuses the discovered Session Action publisher after %s",
        async (change) => {
            const seeded = await seed();
            const now = new Date(seeded.fence.getTime() + 10);
            const presence = createSessionPublisherPresence({ now: () => now });
            const socket = { data: {} as Record<string, unknown> };
            const registered = await presence.registerPublisher({
                socket, binding: seeded.binding, completeActivitySnapshot: { state: "idle", activeCount: 0 },
            });
            if (registered.status !== "registered") throw new Error("expected registration");
            const capturedData = structuredClone(socket.data);
            if (change === "closed") {
                expect(await presence.closePublisher({ socket })).toMatchObject({ status: "closed" });
            } else if (change === "access_withdrawn") {
                await db.accessKey.deleteMany({ where: seeded.binding });
            } else if (change === "machine_retired") {
                await db.machine.update({ where: { id: seeded.binding.machineId }, data: { revokedAt: now } });
            } else if (change === "machine_replaced") {
                const replacementId = `${seeded.binding.machineId}-replacement`;
                await db.machine.create({ data: { id: replacementId, accountId: seeded.binding.accountId, metadata: "{}" } });
                await db.machine.update({ where: { id: seeded.binding.machineId }, data: { replacedByMachineId: replacementId } });
            } else if (change === "forged_generation" || change === "malformed_generation") {
                const projection = readSessionPublisherAuthorityProjection(capturedData);
                if (!projection) throw new Error("expected server-written projection");
                capturedData.sessionPublisherAuthority = {
                    ...projection,
                    publisherGeneration: change === "forged_generation"
                        ? (registered.publisherGeneration + 1n).toString()
                        : "01",
                };
            } else {
                await db.session.update({
                    where: { id: seeded.binding.sessionId },
                    data: change === "archived"
                        ? { archivedAt: now }
                        : { lastActiveAt: new Date(now.getTime() + 10) },
                });
            }
            const io = { in: () => ({ fetchSockets: async () => [{ data: capturedData }] }) } as unknown as Server;
            await expect(resolveCurrentSessionPublisherFromServer({
                io, presence, accountId: seeded.binding.accountId, sessionId: seeded.binding.sessionId,
            })).resolves.toBeNull();
        },
    );

    it("rejects a projected publisher that is stale before the guarded effect", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessor = { data: {} as Record<string, unknown> };
        const successor = { data: {} as Record<string, unknown> };
        const first = await presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected predecessor registration");
        const initialProjection = predecessor.data.sessionPublisherAuthority;

        now = new Date(first.committedFence.getTime() + 10);
        const replacement = await presence.registerPublisher({
            socket: successor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (replacement.status !== "registered") throw new Error("expected successor registration");
        const operation = vi.fn(async () => "must-not-run");

        await expect(presence.runAsProjectedCurrentPublisher({
            expectedAccountId: seeded.binding.accountId,
            expectedSessionId: seeded.binding.sessionId,
            initialProjection,
            readLatestProjection: async () => predecessor.data.sessionPublisherAuthority,
            operation,
        })).resolves.toEqual({ status: "unavailable" });
        expect(operation).not.toHaveBeenCalled();
    });

    it("suppresses a guarded result when a successor publisher wins during the effect", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const predecessor = { data: {} as Record<string, unknown> };
        const successor = { data: {} as Record<string, unknown> };
        const first = await presence.registerPublisher({
            socket: predecessor,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (first.status !== "registered") throw new Error("expected predecessor registration");
        const initialProjection = predecessor.data.sessionPublisherAuthority;
        const effect = vi.fn(async () => {
            now = new Date(first.committedFence.getTime() + 10);
            const replacement = await presence.registerPublisher({
                socket: successor,
                binding: seeded.binding,
                completeActivitySnapshot: { state: "idle", activeCount: 0 },
            });
            if (replacement.status !== "registered") throw new Error("expected successor registration");
            return { ok: true, status: "applied" } as const;
        });

        await expect(presence.runAsProjectedCurrentPublisher({
            expectedAccountId: seeded.binding.accountId,
            expectedSessionId: seeded.binding.sessionId,
            initialProjection,
            readLatestProjection: async () => predecessor.data.sessionPublisherAuthority,
            operation: effect,
        })).resolves.toEqual({ status: "unavailable" });
        expect(effect).toHaveBeenCalledTimes(1);
    });

    it("accepts a guarded result when the same socket heartbeat advances its trusted fence", async () => {
        const seeded = await seed();
        let now = new Date(seeded.fence.getTime() + 10);
        const presence = createSessionPublisherPresence({ now: () => now });
        const socket = { data: {} as Record<string, unknown> };
        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        const initialProjection = socket.data.sessionPublisherAuthority;
        const exactResult = {
            ok: false,
            status: "restart_required",
            reason: "exact-result",
        } as const;

        await expect(presence.runAsProjectedCurrentPublisher({
            expectedAccountId: seeded.binding.accountId,
            expectedSessionId: seeded.binding.sessionId,
            initialProjection,
            readLatestProjection: async () => socket.data.sessionPublisherAuthority,
            operation: async () => {
                now = new Date(registered.committedFence.getTime() + 10);
                const touched = await presence.touchPublisher({ socket });
                if (touched.status !== "touched") throw new Error("expected touch");
                return exactResult;
            },
        })).resolves.toEqual({ status: "current", value: exactResult });
    });
});
