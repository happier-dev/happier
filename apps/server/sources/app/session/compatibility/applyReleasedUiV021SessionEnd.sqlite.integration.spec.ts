import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { db } from "@/storage/db";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";


import { applyReleasedUiV021SessionEnd } from "./applyReleasedUiV021SessionEnd";
import { registerReleasedUiV021SessionEndSocketEvent } from "./registerReleasedUiV021SessionEndSocketEvent";

describe("released UI v0.2.1 Stop lifecycle compatibility", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-released-ui-stop-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("delivers the authoritative Stop projection to the initiating UI connection", async () => {
        const owner = await db.account.create({ data: { publicKey: `owner-${randomUUID()}` } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
                active: true,
                lastActiveAt: new Date(1_000),
            },
        });
        const emit = vi.fn();
        const handlers = new Map<string, (raw: unknown) => void>();
        // Socket.IO is the external transport boundary; the real event router decides delivery.
        const socket = {
            emit,
            data: {},
            on: (event: string, handler: (raw: unknown) => void) => { handlers.set(event, handler); },
        } as unknown as Socket;
        const connection: ClientConnection = { connectionType: "user-scoped", userId: owner.id, socket };
        eventRouter.addConnection(owner.id, connection);
        try {
            registerReleasedUiV021SessionEndSocketEvent({
                socket,
                accountId: owner.id,
                now: () => 2_000,
            });
            handlers.get("session-end")?.({ sid: session.id, time: 2_000 });
            await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({
                body: expect.objectContaining({ t: "update-session", id: session.id, active: false }),
            })));
        } finally {
            eventRouter.removeConnection(owner.id, connection);
        }
    });

    it("settles the current turn, publisher lifecycle, and Runtime Activity exactly once for the owner", async () => {
        const owner = await db.account.create({ data: { publicKey: `owner-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `other-${randomUUID()}` } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
                active: true,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: new Date(1_000),
                lastActiveAt: new Date(1_000),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(1_000),
                runtimeActivityRevision: BigInt(1),
            },
        });
        await expect(applySessionTurnMutation({
            actorUserId: owner.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId: "turn-1",
                observedAt: 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        await expect(applyReleasedUiV021SessionEnd({
            accountId: other.id,
            sessionId: session.id,
            observedAt: 2_000,
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        const emittedUpdates = vi.spyOn(eventRouter, "emitUpdate");
        await expect(applyReleasedUiV021SessionEnd({
            accountId: owner.id,
            sessionId: session.id,
            observedAt: 2_000,
        })).resolves.toEqual({ status: "applied" });
        await expect(applyReleasedUiV021SessionEnd({
            accountId: owner.id,
            sessionId: session.id,
            observedAt: 2_000,
        })).resolves.toEqual({ status: "unchanged" });

        expect(emittedUpdates).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    latestTurnStatus: "cancelled",
                }),
            }),
        }));
        emittedUpdates.mockRestore();
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                active: true,
                lastActiveAt: true,
                latestTurnStatus: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
                pendingRequestObservedAt: true,
            },
        })).resolves.toEqual({
            active: false,
            lastActiveAt: new Date(2_000),
            latestTurnStatus: "cancelled",
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: BigInt(2),
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: new Date(1_000),
        });
    });
});
