import { describe, expect, it, vi } from "vitest";

import { PRESENT_USER_REQUIRED_ERROR, requirePresentUser } from "./requirePresentUser";

function createReply() {
    const send = vi.fn((payload: unknown) => payload);
    const code = vi.fn(() => ({ send }));
    return { reply: { code }, code, send };
}

describe("requirePresentUser", () => {
    it("admits person-class Account and terminal credentials whatever their per-invocation authority", async () => {
        for (const authTokenKind of ["account", "terminal"]) {
            for (const authAuthority of ["present_user", "account_automation", undefined]) {
                const accepted = createReply();
                await expect(requirePresentUser({ authAuthority, authTokenKind }, accepted.reply)).resolves.toBeUndefined();
                expect(accepted.code).not.toHaveBeenCalled();
            }
        }
    });
    it("refuses scoped, directory, runner, missing and unknown credential provenance", async () => {
        for (const request of [
            { authAuthority: "present_user" },
            { authAuthority: "present_user", authTokenKind: "account_directory" },
            { authAuthority: "account_automation", authTokenKind: "api_token" },
            { authAuthority: "session_runtime", authTokenKind: "ephemeral_session_runner" },
            { authAuthority: "present_user", authTokenKind: "unknown" },
        ]) {
            const rejected = createReply();
            await expect(requirePresentUser(request, rejected.reply)).resolves.toEqual({
                error: PRESENT_USER_REQUIRED_ERROR,
            });
            expect(rejected.code).toHaveBeenCalledWith(403);
        }
    });
});
