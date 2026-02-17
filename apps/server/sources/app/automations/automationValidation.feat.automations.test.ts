import { describe, expect, it } from "vitest";

import { parseAutomationUpsertInput } from "./automationValidation";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

describe("parseAutomationUpsertInput", () => {
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
