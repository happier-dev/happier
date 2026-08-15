import type { FeaturesResponse, ServerRetentionDomainPolicyV2, ServerRetentionPolicyV2 } from '@happier-dev/protocol';

export type LegacyServerRetentionPolicy = NonNullable<FeaturesResponse['capabilities']['server']['retention']>;

export type ServerRetentionDomainView = Readonly<{
    id: string;
    policy: ServerRetentionDomainPolicyV2;
}>;

export type ServerRetentionPolicyView = Readonly<{
    enabled: boolean;
    completeness: 'complete' | 'legacy_partial';
    domains: readonly ServerRetentionDomainView[];
}>;

export type ServerRetentionPolicy = LegacyServerRetentionPolicy | ServerRetentionPolicyView;

export function normalizeServerRetentionPolicyV2(policy: ServerRetentionPolicyV2): ServerRetentionPolicyView {
    return {
        enabled: policy.enabled,
        completeness: 'complete',
        domains: policy.domains,
    };
}

export function normalizeLegacyServerRetentionPolicy(policy: LegacyServerRetentionPolicy): ServerRetentionPolicyView {
    return {
        enabled: policy.enabled,
        completeness: 'legacy_partial',
        domains: Object.entries(policy).flatMap<ServerRetentionDomainView>(([id, value]) => {
            if (id === 'policyVersion' || id === 'enabled' || !value || typeof value !== 'object' || !('mode' in value)) {
                return [];
            }
            if (value.mode === 'keep_forever') return [{ id, policy: { mode: 'keep_forever' as const } }];
            if (value.mode === 'delete_older_than') {
                return [{ id, policy: { mode: 'delete_older_than' as const, days: value.days } }];
            }
            if (value.mode === 'delete_inactive') {
                return [{ id, policy: { mode: 'delete_inactive' as const, inactivityDays: value.inactivityDays } }];
            }
            return [];
        }),
    };
}

export function normalizeServerRetentionPolicy(policy: ServerRetentionPolicy): ServerRetentionPolicyView {
    return 'domains' in policy ? policy : normalizeLegacyServerRetentionPolicy(policy);
}

export function readServerRetentionPolicy(features: FeaturesResponse): ServerRetentionPolicyView | null {
    const retention = features.capabilities.server.retention;
    return retention ? normalizeLegacyServerRetentionPolicy(retention) : null;
}

export function hasFiniteRetentionPolicy(policy: ServerRetentionPolicy | null | undefined): boolean {
    if (!policy) return false;
    const view = normalizeServerRetentionPolicy(policy);
    return view.enabled && view.domains.some((domain) => domain.policy.mode !== 'keep_forever');
}
