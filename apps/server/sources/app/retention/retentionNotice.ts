import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

import { RETENTION_SERVER_CONFIG } from './config/retentionServerConfig';
import { RetentionPolicyEnvError } from './config/readRetentionPolicyFromEnv';
import type { RetentionPolicy } from './config/retentionPolicyTypes';



export const RETENTION_DAY_MS = 86_400_000;

export function readRetentionStartsAt(env: NodeJS.ProcessEnv): number | undefined {
    const value = readServerConfig(env, RETENTION_SERVER_CONFIG.HAPPIER_SERVER_RETENTION__STARTS_AT)?.trim();
    if (!value) return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new RetentionPolicyEnvError(
        RETENTION_SERVER_CONFIG.HAPPIER_SERVER_RETENTION__STARTS_AT.key, 'invalid', 'Retention start must be a valid timestamp',
    );
    return parsed;
}

export function isSessionRetentionEnforcing(policy: RetentionPolicy, now: Date): boolean {
    return policy.enabled && policy.dryRun === false && policy.startsAt !== undefined && now.getTime() >= policy.startsAt;
}

export function resolveRetentionNoticeRule(params: {
    policy: RetentionPolicy;
    now: Date;
    retentionDays: number | null;
    graceEndsAt?: number | null;
}) {
    const { policy, now, retentionDays, graceEndsAt } = params;
    if (!policy.enabled || policy.startsAt === undefined || retentionDays === null) return null;
    const noticeDays = policy.noticeDays ?? RETENTION_SERVER_CONFIG.HAPPIER_SERVER_RETENTION__NOTICE_DAYS.default;
    const floorAt = Math.max(policy.startsAt, graceEndsAt ?? policy.startsAt);
    if (now.getTime() < floorAt - noticeDays * RETENTION_DAY_MS) return null;
    return { retentionDays, noticeDays, floorAt };
}
