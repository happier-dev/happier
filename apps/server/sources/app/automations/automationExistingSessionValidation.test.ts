import { describe, expect, it, vi } from "vitest";

import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";

/**
 * Canonical layout-one owner ciphertext fixture: account-scoped blob v1 magic
 * byte 0xa1, `session_owner_metadata` kind byte 26, then filler bytes so the
 * ciphertext satisfies the structural minimum without ever being opened.
 */
const RETAINED_OWNER_CIPHERTEXT_FIXTURE = `oRoA${"A".repeat(52)}`;

function layoutOneSessionFixture(params: Readonly<{
    ownerMetadata: string;
    encryptionMode?: string;
}>) {
    return {
        id: "session-1",
        encryptionMode: params.encryptionMode ?? "plain",
        metadata: JSON.stringify({
            v: 1,
            summary: { text: "Safe title", updatedAt: 1 },
        }),
        metadataLayoutVersion: 1,
        ownerMetadata: params.ownerMetadata,
    };
}

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

    it("accepts a plain-account layout-one target proven by current machine access correspondence", async () => {
        const accessKeyFindFirst = vi.fn(async () => ({
            machine: { revokedAt: null, replacedByMachineId: null },
            session: { accountId: "owner" },
        }));
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
        }));
        const accountFindUnique = vi.fn(async () => ({ settings: null, encryptionMode: "plain" }));
        const tx = {
            session: { findFirst: sessionFindFirst },
            account: { findUnique: accountFindUnique },
            accessKey: { findFirst: accessKeyFindFirst },
        };

        await expect(validateExistingSessionAutomationTargetTx({
            tx: tx as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { existingSessionId: "session-1" },
            }),
        })).resolves.toBeUndefined();

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
        expect(accessKeyFindFirst).toHaveBeenCalledWith({
            where: {
                accountId: "owner",
                sessionId: "session-1",
                // Availability is part of the query so any candidate row of the
                // unordered correspondence read is an available machine.
                machine: { revokedAt: null, replacedByMachineId: null },
                session: { accountId: "owner" },
            },
            select: {
                machine: { select: { revokedAt: true, replacedByMachineId: true } },
                session: { select: { accountId: true } },
            },
        });
    });

    it("accepts an e2ee layout-one target through the same correspondence without opening owner content", async () => {
        const accessKeyFindFirst = vi.fn(async () => ({
            machine: { revokedAt: null, replacedByMachineId: null },
            session: { accountId: "owner" },
        }));
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            encryptionMode: "e2ee",
            ownerMetadata: JSON.stringify({
                t: "encrypted",
                c: RETAINED_OWNER_CIPHERTEXT_FIXTURE,
            }),
        }));
        const accountFindUnique = vi.fn(async () => ({ settings: null, encryptionMode: "e2ee" }));
        const tx = {
            session: { findFirst: sessionFindFirst },
            account: { findUnique: accountFindUnique },
            accessKey: { findFirst: accessKeyFindFirst },
        };

        await expect(validateExistingSessionAutomationTargetTx({
            tx: tx as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "e2ee",
            strictExistingSessionId: "session-1",
        })).resolves.toBeUndefined();

        expect(accessKeyFindFirst).toHaveBeenCalled();
    });

    it("validates layout-one Session owner bytes against persisted source mode during a target-mode transition", async () => {
        const accessKeyFindFirst = vi.fn(async () => ({
            machine: { revokedAt: null, replacedByMachineId: null },
            session: { accountId: "owner" },
        }));
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
        }));

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
                // The Automation transition candidate is already e2ee, while
                // the persisted Account and Session owner bytes are still the
                // plain source state until the transition owner applies them.
                account: { findUnique: vi.fn(async () => ({ encryptionMode: "plain" })) },
                accessKey: { findFirst: accessKeyFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "e2ee",
            strictExistingSessionId: "session-1",
        })).resolves.toBeUndefined();
    });

    it("fails typed when no available Account machine currently holds the layout-one target", async () => {
        const accessKeyFindFirst = vi.fn(async () => null);
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
        }));
        const accountFindUnique = vi.fn(async () => ({ settings: null, encryptionMode: "plain" }));

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
                account: { findUnique: accountFindUnique },
                accessKey: { findFirst: accessKeyFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            strictExistingSessionId: "session-1",
        })).rejects.toThrow("existing session target is unavailable for automation execution");

        expect(accessKeyFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "owner",
                    sessionId: "session-1",
                    machine: { revokedAt: null, replacedByMachineId: null },
                    session: { accountId: "owner" },
                }),
            }),
        );
    });

    it("fails typed when the only correspondence candidate is a revoked machine", async () => {
        const accessKeyFindFirst = vi.fn(async () => ({
            machine: { revokedAt: new Date(), replacedByMachineId: null },
            session: { accountId: "owner" },
        }));
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
        }));

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
                account: { findUnique: vi.fn(async () => ({ settings: null, encryptionMode: "plain" })) },
                accessKey: { findFirst: accessKeyFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            strictExistingSessionId: "session-1",
        })).rejects.toThrow("existing session target is unavailable for automation execution");

        // The same-owner re-check stays in place behind the query predicate.
        expect(accessKeyFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    machine: { revokedAt: null, replacedByMachineId: null },
                    session: { accountId: "owner" },
                }),
            }),
        );
    });

    it("rejects a plain-account encrypted template targeting a plain layout-one Session", async () => {
        const accessKeyFindFirst = vi.fn();
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            encryptionMode: "plain",
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
        }));

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
                account: { findUnique: vi.fn(async () => ({ settings: null, encryptionMode: "plain" })) },
                accessKey: { findFirst: accessKeyFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            legacyExistingSessionId: "session-1",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_encrypted_v1",
                payloadCiphertext: "ciphertext",
                existingSessionId: "session-1",
            }),
        })).rejects.toThrow("encrypted templates in a plain account require an e2ee existing session");

        expect(accessKeyFindFirst).not.toHaveBeenCalled();
    });

    it("fails typed when layout one stores a non-canonical split owner envelope", async () => {
        const sessionFindFirst = vi.fn(async () => layoutOneSessionFixture({
            ownerMetadata: RETAINED_OWNER_CIPHERTEXT_FIXTURE,
        }));
        const accountFindUnique = vi.fn(async () => ({ settings: null, encryptionMode: "plain" }));
        const tx = {
            session: { findFirst: sessionFindFirst },
            account: { findUnique: accountFindUnique },
            accessKey: { findFirst: vi.fn() },
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
        // The mode authority is a server-owned column; the owner ciphertext is
        // still never opened.
        expect(accountFindUnique).toHaveBeenCalledWith({
            where: { id: "owner" },
            select: { encryptionMode: true },
        });
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

    it("rejects a target Session that belongs to another Account before any correspondence check", async () => {
        const sessionFindFirst = vi.fn(async () => null);
        const accessKeyFindFirst = vi.fn();

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: { findFirst: sessionFindFirst },
                account: { findUnique: vi.fn(async () => ({ settings: null, encryptionMode: "plain" })) },
                accessKey: { findFirst: accessKeyFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            strictExistingSessionId: "session-1",
        })).rejects.toThrow("existing session target does not exist");

        expect(accessKeyFindFirst).not.toHaveBeenCalled();
    });

    it("keeps layout-zero metadata resumability as the layout-zero decision", async () => {
        const accountFindUnique = vi.fn(async () => ({ settings: null }));
        const accessKeyFindFirst = vi.fn();

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: {
                    findFirst: vi.fn(async () => ({
                        id: "session-1",
                        encryptionMode: "plain",
                        metadata: JSON.stringify({
                            flavor: "pi",
                            piSessionId: "pi-session-1",
                        }),
                        metadataLayoutVersion: 0,
                        ownerMetadata: null,
                    })),
                },
                account: { findUnique: accountFindUnique },
                accessKey: { findFirst: accessKeyFindFirst },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { existingSessionId: "session-1" },
            }),
        })).resolves.toBeUndefined();

        expect(accessKeyFindFirst).not.toHaveBeenCalled();
    });

    it("keeps the layout-zero non-resumable rejection", async () => {
        const accountFindUnique = vi.fn(async () => ({ settings: null }));

        await expect(validateExistingSessionAutomationTargetTx({
            tx: {
                session: {
                    findFirst: vi.fn(async () => ({
                        id: "session-1",
                        encryptionMode: "plain",
                        metadata: JSON.stringify({ flavor: "unsupported-agent" }),
                        metadataLayoutVersion: 0,
                        ownerMetadata: null,
                    })),
                },
                account: { findUnique: accountFindUnique },
                accessKey: { findFirst: vi.fn() },
            } as any,
            accountId: "owner",
            targetType: "existing_session",
            accountMode: "plain",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { existingSessionId: "session-1" },
            }),
        })).rejects.toThrow("existing session target is not resumable");
    });
});
