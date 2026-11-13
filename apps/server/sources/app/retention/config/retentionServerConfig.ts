import { defineServerConfigRegistry, type ServerConfigEntry } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

import type { RetentionDomainPolicies } from '@/app/retention/config/retentionPolicyTypes';
import { readRetentionDomainDefinitions } from '@/app/retention/config/retentionDomains';

/**
 * The retention configuration keys (plan §3.6): the global switches and sweep resources declared
 * here, and two keys per retention domain derived from `retentionDomains.ts`, so a new domain
 * is declared by adding it there.
 *
 * Every key applies live: the worker resolves the policy through the Home overlay at every sweep
 * (cadence and resource caps included), and a dry run reads it per request.
 */

export const RETENTION_SERVER_CONFIG = defineServerConfigRegistry({
    HAPPIER_SERVER_RETENTION__ENABLED: {
        type: 'boolean',
        default: false,
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'data',
        family: 'retention',
        description: 'Deletes old records on the schedule each domain sets. Off keeps everything.',
    },
    HAPPIER_SERVER_RETENTION__DRY_RUN: {
        type: 'boolean',
        default: false,
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'data',
        family: 'retention',
        description: 'Reports what automatic deletion would remove without deleting anything.',
    },
    HAPPIER_SERVER_RETENTION__INTERVAL_MS: {
        type: 'int',
        default: 60 * 60 * 1000,
        bounds: { min: 1 },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'server',
        family: 'retention',
        description: 'Time between retention sweeps, in milliseconds.',
    },
    HAPPIER_SERVER_RETENTION__BATCH_SIZE: {
        type: 'int',
        default: 500,
        bounds: { min: 1 },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'server',
        family: 'retention',
        description: 'Rows deleted per batch by a retention rule.',
    },
    HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: {
        type: 'int',
        default: 100_000,
        bounds: { min: 1 },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'server',
        family: 'retention',
        description: 'Most rows one rule deletes in one sweep.',
    },
    HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: {
        type: 'int',
        default: 10_000,
        bounds: { min: 1 },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'server',
        family: 'retention',
        description: 'Time one sweep may spend before stopping, in milliseconds.',
    },
    HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: {
        type: 'int',
        default: 10_000,
        bounds: { min: 1 },
        sensitivity: 'plain',
        apply: 'live',
        editable: 'home',
        section: 'server',
        family: 'retention',
        description: 'Most candidate rows one rule examines in one sweep.',
    },
});

type RetentionDomainId = keyof RetentionDomainPolicies;

/** What each domain holds, and whether the console lists it with the user's records or under "System records". */
const RETENTION_DOMAIN_COPY = {
    sessions: { group: 'user', what: 'sessions with no activity' },
    sessionSidechainMessages: { group: 'user', what: 'sub-agent (sidechain) messages' },
    usageEvents: { group: 'user', what: 'usage events' },
    providerAccountUsageHistory: { group: 'user', what: 'detailed provider usage observations covered by daily summaries' },
    automationRuns: { group: 'user', what: 'automation runs' },
    automationRunEvents: { group: 'user', what: 'automation run events' },
    userFeedItems: { group: 'user', what: 'activity feed items' },
    accountChanges: { group: 'system', what: 'account change records used for sync' },
    voiceSessionLeases: { group: 'system', what: 'voice session leases' },
    sessionShareAccessLogs: { group: 'system', what: 'session share access logs' },
    publicShareAccessLogs: { group: 'system', what: 'public share access logs' },
    terminalAuthRequests: { group: 'system', what: 'terminal sign-in requests' },
    accountAuthRequests: { group: 'system', what: 'account sign-in requests' },
    authPairingSessions: { group: 'system', what: 'device pairing sessions' },
    repeatKeys: { group: 'system', what: 'repeat-request keys' },
    globalLocks: { group: 'system', what: 'expired global locks' },
    homeAdministrationEvents: { group: 'user', what: "this Home's administration events" },
} as const satisfies Record<RetentionDomainId, Readonly<{ group: 'user' | 'system'; what: string }>>;

/** Two entries per retention domain: its mode and its age (or inactivity) threshold in days. */
export const RETENTION_DOMAIN_SERVER_CONFIG: readonly ServerConfigEntry[] = Object.freeze(
    readRetentionDomainDefinitions().flatMap((definition): ServerConfigEntry[] => {
        const copy = RETENTION_DOMAIN_COPY[definition.id];
        const config = definition.policyConfig;
        const alwaysRuns = definition.runsWhenGlobalPolicyIsDisabled
            ? ' Runs even when automatic deletion is off.'
            : '';
        // `family` places the domain with the user's records or under "System records"; `group`
        // names the domain, so a client pairs its mode and days keys into one row.
        const shared = {
            sensitivity: 'plain',
            apply: 'live',
            editable: 'home',
            section: 'data',
            family: `retention.${copy.group}`,
            group: definition.id,
        } as const;
        const deleteMode = config.kind === 'inactive' ? 'delete_inactive' : 'delete_older_than';
        return [
            {
                ...shared,
                key: config.modeKey,
                type: 'enum',
                default: config.kind === 'age' ? config.defaultPolicy.mode : 'keep_forever',
                bounds: { values: ['keep_forever', deleteMode] },
                description: `Whether ${copy.what} are kept forever or deleted after a number of days.${alwaysRuns}`,
            },
            {
                ...shared,
                key: config.durationKey,
                type: 'int',
                ...(config.kind === 'age' && config.defaultPolicy.mode === 'delete_older_than'
                    ? { default: config.defaultPolicy.days } : {}),
                bounds: { min: 1 },
                description: config.kind === 'inactive'
                    ? `Days without activity before ${copy.what} are deleted. Required when deletion is on.`
                    : `Age in days after which ${copy.what} are deleted.${config.defaultPolicy.mode === 'delete_older_than' ? '' : ' Required when deletion is on.'}`,
            },
        ];
    }),
);
