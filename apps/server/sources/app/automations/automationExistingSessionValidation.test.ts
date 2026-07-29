import { describe, expect, it, vi } from "vitest";

import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";

describe("validateExistingSessionAutomationTargetTx", () => {
    it("fails typed when only a split owner envelope can prove resumability", async () => {
        const sessionFindFirst = vi.fn(async () => ({
            id: "session-1",
            encryptionMode: "plain",
            metadata: JSON.stringify({
                v: 1,
                summary: { text: "Safe title", updatedAt: 1 },
            }),
            metadataLayoutVersion: 1,
            ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
        }));
        const accountFindUnique = vi.fn(async () => ({ settings: null }));
        const tx = {
            session: { findFirst: sessionFindFirst },
            account: { findUnique: accountFindUnique },
        };

        await expect(validateExistingSessionAutomationTargetTx({
            tx: tx as any,
            accountId: "owner",
            targetType: "existing_session",
            templateCiphertext: JSON.stringify({ existingSessionId: "session-1" }),
        })).rejects.toThrow("existing session target owner metadata is unavailable");

        expect(sessionFindFirst).toHaveBeenCalledWith({
            where: {
                id: "session-1",
                accountId: "owner",
            },
            select: {
                id: true,
                encryptionMode: true,
                metadata: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
            },
        });
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("fails typed for an unsupported future layout before shared metadata can grant resume authority", async () => {
        const sessionFindFirst = vi.fn(async () => ({
            id: "session-1",
            encryptionMode: "plain",
            metadata: JSON.stringify({
                flavor: "pi",
                piSessionId: "recipient-visible-id",
            }),
            metadataLayoutVersion: 2,
            ownerMetadata: "recipient-visible-owner-placeholder",
        }));
        const accountFindUnique = vi.fn(async () => ({ settings: null }));

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
                account: { findUnique: accountFindUnique },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            templateCiphertext: JSON.stringify({ existingSessionId: "session-1" }),
        })).rejects.toThrow("existing session target metadata privacy upgrade required");

        expect(accountFindUnique).not.toHaveBeenCalled();
    });
});
