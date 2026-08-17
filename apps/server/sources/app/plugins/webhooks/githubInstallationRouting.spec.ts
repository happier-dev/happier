import { describe, expect, it } from "vitest";

import { extractVerifiedGitHubInstallationIdV1 } from "./githubInstallationRouting";

function bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

describe("verified GitHub installation routing", () => {
    it("preserves the exact canonical decimal identity without Number coercion", () => {
        expect(extractVerifiedGitHubInstallationIdV1(bytes(
            '{"action":"opened","installation":{"node_id":"x","id":18446744073709551615},"repository":{}}',
        ))).toEqual({ ok: true, installationId: "18446744073709551615" });
    });

    it("reads only the top-level installation object and rejects duplicate routing facts", () => {
        expect(extractVerifiedGitHubInstallationIdV1(bytes(
            '{"repository":{"installation":{"id":123}},"installation":{"id":456}}',
        ))).toEqual({ ok: true, installationId: "456" });
        expect(extractVerifiedGitHubInstallationIdV1(bytes(
            '{"installation":{"id":123},"installation":{"id":456}}',
        ))).toEqual({ ok: false, code: "malformedInstallation" });
    });

    it("rejects missing, string, zero, negative, fractional, and overlong identities", () => {
        for (const payload of [
            '{}',
            '{"installation":{}}',
            '{"installation":{"id":"123"}}',
            '{"installation":{"id":0}}',
            '{"installation":{"id":-1}}',
            '{"installation":{"id":1.5}}',
            '{"installation":{"id":123456789012345678901}}',
        ]) {
            expect(extractVerifiedGitHubInstallationIdV1(bytes(payload))).toEqual({
                ok: false,
                code: "malformedInstallation",
            });
        }
    });

    it("rejects invalid UTF-8, invalid JSON, excessive nesting, and trailing content", () => {
        expect(extractVerifiedGitHubInstallationIdV1(Uint8Array.of(0xff))).toEqual({
            ok: false,
            code: "malformedPayload",
        });
        for (const payload of [
            '{"installation":{"id":123}',
            '{"installation":{"id":123}} trailing',
            `${"[".repeat(65)}0${"]".repeat(65)}`,
        ]) {
            expect(extractVerifiedGitHubInstallationIdV1(bytes(payload))).toEqual({
                ok: false,
                code: "malformedPayload",
            });
        }
    });
});
