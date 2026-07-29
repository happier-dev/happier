import { describe, expect, it } from "vitest";

import {
    parseStoredSessionRuntimeIssue,
    parseStoredSessionTurn,
} from "./parseSessionTurnState";

describe("parseSessionTurnState", () => {
    it("preserves remote-dev persisted provider process-exit-after-switch runtime issues", () => {
        const issueJson = JSON.stringify({
            v: 1,
            scope: "primary_session",
            status: "failed",
            code: "agent_process_exit_after_switch",
            source: "agent_process_exit_after_switch",
            occurredAt: 2_000,
            provider: "pi",
            agentProcessExitAfterSwitch: {
                exitCode: 1,
                signal: null,
                lastStderrLine: "session file missing",
                vendorResumeId: "019e6942",
                materializationRoot: "/tmp/happier/connected-services/pi",
                effectiveStateMode: "isolated",
            },
        });

        expect(parseStoredSessionRuntimeIssue(issueJson)).toMatchObject({
            source: "agent_process_exit_after_switch",
            agentProcessExitAfterSwitch: {
                exitCode: 1,
                signal: null,
                lastStderrLine: "session file missing",
                vendorResumeId: "019e6942",
                materializationRoot: "/tmp/happier/connected-services/pi",
                effectiveStateMode: "isolated",
            },
        });
        expect(parseStoredSessionTurn({
            turnId: "turn-1",
            status: "failed",
            startedAt: 1_000,
            updatedAt: 2_000,
            terminalAt: 2_000,
            lastRuntimeIssueJson: issueJson,
        })?.lastRuntimeIssue).toMatchObject({
            source: "agent_process_exit_after_switch",
        });
    });

    it("preserves existing and remote-dev temporary throttle recoverability values", () => {
        for (const recoverability of ["wait", "manual"] as const) {
            expect(parseStoredSessionRuntimeIssue(JSON.stringify({
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "provider_temporary_throttle",
                source: "agent_status_error",
                occurredAt: 2_000,
                temporaryThrottle: {
                    v: 1,
                    retryAfterMs: null,
                    recoverability,
                },
            }))?.temporaryThrottle?.recoverability).toBe(recoverability);
        }
    });
});
