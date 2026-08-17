import { describe, expect, it, vi } from "vitest";

import {
    PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1,
} from "@happier-dev/protocol";

import {
    createPluginWebhookProcessAdmissionV1,
    createPluginWebhookRedisAdmissionV1,
} from "./admission";
import { resolvePluginWebhookIngressWorkingBytesV1 } from "./policy";

describe("plugin webhook edge admission", () => {
    it("reserves aggregate process count and declared bytes atomically before body work", () => {
        const admission = createPluginWebhookProcessAdmissionV1({ maxRequests: 2, maxBytes: 10 });
        const first = admission.acquire(7);
        expect(first).not.toBeNull();
        expect(admission.snapshot()).toEqual({ requests: 1, bytes: 7 });
        expect(admission.acquire(4)).toBeNull();
        expect(admission.snapshot()).toEqual({ requests: 1, bytes: 7 });
        first?.release();
        expect(admission.snapshot()).toEqual({ requests: 0, bytes: 0 });
        first?.release();
        expect(admission.snapshot()).toEqual({ requests: 0, bytes: 0 });
    });

    it("reserves the exact raw-body buffer allocated before ingress can authenticate or route", () => {
        const maxCharge = resolvePluginWebhookIngressWorkingBytesV1(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1);
        expect(maxCharge).toBe(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1);
        expect(resolvePluginWebhookIngressWorkingBytesV1(0)).toBe(0);
        expect(() => resolvePluginWebhookIngressWorkingBytesV1(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 + 1))
            .toThrow(/working-byte charge/i);

        const admission = createPluginWebhookProcessAdmissionV1({ maxRequests: 2, maxBytes: maxCharge });
        const first = admission.acquire(maxCharge);
        expect(first).not.toBeNull();
        expect(admission.acquire(1)).toBeNull();
        first?.release();
        expect(admission.snapshot()).toEqual({ requests: 0, bytes: 0 });
    });

    it("uses one atomic Redis acquisition and one owner-bound release for all tenant scopes", async () => {
        const evalCommand = vi.fn()
            .mockResolvedValueOnce([1, 0, 0])
            .mockResolvedValueOnce(1);
        const admission = createPluginWebhookRedisAdmissionV1({ eval: evalCommand });
        const lease = await admission.acquire([
            { key: "route:1", ratePerMinute: 600, concurrency: 16 },
            { key: "account:1", ratePerMinute: 3_000, concurrency: 32 },
        ], { nowMs: 1_000, ttlMs: 8_000, ownerToken: "owner-1" });
        expect(lease).toMatchObject({ ok: true });
        if (!lease.ok) throw new Error("expected distributed reservation");
        await lease.release();
        expect(evalCommand).toHaveBeenCalledTimes(2);
        expect(evalCommand.mock.calls[0]?.[1]).toBe(4);
        expect(evalCommand.mock.calls[1]?.[1]).toBe(2);
    });

    it("fails closed with a bounded retry when Redis rejects or is unavailable", async () => {
        const rejected = createPluginWebhookRedisAdmissionV1({ eval: vi.fn(async () => [0, 2_500, 1]) });
        await expect(rejected.acquire(
            [{ key: "route:1", ratePerMinute: 1, concurrency: 1 }],
            { nowMs: 1_000, ttlMs: 8_000, ownerToken: "owner-1" },
        )).resolves.toEqual({ ok: false, code: "rate", retryAfterMs: 2_500 });

        const concurrent = createPluginWebhookRedisAdmissionV1({ eval: vi.fn(async () => [0, 8_000, 2]) });
        await expect(concurrent.acquire(
            [{ key: "route:1", ratePerMinute: 1, concurrency: 1 }],
            { nowMs: 1_000, ttlMs: 8_000, ownerToken: "owner-1" },
        )).resolves.toEqual({ ok: false, code: "concurrency", retryAfterMs: 8_000 });

        const unavailable = createPluginWebhookRedisAdmissionV1({ eval: vi.fn(async () => { throw new Error("secret transport detail"); }) });
        await expect(unavailable.acquire(
            [{ key: "route:1", ratePerMinute: 1, concurrency: 1 }],
            { nowMs: 1_000, ttlMs: 8_000, ownerToken: "owner-1" },
        )).resolves.toEqual({ ok: false, code: "unavailable", retryAfterMs: 5_000 });
    });
});
