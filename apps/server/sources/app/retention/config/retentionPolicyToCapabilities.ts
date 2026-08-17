import type { ServerRetentionCapabilities } from '@happier-dev/protocol';

import type { RetentionPolicy } from './retentionPolicyTypes';
import { resolveEffectiveRetentionDomains, resolveEffectiveRetentionEnabled } from './retentionPolicyState';

function toAgePolicyCapability(policy: RetentionPolicy['domains'][Exclude<keyof RetentionPolicy['domains'], 'sessions'>]) {
    if (policy.mode === 'keep_forever') return { mode: 'keep_forever' } as const;
    return {
        mode: 'delete_older_than',
        days: policy.days,
    } as const;
}

export function retentionPolicyToCapabilities(policy: RetentionPolicy): ServerRetentionCapabilities {
    const enabled = resolveEffectiveRetentionEnabled(policy);
    const domains = resolveEffectiveRetentionDomains(policy);
    const sessions =
        domains.sessions.mode === 'keep_forever'
            ? { mode: 'keep_forever' as const }
            : {
                mode: 'delete_inactive' as const,
                inactivityDays: domains.sessions.inactivityDays,
                requires: ['updatedAt', 'lastActiveAt'] as ['updatedAt', 'lastActiveAt'],
            };

    return {
        policyVersion: 1,
        enabled,
        sessions,
        accountChanges: toAgePolicyCapability(domains.accountChanges),
        voiceSessionLeases: toAgePolicyCapability(domains.voiceSessionLeases),
        userFeedItems: toAgePolicyCapability(domains.userFeedItems),
        sessionShareAccessLogs: toAgePolicyCapability(domains.sessionShareAccessLogs),
        publicShareAccessLogs: toAgePolicyCapability(domains.publicShareAccessLogs),
        terminalAuthRequests: toAgePolicyCapability(domains.terminalAuthRequests),
        accountAuthRequests: toAgePolicyCapability(domains.accountAuthRequests),
        authPairingSessions: toAgePolicyCapability(domains.authPairingSessions),
        repeatKeys: toAgePolicyCapability(domains.repeatKeys),
        globalLocks: toAgePolicyCapability(domains.globalLocks),
        automationRuns: toAgePolicyCapability(domains.automationRuns),
        automationRunEvents: toAgePolicyCapability(domains.automationRunEvents),
    };
}
