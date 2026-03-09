import { log } from '@/utils/logging/log';

export function logRetentionSweepCompleted(params: {
    reason: 'startup' | 'interval';
    deleted: number;
    byRule: Readonly<Record<string, number>>;
    dryRun: boolean;
}) {
    log(
        {
            module: 'retention-worker',
            reason: params.reason,
            deleted: params.deleted,
            byRule: params.byRule,
            dryRun: params.dryRun,
        },
        `Retention sweep ran (${params.reason})`,
    );
}

export function logRetentionSweepFailed(params: {
    reason: 'startup' | 'interval';
    error: unknown;
}) {
    log(
        {
            module: 'retention-worker',
            reason: params.reason,
            error: params.error instanceof Error ? params.error.message : String(params.error),
        },
        `Retention sweep failed (${params.reason})`,
    );
}
