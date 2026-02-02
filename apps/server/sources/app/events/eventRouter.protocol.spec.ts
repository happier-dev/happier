import { describe, expect, it } from "vitest";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import {
    buildDeleteSessionUpdate,
    buildNewMachineUpdate,
    buildNewMessageUpdate,
    buildNewSessionUpdate,
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
            },
            102,
            "upd-2",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
    });

    it("buildUpdateSessionUpdate emits a full container", () => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-3",
            { value: "enc-meta", version: 2 },
            { value: null, version: 3 },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
    });

    it("buildDeleteSessionUpdate emits a full container", () => {
        const payload = buildDeleteSessionUpdate("s1", 104, "upd-4");
        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
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
            105,
            "upd-5",
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
                encryptedDataKey: new Uint8Array([1, 2, 3]),
                createdAt: new Date(1),
            },
            106,
            "upd-6",
        );
        const updated = buildSessionShareUpdatedUpdate("shr-1", "s1", "edit", new Date(2), 107, "upd-7");
        const revoked = buildSessionShareRevokedUpdate("shr-1", "s1", 108, "upd-8");

        expect(UpdateContainerSchema.safeParse(shared).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(revoked).success).toBe(true);
        expect((shared.body as any).sessionId).toBe("s1");
        expect((shared.body as any).sid).toBe("s1");
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).sid).toBe("s1");
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
