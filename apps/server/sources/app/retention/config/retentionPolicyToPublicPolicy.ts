import type { ServerRetentionDomainV2, ServerRetentionPolicyV2 } from '@happier-dev/protocol';

import { resolveEffectiveRetentionDomains, resolveEffectiveRetentionEnabled } from './retentionPolicyState';
import type { RetentionPolicy } from './retentionPolicyTypes';

export function retentionPolicyToPublicPolicy(policy: RetentionPolicy): ServerRetentionPolicyV2 {
    const domains = resolveEffectiveRetentionDomains(policy);
    const entries: ServerRetentionDomainV2[] = Object.entries(domains).map(([id, domainPolicy]) => ({
        id,
        policy: domainPolicy,
    }));

    return {
        version: 2,
        enabled: resolveEffectiveRetentionEnabled(policy),
        complete: true,
        domains: entries,
    };
}
