import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    applySessionTurnMutation,
    updateSessionMetadataEnvelopeTuple,
} from "@/app/session/sessionWriteService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createSessionPublisherPresence, expireSessionPublisherCandidates } from "./sessionPublisherPresence";

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

    it("rejects a predecessor publisher tuple patch after a successor commits its fence", async () => {
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
        const predecessor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        expect(predecessor.status).toBe("registered");
        if (predecessor.status !== "registered") {
            throw new Error("expected predecessor registration");
        }
        now = new Date(predecessor.committedFence.getTime() + 10);
        const successor = await presence.registerPublisher({
            socket: {},
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(successor.status).toBe("registered");

        const stalePublisherPatch = {
            mode: "owner" as const,
            actorUserId: seeded.binding.accountId,
            sessionId: seeded.binding.sessionId,
            metadataLayoutVersion: 1 as const,
            publisherPrecondition: {
                machineId: seeded.binding.machineId,
                committedFenceMs: predecessor.committedFence.getTime(),
            },
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
            stalePublisherPatch,
        )).resolves.toEqual({
            ok: false,
            error: "publisher-superseded",
        });
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
            metadata: "shared-before",
            metadataVersion: 4,
            ownerMetadata: JSON.stringify(previousOwnerMetadata),
            agentState: "agent-before",
            agentStateVersion: 8,
            lastActiveAt:
                successor.status === "registered"
                    ? successor.committedFence
                    : expect.any(Date),
        });
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

        const closed = await presence.closePublisher({ socket: successor });
        expect(closed.status).toBe("closed");
        if (closed.status !== "closed") throw new Error("expected close");
        expect(closed.turnProjection).toMatchObject({
            latestTurnId: turnId,
            latestTurnStatus: "cancelled",
        });
        expect(closed.badgeAttentionChanged).toBe(false);
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
            }],
        });
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { pendingCount: 2 },
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
        ]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: seeded.binding.sessionId },
            select: { pendingBlockedCount: true, pendingVersion: true, active: true },
        })).resolves.toEqual({ pendingBlockedCount: 2, pendingVersion: 1, active: true });
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

    it("derives reachability badge changes in the register and close transactions", async () => {
        const seeded = await seed();
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { seq: 2, lastViewedSessionSeq: 0 },
        });
        const presence = createSessionPublisherPresence({ now: () => new Date(seeded.fence.getTime() + 10) });
        const socket = {};

        const registered = await presence.registerPublisher({
            socket,
            binding: seeded.binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error("expected registration");
        expect(registered.badgeAttentionChanged).toBe(true);
        expect(registered.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

        const closed = await presence.closePublisher({ socket });
        if (closed.status !== "closed") throw new Error("expected close");
        expect(closed.badgeAttentionChanged).toBe(true);
        expect(closed.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);

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

    it("expires an exact fence with full cursors and badge evidence while leaving Activity byte-identical", async () => {
        const seeded = await seed();
        await db.session.update({
            where: { id: seeded.binding.sessionId },
            data: { seq: 2, lastViewedSessionSeq: 0 },
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
        expect(expired.badgeAttentionChanged).toBe(true);
        expect(expired.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
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
        expect(expired.participantCursors.map(({ accountId }) => accountId).sort()).toEqual(seeded.participantIds);
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
        });

        now = new Date(registered.committedFence.getTime() + 10);
        const touched = await presence.touchPublisher({ socket });
        if (touched.status !== "touched") throw new Error("expected touch");
        expect(socket.data.sessionPublisherAuthority).toEqual({
            v: 1,
            ...seeded.binding,
            committedFenceMs: touched.committedFence.getTime(),
        });
    });

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
