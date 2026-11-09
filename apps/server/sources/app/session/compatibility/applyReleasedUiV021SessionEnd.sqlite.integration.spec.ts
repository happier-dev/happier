import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { readSessionUsageAccountingChangedV1 } from "@happier-dev/protocol/changes";
import { UpdateBodySchema } from "@happier-dev/protocol";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { applyReleasedUiV021SessionEnd } from "./applyReleasedUiV021SessionEnd";

const authentication = createPresentUserSessionAccessAuthentication();

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

    afterAll(async () => harness.close());

    it("settles the current turn, publisher lifecycle, and Runtime Activity exactly once for the owner", async () => {
        // A Session-owning Account is current: terminal turn settlement takes
        // the canonical Account transition fence.
        const owner = await db.account.create({
            data: { publicKey: `owner-${randomUUID()}`, encryptionMode: "plain" },
        });
        const other = await db.account.create({
            data: { publicKey: `other-${randomUUID()}`, encryptionMode: "plain" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
                active: true,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: new Date(1_500),
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
            authentication,
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const beforeStop = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });

        const { createAuthenticatedFakeSocket } = await import("@/app/api/testkit/socketHarness");
        const socket = createAuthenticatedFakeSocket();
        const connection: ClientConnection = {
            connectionType: "user-scoped", userId: owner.id,
            // The canonical fake replaces only the Socket.IO network endpoint.
            socket: socket as unknown as Socket,
        };
        const observer = createAuthenticatedFakeSocket({ id: "observer-socket" });
        const observerConnection: ClientConnection = {
            ...connection,
            socket: observer as unknown as Socket,
        };
        eventRouter.addConnection(owner.id, connection);
        eventRouter.addConnection(owner.id, observerConnection);
        const updates = vi.spyOn(eventRouter, "emitUpdate");
        try {
            await expect(applyReleasedUiV021SessionEnd({
                accountId: other.id,
                sessionId: session.id,
                observedAt: 2_000,
            })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
            await expect(applyReleasedUiV021SessionEnd({
                accountId: owner.id,
                sessionId: session.id,
                observedAt: 2_000,
                connection,
            })).resolves.toEqual({ status: "applied" });
            await expect(applyReleasedUiV021SessionEnd({
                accountId: owner.id,
                sessionId: session.id,
                observedAt: 2_000,
            })).resolves.toEqual({ status: "unchanged" });

            const stoppedChange = await db.accountChange.findFirstOrThrow({
                where: { accountId: owner.id, kind: "session", entityId: session.id },
                select: { kind: true, cursor: true, hint: true },
            });
            expect(readSessionUsageAccountingChangedV1(stoppedChange, beforeStop.seq)).toBe(false);
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: {
                    active: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    pendingRequestObservedAt: true,
                    lastActiveAt: true,
                    latestTurnStatus: true,
                    runtimeActivityState: true,
                    runtimeActivityActiveCount: true,
                    runtimeActivityRevision: true,
                },
            })).resolves.toEqual({
                active: false,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: new Date(1_500),
                lastActiveAt: new Date(2_000),
                latestTurnStatus: "cancelled",
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: BigInt(2),
            });
            await Promise.all(updates.mock.results.map(result => result.type === "return" ? result.value : undefined));
            const observerUpdates = observer.emit.mock.calls
                .filter(([event, payload]) => event === "update" && payload.body?.latestTurnStatus === "cancelled");
            expect(observerUpdates).toHaveLength(1);
            const terminalUpdates = socket.emit.mock.calls
                .filter(([event, payload]) => event === "update" && payload.body?.latestTurnStatus === "cancelled");
            expect(terminalUpdates).toHaveLength(1);
            const body = UpdateBodySchema.parse(terminalUpdates[0]![1].body);
            expect(body).not.toHaveProperty("pendingPermissionRequestCount");
            expect(body).not.toHaveProperty("pendingUserActionRequestCount");
            expect(body).not.toHaveProperty("pendingRequestObservedAt");
        } finally {
            updates.mockRestore();
            eventRouter.removeConnection(owner.id, connection);
            eventRouter.removeConnection(owner.id, observerConnection);
        }
    });
});
