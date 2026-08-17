import { describe, expect, it } from "vitest";

import {
    assertAutomationTemplateEnvelopeForAccountMode,
    parseAutomationPatchInput,
    parseAutomationUpsertInput,
} from "./automationValidation";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

describe("parseAutomationPatchInput", () => {
    it("rejects an empty patch", () => {
        expect(() => parseAutomationPatchInput({})).toThrow(/at least one field/i);
    });
});

describe("parseAutomationUpsertInput", () => {
    it("accepts existing_session target for encrypted templates", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Existing-session automation",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "existing_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "ciphertext-base64",
                }),
            }),
        ).not.toThrow();
    });

    it("accepts interval schedules with an execution template", () => {
        const parsed = parseAutomationUpsertInput({
            name: "Daily workspace sweep",
            enabled: true,
            schedule: {
                kind: "interval",
                everyMs: 60_000,
            },
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            assignments: [{ machineId: "m1", enabled: true, priority: 1 }],
        });

        expect(parsed.schedule.kind).toBe("interval");
        expect(parsed.schedule.everyMs).toBe(60_000);
        expect(parsed.assignments).toHaveLength(1);
    });

    it("rejects interval schedules without everyMs", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Broken",
                enabled: true,
                schedule: { kind: "interval" },
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            }),
        ).toThrow(/everyMs/);
    });

    it("accepts cron schedules with scheduleExpr", () => {
        const parsed = parseAutomationUpsertInput({
            name: "Cron schedule",
            enabled: true,
            schedule: { kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" },
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
        });

        expect(parsed.schedule.kind).toBe("cron");
        expect((parsed.schedule as any).scheduleExpr).toBe("*/5 * * * *");
    });

    it("rejects cron schedules without scheduleExpr", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Missing expr",
                enabled: true,
                schedule: { kind: "cron" },
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            }),
        ).toThrow(/scheduleExpr/i);
    });

    it("rejects cron schedules with invalid scheduleExpr", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Invalid cron",
                enabled: true,
                schedule: { kind: "cron", scheduleExpr: "not-a-cron", timezone: "UTC" },
                targetType: "new_session",
                templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            }),
        ).toThrow(/schedule/i);
    });

    it("rejects plaintext templates that are not encrypted envelopes", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Legacy template",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: "{\"directory\":\"/tmp/project\"}",
            }),
        ).toThrow(/templateCiphertext/i);
    });

    it("accepts plaintext automation templates when accountMode=plain", () => {
        const plain = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { directory: "/tmp/project", prompt: "hi" },
        });

        expect(() =>
            parseAutomationUpsertInput({
                name: "Plain template",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: plain,
            }, { accountMode: "plain" }),
        ).not.toThrow();
    });

    it("rejects plaintext automation templates that include sessionEncryptionKeyBase64 when accountMode=plain", () => {
        const plain = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: {
                directory: "/tmp/project",
                prompt: "hi",
                sessionEncryptionKeyBase64: "dek",
            },
        });

        expect(() =>
            parseAutomationUpsertInput({
                name: "Plain template",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: plain,
            }, { accountMode: "plain" }),
        ).toThrow(/sessionEncryptionKeyBase64/i);
    });

    it("rejects encrypted new-session automation templates when accountMode=plain", () => {
        const encrypted = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "ciphertext",
        });

        expect(() =>
            parseAutomationUpsertInput({
                name: "Encrypted template",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: encrypted,
            }, { accountMode: "plain" }),
        ).toThrow(/encrypted.*existing_session|plain account/i);
    });

    it("rejects a predecessor encrypted outer session identifier outside the legacy request adapter", () => {
        const encrypted = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "ciphertext",
            existingSessionId: "session-e2ee",
        });

        expect(() =>
            parseAutomationUpsertInput({
                name: "Encrypted retained-session template",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "existing_session",
                templateCiphertext: encrypted,
            }, { accountMode: "plain" }),
        ).toThrow(/templateCiphertext/i);
    });

    it("admits only the exact predecessor encrypted outer session identifier through the legacy request adapter", () => {
        const encrypted = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "ciphertext",
            existingSessionId: "session-e2ee",
        });

        const parsed = parseAutomationUpsertInput({
            name: "Encrypted retained-session template",
            enabled: true,
            schedule: { kind: "interval", everyMs: 60_000 },
            targetType: "existing_session",
            templateCiphertext: encrypted,
        }, {
            accountMode: "plain",
            allowLegacyEncryptedExistingSessionTemplate: true,
        });

        expect(parsed.legacyTemplateEnvelopeAdmission).toEqual({
            kind: "legacy-encrypted-existing-session-v1",
            existingSessionId: "session-e2ee",
        });
        expect(parsed.templateCiphertext).toBe(encrypted);
    });

    it("admits the exact predecessor plain outer session identifier only when it agrees with the payload", () => {
        const plain = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { existingSessionId: "session-e2ee" },
            existingSessionId: "session-e2ee",
        });

        const parsed = parseAutomationUpsertInput({
            name: "Not an encrypted predecessor envelope",
            enabled: true,
            schedule: { kind: "interval", everyMs: 60_000 },
            targetType: "existing_session",
            templateCiphertext: plain,
        }, {
            accountMode: "plain",
            allowLegacyEncryptedExistingSessionTemplate: true,
        });

        expect(parsed.legacyTemplateEnvelopeAdmission).toEqual({
            kind: "legacy-plain-existing-session-v1",
            existingSessionId: "session-e2ee",
        });
        expect(parsed.templateCiphertext).toBe(plain);
    });

    it("rejects a predecessor plain outer session identifier that disagrees with the payload", () => {
        expect(() => parseAutomationUpsertInput({
            name: "Mismatched predecessor envelope",
            enabled: true,
            schedule: { kind: "interval", everyMs: 60_000 },
            targetType: "existing_session",
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { existingSessionId: "session-inner" },
                existingSessionId: "session-outer",
            }),
        }, {
            accountMode: "plain",
            allowLegacyEncryptedExistingSessionTemplate: true,
        })).toThrow(/templateCiphertext/i);
    });

    it("rechecks the trusted legacy admission against the exact raw predecessor envelope", () => {
        const encrypted = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "ciphertext",
            existingSessionId: "session-e2ee",
        });

        expect(() => assertAutomationTemplateEnvelopeForAccountMode(
            encrypted,
            "plain",
            "existing_session",
            {
                kind: "legacy-encrypted-existing-session-v1",
                existingSessionId: "different-session",
            },
        )).toThrow(/templateCiphertext/i);
    });

    it("rejects plaintext automation templates when accountMode=e2ee", () => {
        const plain = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { directory: "/tmp/project" },
        });

        expect(() =>
            parseAutomationUpsertInput({
                name: "Plain template",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: plain,
            }, { accountMode: "e2ee" }),
        ).toThrow(/templateCiphertext/i);
    });

    it("rejects templates with an oversized payloadCiphertext", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Huge payload",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "a".repeat(200_001),
                }),
            }),
        ).toThrow(/payloadCiphertext|templateCiphertext/i);
    });

    it("rejects templates with an oversized templateCiphertext envelope", () => {
        expect(() =>
            parseAutomationUpsertInput({
                name: "Huge envelope",
                enabled: true,
                schedule: { kind: "interval", everyMs: 60_000 },
                targetType: "new_session",
                templateCiphertext: "a".repeat(220_001),
            }),
        ).toThrow(/templateCiphertext/i);
    });
});
