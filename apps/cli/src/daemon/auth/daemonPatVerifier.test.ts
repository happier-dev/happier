import { describe, expect, it } from "vitest";

import {
    createDaemonPatVerifier,
    hashDaemonPatCacheKey,
    type DaemonPatIntrospector,
    type DaemonPatVerification,
} from "./daemonPatVerifier";

const PAT = "hap_v1_2c67deea-5ae7-4706-9ad6-b5b992df1cba_daemon_pat_secret_should_never_be_cached_plaintext";

function verifiedPat(overrides: Partial<Extract<DaemonPatVerification, { ok: true }>> = {}): DaemonPatVerification {
    return {
        ok: true,
        accountId: "account-a",
        principalId: "account-a",
        credentialId: "credential-a",
        expiresAt: null,
        authority: "account_automation",
        ...overrides,
    };
}

describe("createDaemonPatVerifier", () => {
    it("uses the configured Account server on a miss, then serves a current positive cache hit without another call", async () => {
        let now = 0;
        const calls: string[] = [];
        const introspect: DaemonPatIntrospector = async (token) => {
            calls.push(token);
            return verifiedPat();
        };
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            introspect,
            now: () => now,
        });

        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat());
        now = 59_999;
        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat());
        expect(calls).toEqual([PAT]);
    });

    it("coalesces concurrent misses for the same complete PAT", async () => {
        let calls = 0;
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            introspect: async () => {
                calls += 1;
                await released;
                return verifiedPat();
            },
        });

        const first = verifyPat(PAT);
        const second = verifyPat(PAT);
        release();

        await expect(Promise.all([first, second])).resolves.toEqual([verifiedPat(), verifiedPat()]);
        expect(calls).toBe(1);
    });

    it("bounds distinct pending misses and recovers capacity after they settle", async () => {
        const releases = new Map<string, () => void>();
        const calls: string[] = [];
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            maxEntries: 2,
            introspect: async (token) => {
                calls.push(token);
                if (token.endsWith("third")) return verifiedPat({ credentialId: "credential-third" });
                await new Promise<void>((resolve) => {
                    releases.set(token, resolve);
                });
                return verifiedPat({ credentialId: `credential-${calls.indexOf(token) + 1}` });
            },
        });
        const firstToken = `${PAT}-first`;
        const secondToken = `${PAT}-second`;
        const thirdToken = `${PAT}-third`;

        const first = verifyPat(firstToken);
        const second = verifyPat(secondToken);
        await Promise.resolve();

        await expect(verifyPat(thirdToken)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
        expect(calls).toEqual([firstToken, secondToken]);

        releases.get(firstToken)?.();
        releases.get(secondToken)?.();
        await Promise.all([first, second]);

        await expect(verifyPat(thirdToken)).resolves.toEqual(
            verifiedPat({ credentialId: "credential-third" }),
        );
        expect(calls).toEqual([firstToken, secondToken, thirdToken]);
    });

    it("keeps caller cancellation local while a shared verification remains in flight", async () => {
        let calls = 0;
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            introspect: async (_token, signal) => {
                calls += 1;
                expect(signal).toBeUndefined();
                await released;
                return verifiedPat();
            },
        });
        const controller = new AbortController();
        const cancelled = new DOMException("Stopped", "AbortError");

        const retained = verifyPat(PAT);
        const cancelledCaller = verifyPat(PAT, controller.signal);
        controller.abort(cancelled);
        await expect(cancelledCaller).rejects.toBe(cancelled);
        release();

        await expect(retained).resolves.toEqual(verifiedPat());
        expect(calls).toBe(1);
    });

    it("expires the maximum TTL exactly at 60 seconds and refreshes instead of extending stale authority", async () => {
        let now = 0;
        let calls = 0;
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            now: () => now,
            introspect: async () => {
                calls += 1;
                return verifiedPat({ credentialId: `credential-${calls}` });
            },
        });

        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat({ credentialId: "credential-1" }));
        now = 60_000;
        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat({ credentialId: "credential-2" }));
        expect(calls).toBe(2);
    });

    it("uses the earlier PAT expiry rather than extending it to the cache maximum", async () => {
        let now = 0;
        let calls = 0;
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            now: () => now,
            introspect: async () => {
                calls += 1;
                return verifiedPat({ expiresAt: new Date(30_000) });
            },
        });

        await verifyPat(PAT);
        now = 29_999;
        await verifyPat(PAT);
        now = 30_000;
        await verifyPat(PAT);

        expect(calls).toBe(2);
    });

    it("rejects an Account-server success that expires while introspection is in flight", async () => {
        let now = 0;
        let releaseIntrospection!: () => void;
        const introspectionReleased = new Promise<void>((resolve) => {
            releaseIntrospection = resolve;
        });
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            now: () => now,
            introspect: async () => {
                await introspectionReleased;
                return verifiedPat({ expiresAt: new Date(1_000) });
            },
        });

        const pending = verifyPat(PAT);
        now = 1_000;
        releaseIntrospection();

        await expect(pending).resolves.toEqual({ ok: false, code: "invalid_token" });
    });

    it("honors a revocation only for the bounded cached interval, then returns the server's opaque invalid result", async () => {
        let now = 0;
        let revoked = false;
        let calls = 0;
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            now: () => now,
            introspect: async () => {
                calls += 1;
                return revoked ? { ok: false, code: "invalid_token" } : verifiedPat();
            },
        });

        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat());
        revoked = true;
        now = 59_999;
        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat());
        now = 60_000;
        await expect(verifyPat(PAT)).resolves.toEqual({ ok: false, code: "invalid_token" });
        expect(calls).toBe(2);
    });

    it("returns auth_unavailable after an expired cache entry cannot refresh and does not extend the stale result", async () => {
        let now = 0;
        let available = true;
        let calls = 0;
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            now: () => now,
            introspect: async () => {
                calls += 1;
                if (!available) {
                    throw new Error("Account server unavailable");
                }
                return verifiedPat();
            },
        });

        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat());
        available = false;
        now = 59_999;
        await expect(verifyPat(PAT)).resolves.toEqual(verifiedPat());
        now = 60_000;
        await expect(verifyPat(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
        await expect(verifyPat(PAT)).resolves.toEqual({ ok: false, code: "auth_unavailable" });
        expect(calls).toBe(3);
    });

    it("does not cache invalid credentials or Account-mismatched server responses", async () => {
        let invalidCalls = 0;
        const invalidVerifier = createDaemonPatVerifier({
            accountId: "account-a",
            introspect: async () => {
                invalidCalls += 1;
                return { ok: false, code: "invalid_token" };
            },
        });
        let mismatchCalls = 0;
        const mismatchVerifier = createDaemonPatVerifier({
            accountId: "account-a",
            introspect: async () => {
                mismatchCalls += 1;
                return verifiedPat({ accountId: "account-b", principalId: "account-b" });
            },
        });

        await expect(invalidVerifier(PAT)).resolves.toEqual({ ok: false, code: "invalid_token" });
        await expect(invalidVerifier(PAT)).resolves.toEqual({ ok: false, code: "invalid_token" });
        await expect(mismatchVerifier(PAT)).resolves.toEqual({ ok: false, code: "invalid_token" });
        await expect(mismatchVerifier(PAT)).resolves.toEqual({ ok: false, code: "invalid_token" });

        expect(invalidCalls).toBe(2);
        expect(mismatchCalls).toBe(2);
    });

    it("keeps only a bounded LRU of positive results", async () => {
        const calls: string[] = [];
        let credentialNumber = 0;
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            maxEntries: 2,
            introspect: async (token) => {
                calls.push(token);
                credentialNumber += 1;
                return verifiedPat({ credentialId: `credential-${credentialNumber}` });
            },
        });
        const first = `${PAT}-first`;
        const second = `${PAT}-second`;
        const third = `${PAT}-third`;

        await verifyPat(first);
        await verifyPat(second);
        await verifyPat(first);
        await verifyPat(third);
        await verifyPat(second);

        expect(calls).toEqual([first, second, third, second]);
    });

    it("uses a SHA-256 key and never exposes the plaintext PAT from the cache result", async () => {
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            introspect: async () => verifiedPat(),
        });

        const result = await verifyPat(PAT);

        expect(hashDaemonPatCacheKey("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        expect(hashDaemonPatCacheKey(PAT)).toMatch(/^[a-f0-9]{64}$/);
        expect(hashDaemonPatCacheKey(PAT)).not.toBe(PAT);
        expect(JSON.stringify(result)).not.toContain(PAT);
    });

    it("preserves cancellation rather than translating it into auth_unavailable", async () => {
        const controller = new AbortController();
        const cancelled = new DOMException("Stopped", "AbortError");
        controller.abort(cancelled);
        const verifyPat = createDaemonPatVerifier({
            accountId: "account-a",
            introspect: async () => verifiedPat(),
        });

        await expect(verifyPat(PAT, controller.signal)).rejects.toBe(cancelled);
    });
});
