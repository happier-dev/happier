import type {
    KeepForeverRetentionPolicy,
    RetentionDomainPolicies,
    RetentionPolicy,
    SessionRetentionPolicy,
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

    return Object.freeze({
        sessions: KEEP_FOREVER_POLICY as SessionRetentionPolicy,
        accountChanges: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        voiceSessionLeases: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        userFeedItems: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        sessionShareAccessLogs: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        publicShareAccessLogs: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        terminalAuthRequests: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        accountAuthRequests: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        authPairingSessions: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        repeatKeys: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        globalLocks: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        automationRuns: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
        automationRunEvents: KEEP_FOREVER_POLICY as KeepForeverRetentionPolicy,
    });
}
