import { describe, expect, it } from "vitest";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import {
    buildDeleteSessionUpdate,
    buildNewMachineUpdate,
    buildNewMessageUpdate,
    buildNewSessionUpdate,
    buildPendingChangedUpdate,
    buildPublicShareCreatedUpdate,
    buildPublicShareDeletedUpdate,
    buildPublicShareUpdatedUpdate,
    buildUpdateSessionUpdate,
    buildSessionSharedUpdate,
    buildSessionShareRevokedUpdate,
    buildSessionShareUpdatedUpdate,
} from "./eventRouter";

describe("eventRouter payloads (protocol container)", () => {
    it("buildNewMessageUpdate emits a full container", () => {
        const payload = buildNewMessageUpdate(
            {
                id: "m1",
                seq: 1,
                localId: "l1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "abc" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            "s1",
            101,
            "upd-1",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).message.messageRole).toBe("user");
        expect(Object.prototype.hasOwnProperty.call((payload.body as any).message ?? {}, "sidechainId")).toBe(false);
    });

    it("buildNewSessionUpdate emits a full container", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s1",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: new Uint8Array([1, 2, 3]),
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
                runtimeActivityState: "active",
                runtimeActivityRevision: 4n,
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(2_000),
            },
            102,
            "upd-2",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).runtimeActivityActiveCount).toBe(1);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(2_000);
    });

    it("buildNewSessionUpdate clears runtime activity timestamps when the aggregate is idle", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s-idle",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: null,
                active: false,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
                runtimeActivityState: "idle",
                runtimeActivityRevision: 5n,
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: BigInt(2_000),
            },
            102,
            "upd-idle",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).runtimeActivityActiveCount).toBe(0);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(2_000);
    });


    it("buildNewSessionUpdate rejects a malformed target projection without synthesizing unknown", () => {
        expect(() => buildNewSessionUpdate(
            {
                id: "s-malformed",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
                runtimeActivityState: null,
                runtimeActivityRevision: 9n,
                runtimeActivityActiveCount: 3,
                runtimeActivityObservedAt: 2_000n,
            },
            102,
            "upd-malformed",
        )).toThrow();
    });

    it("buildUpdateSessionUpdate rejects a partial target projection", () => {
        expect(() => buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-partial",
            undefined,
            undefined,
            {
                runtimeActivityState: "idle",
                runtimeActivityRevision: 8,
            },
        )).toThrow();
    });

    it("buildUpdateSessionUpdate rejects a negative revision instead of coercing it to the unknown baseline", () => {
        expect(() => buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-negative-revision",
            undefined,
            undefined,
            {
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: -1,
            },
        )).toThrow();
    });


    it("buildUpdateSessionUpdate emits a full container", () => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-3",
            { value: "enc-meta", version: 2 },
            { value: null, version: 3 },
            {
                active: false,
                activeAt: 222,
                lastViewedSessionSeq: 7,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: 333,
                latestReadyEventSeq: 8,
                latestReadyEventAt: 444,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 456,
                runtimeActivityState: "active",
                runtimeActivityRevision: 6,
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: 500,
                meaningfulActivityAt: 999,
                archivedAt: 123,
            },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).active).toBe(false);
        expect((payload.body as any).activeAt).toBe(222);
        expect((payload.body as any).lastViewedSessionSeq).toBe(7);
        expect((payload.body as any).pendingPermissionRequestCount).toBe(2);
        expect((payload.body as any).pendingUserActionRequestCount).toBe(1);
        expect((payload.body as any).pendingRequestObservedAt).toBe(333);
        expect((payload.body as any).latestReadyEventSeq).toBe(8);
        expect((payload.body as any).latestReadyEventAt).toBe(444);
        expect((payload.body as any).latestTurnId).toBe("turn-1");
        expect((payload.body as any).latestTurnStatus).toBe("completed");
        expect((payload.body as any).latestTurnStatusObservedAt).toBe(456);
        expect((payload.body as any).runtimeActivityActiveCount).toBe(2);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(500);
        expect((payload.body as any).meaningfulActivityAt).toBe(999);
        expect((payload.body as any).archivedAt).toBe(123);
    });

    it("buildUpdateSessionUpdate emits the target idle projection", () => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-clear",
            undefined,
            undefined,
            {
                runtimeActivityState: "idle",
                runtimeActivityRevision: 7,
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 500,
            },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).runtimeActivityActiveCount).toBe(0);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(500);
    });

    it.each([
        { state: "active" as const, count: 2, observedAt: 500 },
        { state: "unknown" as const, count: 0, observedAt: 600 },
        { state: "idle" as const, count: 0, observedAt: 700 },
    ])("buildUpdateSessionUpdate emits the target $state projection", ({ state, count, observedAt }) => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            `upd-${state}`,
            undefined,
            undefined,
            {
                runtimeActivityState: state,
                runtimeActivityRevision: 11,
                runtimeActivityActiveCount: count,
                runtimeActivityObservedAt: observedAt,
            },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect(payload.body).toMatchObject({
            runtimeActivityState: state,
            runtimeActivityRevision: 11,
            runtimeActivityActiveCount: count,
            runtimeActivityObservedAt: observedAt,
        });
    });

    it("buildDeleteSessionUpdate emits a full container", () => {
        const payload = buildDeleteSessionUpdate("s1", 104, "upd-4");
        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
    });

    it("buildPendingChangedUpdate includes exact meaningfulActivityAt when provided", () => {
        const meaningfulActivityAt = new Date("2026-06-01T12:00:00.000Z");
        const payload = buildPendingChangedUpdate(
            {
                sessionId: "s1",
                pendingVersion: 3,
                pendingCount: 1,
                meaningfulActivityAt,
                pendingActivationRequestId: "pending-local-1",
                pendingActivationAuthorization: {
                    requestId: "pending-local-1",
                    requestedAt: meaningfulActivityAt.getTime() + 1,
                    status: "waiting",
                },
            },
            105,
            "upd-5",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).sessionId).toBe("s1");
        expect((payload.body as any).meaningfulActivityAt).toBe(meaningfulActivityAt.getTime());
        expect((payload.body as any).pendingActivationRequestId).toBe("pending-local-1");
        expect((payload.body as any).pendingActivationAuthorization).toEqual({
            requestId: "pending-local-1",
            requestedAt: meaningfulActivityAt.getTime() + 1,
            status: "waiting",
        });
    });

    it("buildNewMachineUpdate emits a full container", () => {
        const payload = buildNewMachineUpdate(
            {
                id: "m1",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            106,
            "upd-6",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
    });

    it("sharing updates include sessionId + sid for compatibility", () => {
        const shared = buildSessionSharedUpdate(
            {
                id: "shr-1",
                sessionId: "s1",
                sharedByUser: { id: "u1", firstName: null, lastName: null, username: "x", avatar: null },
                accessLevel: "view",
                canApprovePermissions: true,
                encryptedDataKey: new Uint8Array([1, 2, 3]),
                createdAt: new Date(1),
            },
            106,
            "upd-6",
        );
        const updated = buildSessionShareUpdatedUpdate("shr-1", "s1", "edit", false, new Date(2), 107, "upd-7");
        const revoked = buildSessionShareRevokedUpdate("shr-1", "s1", 108, "upd-8");

        expect(UpdateContainerSchema.safeParse(shared).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(revoked).success).toBe(true);
        expect((shared.body as any).sessionId).toBe("s1");
        expect((shared.body as any).sid).toBe("s1");
        expect((shared.body as any).canApprovePermissions).toBe(true);
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).sid).toBe("s1");
        expect((updated.body as any).canApprovePermissions).toBe(false);
        expect((revoked.body as any).sessionId).toBe("s1");
        expect((revoked.body as any).sid).toBe("s1");
    });

    it("public share updates include sessionId + sid for compatibility", () => {
        const created = buildPublicShareCreatedUpdate(
            {
                id: "ps-1",
                sessionId: "s1",
                token: "tok",
                expiresAt: null,
                maxUses: null,
                isConsentRequired: false,
                createdAt: new Date(1),
            },
            109,
            "upd-9",
        );
        const updated = buildPublicShareUpdatedUpdate(
            {
                id: "ps-1",
                sessionId: "s1",
                expiresAt: null,
                maxUses: 1,
                isConsentRequired: true,
                updatedAt: new Date(2),
            },
            110,
            "upd-10",
        );
        const deleted = buildPublicShareDeletedUpdate("s1", 111, "upd-11");

        expect(UpdateContainerSchema.safeParse(created).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(deleted).success).toBe(true);
        expect((created.body as any).sessionId).toBe("s1");
        expect((created.body as any).sid).toBe("s1");
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).sid).toBe("s1");
        expect((deleted.body as any).sessionId).toBe("s1");
        expect((deleted.body as any).sid).toBe("s1");
    });
});
