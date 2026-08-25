import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";

import type { LocalServicePublicRateLimitDependencyEnv } from "@/app/features/catalog/readFeatureEnv";

export type LocalServicePublicRateLimitCheck = (
    input: Readonly<{
        exposure: LocalServicePublicExposureV1;
        clientKey: string;
        nowMs: number;
    }>,
) => boolean;

/**
 * Ceiling on simultaneously tracked buckets (F-3).
 *
 * The resource this protects is the relay process's memory. `clientKey` is `request.ip`, which
 * honours the server's `trustProxy` setting, so on a reverse-proxy deployment an UNAUTHENTICATED
 * visitor to a public exposure controls the key through `X-Forwarded-For`. A bucket is a short key
 * plus two numbers — order 150 bytes — so this ceiling bounds the limiter to a couple of megabytes
 * while sitting far above the distinct-client count a single-process V1 self-hosted relay serves
 * inside one window.
 */
export const LOCAL_SERVICE_PUBLIC_MAX_TRACKED_RATE_LIMIT_BUCKETS = 10_000;

/**
 * Shared bucket used once the ceiling is reached. Sharing makes an overflowing client MORE limited,
 * never less, so the failure direction stays closed.
 */
const OVERFLOW_BUCKET_KEY = "__overflow__";

type RateLimitBucket = {
    windowStartedAtMs: number;
    count: number;
};

export function createLocalServicePublicRateLimitChecker(
    dependency: LocalServicePublicRateLimitDependencyEnv,
): LocalServicePublicRateLimitCheck | undefined {
    if (dependency.kind === "test_dev") {
        return () => true;
    }
    if (dependency.kind !== "fixed_window") {
        return undefined;
    }

    // Captured as a `const` so the `fixed_window` narrowing above reaches the helpers below;
    // narrowing on a mutable parameter binding does not propagate into hoisted declarations.
    const fixedWindow = dependency;
    const buckets = new Map<string, RateLimitBucket>();
    let nextReclaimAtMs = Number.NEGATIVE_INFINITY;

    function isWindowElapsed(bucket: RateLimitBucket, nowMs: number): boolean {
        return nowMs - bucket.windowStartedAtMs >= fixedWindow.windowMs;
    }

    // F-3: retention is bounded by the window the limiter already reasons about. A bucket whose
    // window has elapsed carries no state worth keeping, so it is reclaimed. Reclaiming at most
    // once per window keeps this O(1) amortised instead of a scan per request, and needs no timer.
    function reclaimElapsedBuckets(nowMs: number): void {
        if (nowMs < nextReclaimAtMs) return;
        nextReclaimAtMs = nowMs + fixedWindow.windowMs;
        for (const [key, bucket] of buckets) {
            if (isWindowElapsed(bucket, nowMs)) buckets.delete(key);
        }
    }

    function resolveBucketKey(requestedKey: string): string {
        if (buckets.has(requestedKey) || buckets.size < LOCAL_SERVICE_PUBLIC_MAX_TRACKED_RATE_LIMIT_BUCKETS) {
            return requestedKey;
        }
        return OVERFLOW_BUCKET_KEY;
    }

    return ({ exposure, clientKey, nowMs }) => {
        reclaimElapsedBuckets(nowMs);
        // S-5: keyed by client AND exposure. A per-exposure-only bucket let one visitor consume
        // the whole window for everybody holding the link.
        const key = resolveBucketKey(`${exposure.rateLimitProfileId}:${exposure.exposureId}:${clientKey}`);
        const current = buckets.get(key);
        if (!current || isWindowElapsed(current, nowMs)) {
            buckets.set(key, { windowStartedAtMs: nowMs, count: 1 });
            return true;
        }

        current.count += 1;
        return current.count <= fixedWindow.maxRequests;
    };
}
