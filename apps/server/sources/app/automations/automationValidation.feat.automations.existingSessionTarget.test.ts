import { describe, expect, it } from "vitest";

import { parseAutomationUpsertInput } from "./automationValidation";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

describe("parseAutomationUpsertInput(existing_session target gate)", () => {
    it("rejects existing_session target when feature gate is disabled", () => {
        const previous = process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;
        process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = "0";
        try {
            expect(() =>
                parseAutomationUpsertInput({
                    name: "Existing-session automation",
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000 },
                    targetType: "existing_session",
                    templateCiphertext: JSON.stringify({
                        kind: "happier_automation_template_encrypted_v1",
                        payloadCiphertext: "ciphertext-base64",
                        existingSessionId: "session-1",
                    }),
                }),
            ).toThrow(/existing_session/);
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;
            else process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = previous;
        }
    });

    it("rejects existing_session target when automations are disabled (dependency)", () => {
        const prevEnabled = process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED;
        const prevExisting = process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;
        process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = "0";
        process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = "1";
        try {
            expect(() =>
                parseAutomationUpsertInput({
                    name: "Existing-session automation",
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000 },
                    targetType: "existing_session",
                    templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                }),
            ).toThrow(/existing_session|existing session/i);
        } finally {
            if (prevEnabled === undefined) delete process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = prevEnabled;
            if (prevExisting === undefined) delete process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;
            else process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = prevExisting;
        }
    });

    it("rejects existing_session target when build policy denies the subfeature", () => {
        const prevDeny = process.env.HAPPIER_BUILD_FEATURES_DENY;
        const prevExisting = process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;
        process.env.HAPPIER_BUILD_FEATURES_DENY = "automations.existingSessionTarget";
        process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = "1";
        try {
            expect(() =>
                parseAutomationUpsertInput({
                    name: "Existing-session automation",
                    enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000 },
                    targetType: "existing_session",
                    templateCiphertext: TEST_TEMPLATE_ENVELOPE,
                }),
            ).toThrow(/existing_session|existing session/i);
        } finally {
            if (prevDeny === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
            else process.env.HAPPIER_BUILD_FEATURES_DENY = prevDeny;
            if (prevExisting === undefined) delete process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET;
            else process.env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET = prevExisting;
        }
    });
});

