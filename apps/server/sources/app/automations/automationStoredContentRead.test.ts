import { describe, expect, it } from "vitest";

import {
    validateAutomationStoredContentEnvelopeOuterForMode,
} from "./automationStoredContentRead";

describe("Automation stored-content outer read", () => {
    it("accepts only a valid outer envelope tagged for the Account mode", () => {
        expect(validateAutomationStoredContentEnvelopeOuterForMode({
            raw: '{"t":"plain","v":{"source":"private"}}',
            mode: "plain",
        })).toEqual(expect.objectContaining({ kind: "available" }));

        expect(validateAutomationStoredContentEnvelopeOuterForMode({
            raw: '{"t":"encrypted","c":"ciphertext"}',
            mode: "plain",
        })).toEqual({ kind: "modeMismatch" });

        expect(validateAutomationStoredContentEnvelopeOuterForMode({
            raw: "not-json",
            mode: "plain",
        })).toEqual({ kind: "contentInvalid" });
    });
});
