import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({ default: { post } }));
vi.mock("@/api/client/serverHttpBaseUrl", () => ({
    resolveServerHttpBaseUrl: () => "https://account.example.test/",
    normalizeServerHttpBaseUrl: (url: string) => url.replace(/\/+$/, ""),
}));

import { createAccountServerPatIntrospector } from "./accountServerPatIntrospector";

const PAT = "hap_v1_2c67deea-5ae7-4706-9ad6-b5b992df1cba_daemon_pat_only_in_request_body";
const CREDENTIAL_ID = "2c67deea-5ae7-4706-9ad6-b5b992df1cba";
const SERVER_BASE_URL = "https://account.example.test/";

describe("createAccountServerPatIntrospector", () => {
    beforeEach(() => {
        post.mockReset();
    });

    it("uses the daemon's existing Account connection to request only the minimal verified PAT principal", async () => {
        post.mockResolvedValue({
            status: 200,
            data: {
                accountId: "account-a",
                principalId: "account-a",
                credentialId: CREDENTIAL_ID,
                expiresAt: "2030-08-22T12:01:00.000Z",
                authority: "account_automation",
            },
        });
        const introspect = createAccountServerPatIntrospector({ daemonConnectionToken: "daemon-connection-token", serverBaseUrl: SERVER_BASE_URL });

        await expect(introspect(PAT)).resolves.toEqual({
            ok: true,
            accountId: "account-a",
            principalId: "account-a",
            credentialId: CREDENTIAL_ID,
            expiresAt: new Date("2030-08-22T12:01:00.000Z"),
            authority: "account_automation",
        });

        expect(post).toHaveBeenCalledWith(
            "https://account.example.test/v1/auth/api-tokens/introspect",
            { token: PAT },
            expect.objectContaining({
                headers: {
                    Authorization: "Bearer daemon-connection-token",
                    "Content-Type": "application/json",
                },
                timeout: 15_000,
                validateStatus: expect.any(Function),
            }),
        );
        expect(String(post.mock.calls[0]?.[0])).not.toContain(PAT);
    });

    it("accepts invalid_token only from the strict authenticated-subject failure envelope", async () => {
        const introspect = createAccountServerPatIntrospector({ daemonConnectionToken: "daemon-connection-token", serverBaseUrl: SERVER_BASE_URL });
        post.mockResolvedValueOnce({ status: 401, data: { error: "invalid_token" } });
        post.mockResolvedValueOnce({ status: 401, data: { error: "authentication_failed" } });
        post.mockResolvedValueOnce({ status: 401, data: { error: "invalid_token", detail: "connection rejected" } });

        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "invalid_token" });
        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
    });

    it("treats unavailable or malformed server responses as auth_unavailable", async () => {
        const introspect = createAccountServerPatIntrospector({ daemonConnectionToken: "daemon-connection-token", serverBaseUrl: SERVER_BASE_URL });
        post.mockResolvedValueOnce({ status: 503, data: { error: "upstream_error" } });
        post.mockResolvedValueOnce({ status: 200, data: { accountId: "missing-required-fields" } });
        post.mockResolvedValueOnce({
            status: 200,
            data: {
                accountId: "account-a",
                principalId: "different-account",
                credentialId: CREDENTIAL_ID,
                expiresAt: null,
                authority: "account_automation",
            },
        });

        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
    });

    it("degrades safely when a supported older Account server does not yet expose introspection", async () => {
        post.mockResolvedValue({ status: 404, data: { error: "not_found" } });
        const introspect = createAccountServerPatIntrospector({ daemonConnectionToken: "daemon-connection-token", serverBaseUrl: SERVER_BASE_URL });

        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
    });

    it("maps a connection timeout to auth_unavailable", async () => {
        post.mockRejectedValue(new Error("timeout"));
        const introspect = createAccountServerPatIntrospector({ daemonConnectionToken: "daemon-connection-token", serverBaseUrl: SERVER_BASE_URL });

        await expect(introspect(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
    });

    it("preserves a caller cancellation instead of presenting it as an authentication failure", async () => {
        const controller = new AbortController();
        const cancelled = new DOMException("Stopped", "AbortError");
        post.mockImplementation(async () => {
            controller.abort(cancelled);
            throw cancelled;
        });
        const introspect = createAccountServerPatIntrospector({ daemonConnectionToken: "daemon-connection-token", serverBaseUrl: SERVER_BASE_URL });

        await expect(introspect(PAT, controller.signal)).rejects.toBe(cancelled);
    });
});
