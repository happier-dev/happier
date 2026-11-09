import { describe, expect, it } from "vitest";
import { AUTOMATION_INT_COLUMN_MAX } from "@happier-dev/protocol";
import {
    assertAutomationTemplateEnvelopeForAccountMode,
    AutomationValidationError,
    parseAutomationScheduleInput,
    readLegacyExistingSessionTemplateAdmission,
} from "./automationValidation";

describe("Automation schedule admission", () => {
    it("accepts computable intervals through the database column boundary", () => {
        for (const everyMs of [60_000, AUTOMATION_INT_COLUMN_MAX]) {
            expect(parseAutomationScheduleInput({ kind: "interval", everyMs })).toMatchObject({ everyMs });
        }
        for (const schedule of [{ kind: "interval" }, { kind: "interval", everyMs: AUTOMATION_INT_COLUMN_MAX + 1 }]) {
            expect(() => parseAutomationScheduleInput(schedule)).toThrow(AutomationValidationError);
        }
    });

    it("accepts valid cron schedules and refuses missing or uncomputable expressions", () => {
        expect(parseAutomationScheduleInput({ kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" }))
            .toMatchObject({ kind: "cron", scheduleExpr: "*/5 * * * *" });
        for (const schedule of [{ kind: "cron" }, { kind: "cron", scheduleExpr: "not-a-cron", timezone: "UTC" }]) {
            expect(() => parseAutomationScheduleInput(schedule)).toThrow(AutomationValidationError);
        }
    });
});

describe("Automation template mode and retained Session admission", () => {
    const encrypted = JSON.stringify({ kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "ciphertext" });
    const plain = JSON.stringify({ kind: "happier_automation_template_plain_v1", payload: { directory: "/repo", prompt: "hi" } });

    it("accepts each Account's own envelope and refuses mode mismatches", () => {
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(encrypted, "e2ee", "existing_session")).not.toThrow();
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(plain, "plain", "new_session")).not.toThrow();
        for (const target of ["existing_session", "new_session"] as const) {
            expect(() => assertAutomationTemplateEnvelopeForAccountMode(encrypted, "plain", target)).toThrow(AutomationValidationError);
        }
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(plain, "e2ee", "new_session")).toThrow(AutomationValidationError);
        expect(() => assertAutomationTemplateEnvelopeForAccountMode('{"directory":"/repo"}', "e2ee", "new_session"))
            .toThrow(AutomationValidationError);
    });

    it("refuses Session encryption material in a plain envelope", () => {
        const template = JSON.stringify({ kind: "happier_automation_template_plain_v1",
            payload: { directory: "/repo", sessionEncryptionKeyBase64: "dek" } });
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(template, "plain", "new_session"))
            .toThrow(AutomationValidationError);
    });

    it.each(["encrypted", "plain"] as const)("admits only exact retained %s Session correspondence", kind => {
        const template = JSON.stringify(kind === "encrypted"
            ? { kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "ciphertext", existingSessionId: "retained" }
            : { kind: "happier_automation_template_plain_v1", payload: { existingSessionId: "retained" }, existingSessionId: "retained" });
        const admission = readLegacyExistingSessionTemplateAdmission(template, "existing_session");
        expect(admission).toMatchObject({ existingSessionId: "retained" });
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(template, "plain", "existing_session", admission))
            .not.toThrow();
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(template, "plain", "existing_session"))
            .toThrow(AutomationValidationError);
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(template, "plain", "existing_session",
            { kind: kind === "encrypted" ? "legacy-encrypted-existing-session-v1" : "legacy-plain-existing-session-v1", existingSessionId: "other" }))
            .toThrow(AutomationValidationError);
        expect(readLegacyExistingSessionTemplateAdmission(template, "new_session")).toBeUndefined();
    });

    it("refuses mismatched inner and outer retained Session identifiers", () => {
        const template = JSON.stringify({ kind: "happier_automation_template_plain_v1",
            payload: { existingSessionId: "inner" }, existingSessionId: "outer" });
        expect(readLegacyExistingSessionTemplateAdmission(template, "existing_session")).toBeUndefined();
        expect(() => assertAutomationTemplateEnvelopeForAccountMode(template, "plain", "existing_session",
            { kind: "legacy-plain-existing-session-v1", existingSessionId: "outer" })).toThrow(AutomationValidationError);
    });

    it("refuses malformed and oversized encrypted templates at the retained-content boundary", () => {
        for (const template of ["a".repeat(220_001), JSON.stringify({
            kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "a".repeat(200_001),
        })]) {
            expect(() => assertAutomationTemplateEnvelopeForAccountMode(template, "e2ee", "new_session"))
                .toThrow(AutomationValidationError);
        }
    });
});
