import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";

import type { LocalServicePublicRateLimitDependencyEnv } from "@/app/features/catalog/readFeatureEnv";

export type LocalServicePublicRateLimitCheck = (
    input: Readonly<{ exposure: LocalServicePublicExposureV1; nowMs: number }>,
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
    return ({ exposure, nowMs }) => {
        const key = `${exposure.rateLimitProfileId}:${exposure.exposureId}`;
        const current = buckets.get(key);
        if (!current || nowMs - current.windowStartedAtMs >= dependency.windowMs) {
            buckets.set(key, { windowStartedAtMs: nowMs, count: 1 });
            return true;
        }

        current.count += 1;
        return current.count <= dependency.maxRequests;
    };
}
