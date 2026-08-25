import { describe, expect, it, vi } from "vitest";

import {
    PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1,
} from "@happier-dev/protocol";

import {
    chargePluginWebhookWorkingBytesV1,
    createPluginWebhookProcessAdmissionV1,
    createPluginWebhookRedisAdmissionV1,
    PLUGIN_WEBHOOK_WORKING_BYTES_PER_RAW_BYTE_V1,
} from "./admission";

describe("plugin webhook edge admission", () => {
    it("reserves aggregate process count and working bytes atomically before body work", () => {
        const admission = createPluginWebhookProcessAdmissionV1({
            maxRequests: 2,
            maxWorkingBytes: chargePluginWebhookWorkingBytesV1(10),
        });
        const first = admission.acquire(7);
        expect(first).not.toBeNull();
        expect(admission.snapshot()).toEqual({
            requests: 1,
            workingBytes: chargePluginWebhookWorkingBytesV1(7),
        });
        expect(admission.acquire(4)).toBeNull();
        expect(admission.snapshot()).toEqual({
            requests: 1,
            workingBytes: chargePluginWebhookWorkingBytesV1(7),
        });
        first?.release();
        expect(admission.snapshot()).toEqual({ requests: 0, workingBytes: 0 });
        first?.release();
        expect(admission.snapshot()).toEqual({ requests: 0, workingBytes: 0 });
    });

    it("charges the measured working memory a declared body costs, not the declared body", () => {
        // An operator budgeting one maximum-size request's raw length has NOT
        // budgeted the memory that request actually needs: the base64 string,
        // the parsed content, the sealed and re-encoded envelope, and the
        // delivery owner's re-parse are all reachable at once.
        const rawOnly = createPluginWebhookProcessAdmissionV1({
            maxRequests: 4,
            maxWorkingBytes: PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1,
        });
        expect(rawOnly.acquire(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1)).toBeNull();

        const budgeted = createPluginWebhookProcessAdmissionV1({
            maxRequests: 4,
            maxWorkingBytes: chargePluginWebhookWorkingBytesV1(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1),
        });
        expect(budgeted.acquire(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1)).not.toBeNull();
        expect(budgeted.acquire(1)).toBeNull();
    });

    it("keeps the charge above the highest measured plain and E2EE working-memory multiple", () => {
        // Source: apps/server/sources/app/plugins/webhooks/admission.ts records
        // 5.03x plain and 10.38x E2EE peak for this ingestion chain. A charge at
        // or below either figure would let a full process reservation exceed the
        // memory it claims to bound.
        const highestMeasuredMultiple = 10.38;
        expect(PLUGIN_WEBHOOK_WORKING_BYTES_PER_RAW_BYTE_V1).toBeGreaterThan(highestMeasuredMultiple);
        expect(chargePluginWebhookWorkingBytesV1(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1))
            .toBeGreaterThan(highestMeasuredMultiple * PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1);
    });

    it("never admits more concurrent peak memory than the process budget", () => {
        // The whole point of the byte ceiling: every request this process
        // admitted can be at its measured peak at the same moment, so the sum
        // of those peaks must stay inside the operator's budget. Charging the
        // raw body instead let the request count bind and blow straight past it.
        const measuredE2eePeakBytes = Math.ceil(10.38 * PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1);
        const budget = 3 * measuredE2eePeakBytes;
        const admission = createPluginWebhookProcessAdmissionV1({
            maxRequests: 4,
            maxWorkingBytes: budget,
        });

        let admitted = 0;
        while (admission.acquire(PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1) !== null) admitted += 1;

        expect(admitted).toBeGreaterThan(0);
        expect(admitted * measuredE2eePeakBytes).toBeLessThanOrEqual(budget);
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
