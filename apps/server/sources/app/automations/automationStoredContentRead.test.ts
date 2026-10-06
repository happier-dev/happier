import { describe, expect, it } from "vitest";

import {
    readRetainedAutomationRunExecutionTargetV2,
    validateAutomationStoredContentEnvelopeOuterForMode,
} from "./automationStoredContentRead";

describe("Automation stored-content outer read", () => {
    it("opens unknown stored outer fields while preserving mode and required ciphertext checks", () => {
        expect(validateAutomationStoredContentEnvelopeOuterForMode({ raw: '{"t":"plain","v":{"extra":true},"extra":true}', mode: "plain" }))
            .toEqual({ kind: "available", envelope: { t: "plain", v: { extra: true } } });
        expect(validateAutomationStoredContentEnvelopeOuterForMode({ raw: '{"t":"encrypted","c":null,"extra":true}', mode: "e2ee" }))
            .toEqual({ kind: "contentInvalid" });
    });
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

    it("projects only exact mode-correct released-V2 targets", () => {
        const retainedInput = (targetType: "new_session" | "existing_session") => JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType,
            templateVersion: 1,
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: {
                    prompt: "Run the retained Automation",
                    ...(targetType === "existing_session" ? { existingSessionId: "session-retained" } : {}),
                },
            }),
            origin: { kind: "scheduled", scheduledFor: 1 },
        });

        expect(readRetainedAutomationRunExecutionTargetV2({
            raw: retainedInput("new_session"),
            mode: "plain",
            retainedV2OriginKind: "scheduled",
        })).toEqual({ kind: "newSession" });
        expect(readRetainedAutomationRunExecutionTargetV2({
            raw: retainedInput("existing_session"),
            mode: "plain",
            retainedV2OriginKind: "scheduled",
        })).toEqual({ kind: "existingSession", sessionId: "session-retained" });
        expect(readRetainedAutomationRunExecutionTargetV2({
            raw: retainedInput("new_session"),
            mode: "e2ee",
            retainedV2OriginKind: "scheduled",
        })).toBeNull();
        expect(readRetainedAutomationRunExecutionTargetV2({
            raw: retainedInput("new_session"),
            mode: "plain",
            retainedV2OriginKind: "manual",
        })).toBeNull();
        expect(readRetainedAutomationRunExecutionTargetV2({
            raw: retainedInput("new_session").replace(
                '"targetType":"new_session"',
                '"targetType":"new_session","unreleased":true',
            ),
            mode: "plain",
            retainedV2OriginKind: "scheduled",
        })).toEqual({ kind: "newSession" });
    });
});
