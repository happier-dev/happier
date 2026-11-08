import { t } from '@/text';

const TRANSIENT_AVAILABILITY_CODES = [
    'database_connection_unavailable',
    'database_transaction_conflict_exhausted',
    'database_transaction_timeout',
    'project_requester_home_unavailable',
] as const;

export type TransientAvailabilityCode = typeof TRANSIENT_AVAILABILITY_CODES[number];

/** Neither connection loss nor deadline expiry alone establishes rollback. */
export function readTransientAvailabilityFailure(code: unknown): Readonly<{
    code: TransientAvailabilityCode;
    title: string;
    message: string;
    effectMayHaveApplied: boolean;
}> | null {
    const knownCode = TRANSIENT_AVAILABILITY_CODES.find(value => value === code);
    if (!knownCode) return null;
    const effectMayHaveApplied = knownCode === 'database_connection_unavailable' || knownCode === 'database_transaction_timeout';
    return {
        code: knownCode,
        title: t('approvals.transientFailureTitle'),
        message: t('approvals.transientFailure'),
        effectMayHaveApplied,
    };
}
