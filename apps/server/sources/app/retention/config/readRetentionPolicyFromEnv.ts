import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { type ServerConfigEntry } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

import type {
    DeleteOlderThanRetentionPolicy,
    RetentionAgePolicy,
    RetentionDomainPolicies,
    RetentionPolicy,
    SessionRetentionPolicy,
} from './retentionPolicyTypes';
import { readRetentionDomainDefinitions } from '@/app/retention/config/retentionDomains';
import { RETENTION_SERVER_CONFIG as CONFIG } from '@/app/retention/config/retentionServerConfig';

const KEEP_FOREVER_POLICY = Object.freeze({ mode: 'keep_forever' as const });
const EMPTY_ENV = Object.freeze({}) as NodeJS.ProcessEnv;

/**
 * Why a retention key cannot be read: `required` when a deleting mode has no days, `invalid`
 * when the text does not parse. Thrown by the strict reader below.
 */
export class RetentionPolicyEnvError extends Error {
    constructor(readonly key: string, readonly reason: 'required' | 'invalid', message: string) {
        super(message);
        this.name = 'RetentionPolicyEnvError';
    }
}

/**
 * Retention keys are parsed strictly: an operator typo stops the server instead of silently
 * deleting on a different schedule. The key and its default come from the registry entry.
 */
function readPositiveIntConfig(env: NodeJS.ProcessEnv, entry: ServerConfigEntry & { default: number }): number {
    return parsePositiveInt({ env, key: entry.key, fallback: entry.default });
}

function parsePositiveInt(params: {
    env: NodeJS.ProcessEnv;
    key: string;
    fallback?: number;
}): number {
    const raw = String(params.env[params.key] ?? '').trim();
    if (!raw) {
        if (typeof params.fallback === 'number') return params.fallback;
        throw new RetentionPolicyEnvError(params.key, 'required', `${params.key} must be set`);
    }
    if (!/^\d+$/.test(raw)) {
        throw new RetentionPolicyEnvError(params.key, 'invalid', `${params.key} must be a positive integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RetentionPolicyEnvError(params.key, 'invalid', `${params.key} must be a positive integer`);
    }
    return value;
}

function readAgePolicy(params: {
    env: NodeJS.ProcessEnv;
    modeKey: string;
    daysKey: string;
    defaultPolicy: RetentionAgePolicy;
}): RetentionAgePolicy {
    const mode = String(params.env[params.modeKey] ?? '').trim().toLowerCase() || params.defaultPolicy.mode;
    if (mode === 'keep_forever') return KEEP_FOREVER_POLICY;
    if (mode !== 'delete_older_than') {
        throw new RetentionPolicyEnvError(params.modeKey, 'invalid', `${params.modeKey} must be keep_forever or delete_older_than`);
    }
    return Object.freeze({
        mode: 'delete_older_than',
        days: parsePositiveInt({ env: params.env, key: params.daysKey,
            ...(params.defaultPolicy.mode === 'delete_older_than' ? { fallback: params.defaultPolicy.days } : {}) }),
    }) satisfies DeleteOlderThanRetentionPolicy;
}

function readSessionPolicy(params: { env: NodeJS.ProcessEnv; modeKey: string; durationKey: string }): SessionRetentionPolicy {
    const mode = String(params.env[params.modeKey] ?? '').trim().toLowerCase();
    if (!mode || mode === 'keep_forever') return KEEP_FOREVER_POLICY;
    if (mode !== 'delete_inactive') {
        throw new RetentionPolicyEnvError(params.modeKey, 'invalid', `${params.modeKey} must be keep_forever or delete_inactive`);
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
            : readAgePolicy({ env, modeKey: config.modeKey, daysKey: config.durationKey, defaultPolicy: config.defaultPolicy });
        return [definition.id, policy] as const;
    });
    return Object.freeze(Object.fromEntries(entries)) as RetentionDomainPolicies;
}

export function readRetentionPolicyFromEnv(env: NodeJS.ProcessEnv): RetentionPolicy {
    const safeEnv = env ?? EMPTY_ENV;

    return Object.freeze({
        enabled: readServerConfig(safeEnv, CONFIG.HAPPIER_SERVER_RETENTION__ENABLED),
        intervalMs: readPositiveIntConfig(safeEnv, CONFIG.HAPPIER_SERVER_RETENTION__INTERVAL_MS),
        batchSize: readPositiveIntConfig(safeEnv, CONFIG.HAPPIER_SERVER_RETENTION__BATCH_SIZE),
        dryRun: readServerConfig(safeEnv, CONFIG.HAPPIER_SERVER_RETENTION__DRY_RUN),
        maxDeletesPerRulePerRun: readPositiveIntConfig(safeEnv, CONFIG.HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN),
        sweepTimeBudgetMs: readPositiveIntConfig(safeEnv, CONFIG.HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS),
        maxCandidatesPerRulePerRun: readPositiveIntConfig(
            safeEnv,
            CONFIG.HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN,
        ),
        domains: readDomainPolicies(safeEnv),
    });
}

/**
 * A Home write must leave the retention policy readable (plan §3.6): each key is validated on its
 * own by the registry, but a deleting mode also needs its days, so the whole prospective overlay is
 * read once with the strict reader. `null` when it reads; otherwise the first key it refused.
 */
export function findRetentionPolicyEnvProblem(env: NodeJS.ProcessEnv): Readonly<{ key: string; reason: 'required' | 'invalid' }> | null {
    try {
        readRetentionPolicyFromEnv(env);
        return null;
    } catch (error) {
        if (error instanceof RetentionPolicyEnvError) return { key: error.key, reason: error.reason };
        throw error;
    }
}
