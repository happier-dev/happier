import { describe, it, expect } from "vitest";
import {
    buildPublicShareCreatedUpdate,
    buildPublicShareDeletedUpdate,
    buildPublicShareUpdatedUpdate,
    buildSessionSharedUpdate,
    buildSessionShareUpdatedUpdate,
} from "./eventRouter";

describe("sharing event builders", () => {
    it("buildSessionSharedUpdate maps share fields and encodes encryptedDataKey as base64", () => {
        const share = {
            id: "share-1",
            sessionId: "session-1",
            sharedByUser: {
                id: "user-owner",
                firstName: "John",
                lastName: "Doe",
                username: "johndoe",
                avatar: null,
            },
            accessLevel: "view" as const,
            encryptedDataKey: new Uint8Array([1, 2, 3, 4]),
            createdAt: new Date("2025-01-09T12:00:00Z"),
        };

        const result = buildSessionSharedUpdate(share, 100, "update-id-1");
        expect(result.body).toMatchObject({
            t: "session-shared",
            shareId: "share-1",
            sharedBy: share.sharedByUser,
            accessLevel: "view",
            encryptedDataKey: Buffer.from(share.encryptedDataKey).toString("base64"),
            createdAt: share.createdAt.getTime(),
        });
    });

    it("buildSessionSharedUpdate omits encryptedDataKey when not present", () => {
        const share = {
            id: "share-1",
            sessionId: "session-1",
            sharedByUser: {
                id: "user-owner",
                firstName: "John",
                lastName: "Doe",
                username: "johndoe",
                avatar: null,
            },
            accessLevel: "view" as const,
            encryptedDataKey: null,
            createdAt: new Date("2025-01-09T12:00:00Z"),
        };

        const result = buildSessionSharedUpdate(share, 100, "update-id-1");
        expect(result.body).toMatchObject({
            t: "session-shared",
            shareId: "share-1",
            sharedBy: share.sharedByUser,
            accessLevel: "view",
            createdAt: share.createdAt.getTime(),
        });
        expect(result.body).not.toHaveProperty("encryptedDataKey");
    });

    it("buildSessionShareUpdatedUpdate maps accessLevel and updatedAt timestamp", () => {
        const updatedAt = new Date("2025-01-09T13:00:00Z");
        const result = buildSessionShareUpdatedUpdate(
            "share-1",
            "session-1",
            "edit",
            updatedAt,
            101,
            "update-id-2",
        );

        expect(result.body).toMatchObject({
            t: "session-share-updated",
            shareId: "share-1",
            accessLevel: "edit",
            updatedAt: updatedAt.getTime(),
        });
    });

    it("buildPublicShareCreatedUpdate preserves nullable expiresAt/maxUses values", () => {
        const result = buildPublicShareCreatedUpdate(
            {
                id: "public-2",
                sessionId: "session-2",
                token: "xyz789",
                expiresAt: null,
                maxUses: null,
                isConsentRequired: false,
                createdAt: new Date("2025-01-09T12:00:00Z"),
            },
            104,
            "update-id-5",
        );

        expect(result.body).toMatchObject({
            t: "public-share-created",
            publicShareId: "public-2",
            token: "xyz789",
            expiresAt: null,
            maxUses: null,
            isConsentRequired: false,
        });
    });

    it("buildPublicShareUpdatedUpdate and buildPublicShareDeletedUpdate map expected identifiers", () => {
        const updated = buildPublicShareUpdatedUpdate(
            {
                id: "public-1",
                sessionId: "session-1",
                expiresAt: new Date("2025-02-10T12:00:00Z"),
                maxUses: 200,
                isConsentRequired: false,
                updatedAt: new Date("2025-01-09T14:00:00Z"),
            },
            105,
            "update-id-6",
        );
        const deleted = buildPublicShareDeletedUpdate("session-1", 106, "update-id-7");

        expect(updated.body).toMatchObject({
            t: "public-share-updated",
            publicShareId: "public-1",
            expiresAt: new Date("2025-02-10T12:00:00Z").getTime(),
            maxUses: 200,
            isConsentRequired: false,
        });
        expect(deleted.body).toMatchObject({
            t: "public-share-deleted",
            sessionId: "session-1",
        });
    });
});
