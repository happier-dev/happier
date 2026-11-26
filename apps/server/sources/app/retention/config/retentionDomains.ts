import type { RetentionAgePolicy, RetentionDomainPolicies } from './retentionPolicyTypes';

/**
 * The retention domains: each one's id, the env keys of its mode and days, and whether it runs even
 * when the global policy is off. Configuration owners (the registry family, the policy reader) read
 * this light module; `retentionRuleRegistry.ts` pairs each domain with its rule, so configuration
 * never loads rule implementations (and their database dependencies).
 */
export type RetentionDomainId = keyof RetentionDomainPolicies;

export type RetentionDomainPolicyConfig = Readonly<
    | { kind: 'inactive'; modeKey: string; durationKey: string }
    | { kind: 'age'; modeKey: string; durationKey: string; defaultPolicy: RetentionAgePolicy }
>;

export type RetentionDomainDefinition = Readonly<{
    id: RetentionDomainId;
    policyConfig: RetentionDomainPolicyConfig;
    /**
     * The domain's rule runs, with its own policy, even when the global switch is off: Account-owned
     * retention, intrinsic expiry, or a default the owner ruled must hold out of the box. The
     * operator still turns it off per domain (`keep_forever`).
     */
    runsWhenGlobalPolicyIsDisabled?: true;
}>;

function ageConfig(envName: string, defaultPolicy: RetentionAgePolicy = { mode: 'keep_forever' }): RetentionDomainPolicyConfig {
    return {
        kind: 'age',
        modeKey: `HAPPIER_SERVER_RETENTION__${envName}__MODE`,
        durationKey: `HAPPIER_SERVER_RETENTION__${envName}__DAYS`,
        defaultPolicy,
    };
}

const RETENTION_DOMAIN_DEFINITIONS = Object.freeze({
    sessions: {
        id: 'sessions',
        policyConfig: {
            kind: 'inactive',
            modeKey: 'HAPPIER_SERVER_RETENTION__SESSIONS__MODE',
            durationKey: 'HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS',
        },
    },
    sessionSidechainMessages: { id: 'sessionSidechainMessages', policyConfig: ageConfig('SESSION_SIDECHAIN_MESSAGES') },
    toolOutputs: { id: 'toolOutputs', policyConfig: ageConfig('TOOL_OUTPUTS') },
    accountChanges: { id: 'accountChanges', policyConfig: ageConfig('ACCOUNT_CHANGES') },
    usageEvents: { id: 'usageEvents', policyConfig: ageConfig('USAGE_EVENTS') },
    // Owner ruling 2026-11-12: 90 days of detail, then daily summaries, with automatic deletion off too.
    providerAccountUsageHistory: {
        id: 'providerAccountUsageHistory',
        policyConfig: ageConfig('PROVIDER_ACCOUNT_USAGE_HISTORY', { mode: 'delete_older_than', days: 90 }),
    },
    voiceSessionLeases: { id: 'voiceSessionLeases', policyConfig: ageConfig('VOICE_SESSION_LEASES') },
    userFeedItems: { id: 'userFeedItems', policyConfig: ageConfig('USER_FEED_ITEMS') },
    // Owner ruling 2026-11-15 (Growth decisions final): access logs keep 90 days by default,
    // whether or not the operator turned on automatic deletion for the other domains.
    publicShareAccessLogs: {
        id: 'publicShareAccessLogs',
        policyConfig: ageConfig('PUBLIC_SHARE_ACCESS_LOGS', { mode: 'delete_older_than', days: 90 }),
        runsWhenGlobalPolicyIsDisabled: true,
    },
    terminalAuthRequests: { id: 'terminalAuthRequests', policyConfig: ageConfig('TERMINAL_AUTH_REQUESTS') },
    accountAuthRequests: { id: 'accountAuthRequests', policyConfig: ageConfig('ACCOUNT_AUTH_REQUESTS') },
    authPairingSessions: {
        id: 'authPairingSessions',
        policyConfig: ageConfig('AUTH_PAIRING_SESSIONS'),
        runsWhenGlobalPolicyIsDisabled: true,
    },
    repeatKeys: {
        id: 'repeatKeys',
        policyConfig: ageConfig('REPEAT_KEYS'),
        runsWhenGlobalPolicyIsDisabled: true,
    },
    globalLocks: { id: 'globalLocks', policyConfig: ageConfig('GLOBAL_LOCKS') },
    automationRuns: {
        id: 'automationRuns',
        policyConfig: ageConfig('AUTOMATION_RUNS'),
        runsWhenGlobalPolicyIsDisabled: true,
    },
    automationRunEvents: { id: 'automationRunEvents', policyConfig: ageConfig('AUTOMATION_RUN_EVENTS') },
    homeAdministrationEvents: { id: 'homeAdministrationEvents', policyConfig: ageConfig('HOME_ADMINISTRATION_EVENTS') },
    reviews: { id: 'reviews', policyConfig: ageConfig('REVIEWS') },
} satisfies Record<RetentionDomainId, RetentionDomainDefinition>);

export function readRetentionDomainDefinitions(): readonly RetentionDomainDefinition[] {
    return Object.values(RETENTION_DOMAIN_DEFINITIONS);
}

/**
 * This module, rather than a second startup list, owns which domains have an Account-level
 * contract independent of global operator retention settings.
 */
export function hasRetentionRulesThatRunWhenGlobalPolicyIsDisabled(): boolean {
    return readRetentionDomainDefinitions().some(
        (definition) => definition.runsWhenGlobalPolicyIsDisabled === true,
    );
}
