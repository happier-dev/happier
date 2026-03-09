export type KeepForeverRetentionPolicy = Readonly<{
    mode: 'keep_forever';
}>;

export type DeleteOlderThanRetentionPolicy = Readonly<{
    mode: 'delete_older_than';
    days: number;
}>;

export type DeleteInactiveRetentionPolicy = Readonly<{
    mode: 'delete_inactive';
    inactivityDays: number;
}>;

export type RetentionAgePolicy = KeepForeverRetentionPolicy | DeleteOlderThanRetentionPolicy;
export type SessionRetentionPolicy = KeepForeverRetentionPolicy | DeleteInactiveRetentionPolicy;

export type RetentionDomainPolicies = Readonly<{
    sessions: SessionRetentionPolicy;
    accountChanges: RetentionAgePolicy;
    voiceSessionLeases: RetentionAgePolicy;
    userFeedItems: RetentionAgePolicy;
    sessionShareAccessLogs: RetentionAgePolicy;
    publicShareAccessLogs: RetentionAgePolicy;
    terminalAuthRequests: RetentionAgePolicy;
    accountAuthRequests: RetentionAgePolicy;
    authPairingSessions: RetentionAgePolicy;
    repeatKeys: RetentionAgePolicy;
    globalLocks: RetentionAgePolicy;
    automationRuns: RetentionAgePolicy;
    automationRunEvents: RetentionAgePolicy;
}>;

export type RetentionPolicy = Readonly<{
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    dryRun: boolean;
    maxDeletesPerRulePerRun: number;
    domains: RetentionDomainPolicies;
}>;
