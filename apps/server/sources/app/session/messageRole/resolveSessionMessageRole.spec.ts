import { beforeEach, describe, expect, it, vi } from "vitest";

const roleMismatchInc = vi.fn();
const warn = vi.fn();

vi.mock("@/app/monitoring/metrics/sessionWriteMetrics", () => ({
    sessionMessageRoleMismatchCounter: { inc: roleMismatchInc },
}));

vi.mock("@/utils/logging/log", () => ({
    warn,
}));

let resolveSessionMessageRole: typeof import("./resolveSessionMessageRole").resolveSessionMessageRole;

describe("resolveSessionMessageRole", () => {
    beforeEach(async () => {
        roleMismatchInc.mockReset();
        warn.mockReset();
        ({ resolveSessionMessageRole } = await import("./resolveSessionMessageRole"));
    });

    it("uses a valid supplied role over derived plaintext role and records safe mismatch telemetry", () => {
        const result = resolveSessionMessageRole({
            content: {
                t: "plain",
                v: {
                    role: "agent",
                    content: { type: "acp", data: { type: "tool-call", text: "do not log" } },
                },
            },
            suppliedRole: "event",
            telemetry: {
                sessionId: "s1",
                storageMode: "plain",
                source: "session-message",
            },
        });

        expect(result).toEqual({
            messageRole: "event",
            mismatch: {
                suppliedRole: "event",
                derivedRole: "agent",
                finalRole: "event",
                contentKind: "plain",
                storageMode: "plain",
                source: "session-message",
            },
        });
        expect(roleMismatchInc).toHaveBeenCalledWith({
            supplied_role: "event",
            derived_role: "agent",
            final_role: "event",
            content_kind: "plain",
            storage_mode: "plain",
            source: "session-message",
        });
        expect(warn).toHaveBeenCalledWith(
            {
                module: "session-message-role",
                event: "session_message_role_mismatch",
                sessionId: "s1",
                suppliedRole: "event",
                derivedRole: "agent",
                finalRole: "event",
                contentKind: "plain",
                storageMode: "plain",
                source: "session-message",
            },
            "Session message role mismatch",
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain("do not log");
    });

    it("falls back to derived plaintext role when no valid supplied role exists", () => {
        expect(resolveSessionMessageRole({
            content: { t: "plain", v: { type: "user", text: "hello" } },
        })).toEqual({
            messageRole: "user",
            mismatch: null,
        });

        expect(resolveSessionMessageRole({
            content: { t: "plain", v: { role: "agent" } },
            suppliedRole: "tool",
        })).toEqual({
            messageRole: "agent",
            mismatch: null,
        });
    });

    it("returns null when neither supplied nor plaintext-derived role is valid", () => {
        expect(resolveSessionMessageRole({
            content: { t: "plain", v: { role: "assistant", type: "tool" } },
            suppliedRole: "tool",
        })).toEqual({
            messageRole: null,
            mismatch: null,
        });
    });
});
