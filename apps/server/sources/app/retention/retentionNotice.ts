import type { RetentionPolicy } from './config/retentionPolicyTypes';

const STARTS_AT_ENV = 'HAPPIER_SERVER_RETENTION__STARTS_AT';
export const DEFAULT_RETENTION_NOTICE_DAYS = 7;
export const RETENTION_DAY_MS = 86_400_000;

export function readRetentionStartsAt(env: NodeJS.ProcessEnv): number | undefined {
    const value = env[STARTS_AT_ENV]?.trim();
    if (!value) return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`${STARTS_AT_ENV} must be a valid timestamp`);
    return parsed;
}

export function isSessionRetentionEnforcing(policy: RetentionPolicy, now: Date): boolean {
    return policy.enabled && policy.dryRun === false && policy.startsAt !== undefined && now.getTime() >= policy.startsAt;
}

export function resolveRetentionNoticeRule(params: {
    policy: RetentionPolicy;
    retentionDays: number | null;
    graceEndsAt?: number | null;
}) {
    const { policy, retentionDays, graceEndsAt } = params;
    if (!policy.enabled || policy.startsAt === undefined || retentionDays === null) return null;
    const noticeDays = policy.noticeDays ?? DEFAULT_RETENTION_NOTICE_DAYS;
    const floorAt = Math.max(policy.startsAt, graceEndsAt ?? policy.startsAt);
    return { retentionDays, noticeDays, floorAt };
}

export function isRetentionNoticeWindowOpen(rule: Readonly<{ floorAt: number; noticeDays: number }>, now: Date): boolean {
    return now.getTime() >= rule.floorAt - rule.noticeDays * RETENTION_DAY_MS;
}
