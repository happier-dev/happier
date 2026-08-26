import { describe, expect, it, vi } from "vitest";

import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";

describe("validateExistingSessionAutomationTargetTx", () => {
    it("rejects a non-canonical existing-session envelope before reading Session state", async () => {
        const sessionFindFirst = vi.fn();

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            templateCiphertext: JSON.stringify({
                kind: "unknown_template_envelope",
                existingSessionId: "session-1",
            }),
        })).rejects.toThrow("existing_session automation template envelope is invalid");

        expect(sessionFindFirst).not.toHaveBeenCalled();
    });

    it("does not disclose encrypted existing-session target contents to the server", async () => {
        const sessionFindFirst = vi.fn();

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "e2ee",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_encrypted_v1",
                payloadCiphertext: "ciphertext",
            }),
        })).resolves.toBeUndefined();

        expect(sessionFindFirst).not.toHaveBeenCalled();
    });

    it("fails typed when layout one stores a non-canonical split owner envelope", async () => {
        const sessionFindFirst = vi.fn(async () => ({
            id: "session-1",
            encryptionMode: "plain",
            metadata: JSON.stringify({
                v: 1,
                summary: { text: "Safe title", updatedAt: 1 },
            }),
            metadataLayoutVersion: 1,
            ownerMetadata: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
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
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { existingSessionId: "session-1" },
            }),
        })).rejects.toThrow("existing session target metadata privacy upgrade required");

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
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { existingSessionId: "session-1" },
            }),
        })).rejects.toThrow("existing session target metadata privacy upgrade required");

        expect(accountFindUnique).not.toHaveBeenCalled();
    });
});
