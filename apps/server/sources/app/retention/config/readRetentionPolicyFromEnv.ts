import { parseBooleanEnv } from '@happier-dev/protocol';

import type {
    DeleteOlderThanRetentionPolicy,
    RetentionAgePolicy,
    RetentionDomainPolicies,
    RetentionPolicy,
    SessionRetentionPolicy,
} from './retentionPolicyTypes';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_DELETES_PER_RULE_PER_RUN = 1000;

const KEEP_FOREVER_POLICY = Object.freeze({ mode: 'keep_forever' as const });
const EMPTY_ENV = Object.freeze({}) as NodeJS.ProcessEnv;

function parsePositiveInt(params: {
    env: NodeJS.ProcessEnv;
    key: string;
    fallback?: number;
}): number {
    const raw = String(params.env[params.key] ?? '').trim();
    if (!raw) {
        if (typeof params.fallback === 'number') return params.fallback;
        throw new Error(`${params.key} must be set`);
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${params.key} must be a positive integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${params.key} must be a positive integer`);
    }
    return value;
}

function readAgePolicy(params: {
    env: NodeJS.ProcessEnv;
    modeKey: string;
    daysKey: string;
}): RetentionAgePolicy {
    const mode = String(params.env[params.modeKey] ?? '').trim().toLowerCase();
    if (!mode || mode === 'keep_forever') return KEEP_FOREVER_POLICY;
    if (mode !== 'delete_older_than') {
        throw new Error(`${params.modeKey} must be keep_forever or delete_older_than`);
    }
    return Object.freeze({
        mode: 'delete_older_than',
        days: parsePositiveInt({ env: params.env, key: params.daysKey }),
    }) satisfies DeleteOlderThanRetentionPolicy;
}

function readSessionPolicy(env: NodeJS.ProcessEnv): SessionRetentionPolicy {
    const mode = String(env.HAPPIER_SERVER_RETENTION__SESSIONS__MODE ?? '').trim().toLowerCase();
    if (!mode || mode === 'keep_forever') return KEEP_FOREVER_POLICY;
    if (mode !== 'delete_inactive') {
        throw new Error('HAPPIER_SERVER_RETENTION__SESSIONS__MODE must be keep_forever or delete_inactive');
    }
    return Object.freeze({
        mode: 'delete_inactive',
        inactivityDays: parsePositiveInt({
            env,
            key: 'HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS',
        }),
    });
}

function readDomainPolicies(env: NodeJS.ProcessEnv): RetentionDomainPolicies {
    return Object.freeze({
        sessions: readSessionPolicy(env),
        accountChanges: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS',
        }),
        voiceSessionLeases: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__VOICE_SESSION_LEASES__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__VOICE_SESSION_LEASES__DAYS',
        }),
        userFeedItems: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__USER_FEED_ITEMS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__USER_FEED_ITEMS__DAYS',
        }),
        sessionShareAccessLogs: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__SESSION_SHARE_ACCESS_LOGS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__SESSION_SHARE_ACCESS_LOGS__DAYS',
        }),
        publicShareAccessLogs: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__PUBLIC_SHARE_ACCESS_LOGS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__PUBLIC_SHARE_ACCESS_LOGS__DAYS',
        }),
        terminalAuthRequests: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__TERMINAL_AUTH_REQUESTS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__TERMINAL_AUTH_REQUESTS__DAYS',
        }),
        accountAuthRequests: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__ACCOUNT_AUTH_REQUESTS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__ACCOUNT_AUTH_REQUESTS__DAYS',
        }),
        authPairingSessions: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__AUTH_PAIRING_SESSIONS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__AUTH_PAIRING_SESSIONS__DAYS',
        }),
        repeatKeys: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__REPEAT_KEYS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__REPEAT_KEYS__DAYS',
        }),
        globalLocks: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__GLOBAL_LOCKS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__GLOBAL_LOCKS__DAYS',
        }),
        automationRuns: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__AUTOMATION_RUNS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__AUTOMATION_RUNS__DAYS',
        }),
        automationRunEvents: readAgePolicy({
            env,
            modeKey: 'HAPPIER_SERVER_RETENTION__AUTOMATION_RUN_EVENTS__MODE',
            daysKey: 'HAPPIER_SERVER_RETENTION__AUTOMATION_RUN_EVENTS__DAYS',
        }),
    });
}

export function readRetentionPolicyFromEnv(env: NodeJS.ProcessEnv): RetentionPolicy {
    const safeEnv = env ?? EMPTY_ENV;

    return Object.freeze({
        enabled: parseBooleanEnv(safeEnv.HAPPIER_SERVER_RETENTION__ENABLED, false),
        intervalMs: parsePositiveInt({
            env: safeEnv,
            key: 'HAPPIER_SERVER_RETENTION__INTERVAL_MS',
            fallback: DEFAULT_INTERVAL_MS,
        }),
        batchSize: parsePositiveInt({
            env: safeEnv,
            key: 'HAPPIER_SERVER_RETENTION__BATCH_SIZE',
            fallback: DEFAULT_BATCH_SIZE,
        }),
        dryRun: parseBooleanEnv(safeEnv.HAPPIER_SERVER_RETENTION__DRY_RUN, false),
        maxDeletesPerRulePerRun: parsePositiveInt({
            env: safeEnv,
            key: 'HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN',
            fallback: DEFAULT_MAX_DELETES_PER_RULE_PER_RUN,
        }),
        domains: readDomainPolicies(safeEnv),
    });
}
