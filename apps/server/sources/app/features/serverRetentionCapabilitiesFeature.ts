import type { FeaturesPayloadDelta } from './types';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { resolveEffectiveRetentionEnabled } from '@/app/retention/config/retentionPolicyState';
import { retentionPolicyToCapabilities } from '@/app/retention/config/retentionPolicyToCapabilities';

export function resolveServerRetentionCapabilitiesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const policy = readRetentionPolicyFromEnv(env);
    if (!resolveEffectiveRetentionEnabled(policy)) {
        return {};
    }

    return {
        capabilities: {
            server: {
                retention: retentionPolicyToCapabilities(policy),
            },
        },
    };
}
