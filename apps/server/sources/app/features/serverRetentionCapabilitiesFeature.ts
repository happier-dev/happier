import type { FeaturesPayloadDelta } from './types';

import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { retentionPolicyToCapabilities } from '@/app/retention/config/retentionPolicyToCapabilities';

export function resolveServerRetentionCapabilitiesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const policy = readRetentionPolicyFromEnv(env);

    return {
        capabilities: {
            server: {
                retention: retentionPolicyToCapabilities(policy),
            },
        },
    };
}
