import { parseBooleanEnv } from '@happier-dev/protocol';

import type {
    DeleteOlderThanRetentionPolicy,
    RetentionAgePolicy,
    RetentionDomainPolicies,
    RetentionPolicy,
    SessionRetentionPolicy,
} from './retentionPolicyTypes';
import { readRetentionDomainDefinitions } from '@/app/retention/runtime/retentionRuleRegistry';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_DELETES_PER_RULE_PER_RUN = 100_000;
const DEFAULT_SWEEP_TIME_BUDGET_MS = 10_000;
const DEFAULT_MAX_CANDIDATES_PER_RULE_PER_RUN = 10_000;

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

function readSessionPolicy(params: { env: NodeJS.ProcessEnv; modeKey: string; durationKey: string }): SessionRetentionPolicy {
    const mode = String(params.env[params.modeKey] ?? '').trim().toLowerCase();
    if (!mode || mode === 'keep_forever') return KEEP_FOREVER_POLICY;
    if (mode !== 'delete_inactive') {
        throw new Error(`${params.modeKey} must be keep_forever or delete_inactive`);
    }
    return Object.freeze({
        mode: 'delete_inactive',
        inactivityDays: parsePositiveInt({
            env: params.env,
            key: params.durationKey,
        }),
    });
}

function readDomainPolicies(env: NodeJS.ProcessEnv): RetentionDomainPolicies {
    const entries = readRetentionDomainDefinitions().map((definition) => {
        const config = definition.policyConfig;
        const policy = config.kind === 'inactive'
            ? readSessionPolicy({ env, modeKey: config.modeKey, durationKey: config.durationKey })
            : readAgePolicy({ env, modeKey: config.modeKey, daysKey: config.durationKey });
        return [definition.id, policy] as const;
    });
    return Object.freeze(Object.fromEntries(entries)) as RetentionDomainPolicies;
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
        sweepTimeBudgetMs: parsePositiveInt({
            env: safeEnv,
            key: 'HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS',
            fallback: DEFAULT_SWEEP_TIME_BUDGET_MS,
        }),
        maxCandidatesPerRulePerRun: parsePositiveInt({
            env: safeEnv,
            key: 'HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN',
            fallback: DEFAULT_MAX_CANDIDATES_PER_RULE_PER_RUN,
        }),
        domains: readDomainPolicies(safeEnv),
    });
}
