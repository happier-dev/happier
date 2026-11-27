import type { FeaturesPayloadDelta } from './types';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { resolveLimitTable } from '@/app/plans/accountLimits';
import { retentionPolicyToCapabilities } from '@/app/retention/config/retentionPolicyToCapabilities';

export function resolveServerRetentionCapabilitiesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const policy = readRetentionPolicyFromEnv(env);
    const retention = retentionPolicyToCapabilities(policy, resolveLimitTable(env));
    if (!retention.enabled) return {};

    return {
        capabilities: {
            server: {
                retention,
            },
        },
    };
}
