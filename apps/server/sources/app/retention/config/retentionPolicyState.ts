import type {
    RetentionDomainPolicies,
    RetentionPolicy,
} from './retentionPolicyTypes';

const KEEP_FOREVER_POLICY = Object.freeze({ mode: 'keep_forever' as const });

export function hasFiniteRetentionDomains(policy: RetentionPolicy): boolean {
    return Object.values(policy.domains).some((domain) => domain.mode !== 'keep_forever');
}

export function resolveEffectiveRetentionEnabled(policy: RetentionPolicy): boolean {
    return policy.enabled && hasFiniteRetentionDomains(policy);
}

export function resolveEffectiveRetentionDomains(policy: RetentionPolicy): RetentionDomainPolicies {
    if (resolveEffectiveRetentionEnabled(policy)) {
        return policy.domains;
    }

    return Object.freeze(Object.fromEntries(
        Object.keys(policy.domains).map((id) => [id, KEEP_FOREVER_POLICY]),
    )) as RetentionDomainPolicies;
}
