import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";

import type { LocalServicePublicRateLimitDependencyEnv } from "@/app/features/catalog/readFeatureEnv";

export type LocalServicePublicRateLimitCheck = (
    input: Readonly<{
        exposure: LocalServicePublicExposureV1;
        clientKey: string;
        nowMs: number;
    }>,
) => boolean;

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

    const buckets = new Map<string, RateLimitBucket>();
    return ({ exposure, clientKey, nowMs }) => {
        // S-5: keyed by client AND exposure. A per-exposure-only bucket let one visitor consume
        // the whole window for everybody holding the link.
        const key = `${exposure.rateLimitProfileId}:${exposure.exposureId}:${clientKey}`;
        const current = buckets.get(key);
        if (!current || nowMs - current.windowStartedAtMs >= dependency.windowMs) {
            buckets.set(key, { windowStartedAtMs: nowMs, count: 1 });
            return true;
        }

        current.count += 1;
        return current.count <= dependency.maxRequests;
    };
}
