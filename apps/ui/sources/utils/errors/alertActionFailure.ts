import { Modal } from '@/modal';
import { t } from '@/text';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

export type ActionFailureContext = Readonly<Record<string, string | number | boolean | null>>;

/**
 * The only fields of a failure's details that may reach the screen: closed reason vocabulary. A field
 * outside this list, a nested structure and any value that is not a code or a flag (producer prose,
 * paths, tokens, approval payloads) stay out of Technical details.
 */
const SAFE_FAILURE_DETAIL_KEYS = ['reason', 'reasonCode', 'status', 'retryable', 'busySource', 'errorCode', 'kind'] as const;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]*$/;
const SAFE_RPC_FAILURE_CODES: ReadonlySet<string> = new Set([...Object.values(RPC_ERROR_CODES), MACHINE_RPC_TIMEOUT_ERROR_CODE]);

export function readSafeFailureDetails(details: unknown): ActionFailureContext {
    if (typeof details !== 'object' || details === null || Array.isArray(details)) return {};
    const record = details as Record<string, unknown>;
    const safe: Record<string, string | boolean> = {};
    for (const key of SAFE_FAILURE_DETAIL_KEYS) {
        const value = record[key];
        if (typeof value === 'boolean' || (typeof value === 'string'
            && (SAFE_FAILURE_CODE.test(value) || SAFE_RPC_FAILURE_CODES.has(value)))) safe[key] = value;
    }
    return safe;
}

/** Deliberate disclosure of a typed Action failure, never its private transport details. */
export function alertActionFailure(failure: Readonly<{
    reason: string;
    code: string | null;
    context?: ActionFailureContext;
    recovery?: Readonly<{ label: string; onPress: () => void }>;
}>): void {
    if (!failure.code) {
        Modal.alert(t('common.error'), failure.reason);
        return;
    }
    const details = failure.context && Object.keys(failure.context).length > 0
        ? JSON.stringify({ code: failure.code, ...failure.context }, null, 2)
        : failure.code;
    const uncertain = failure.code === RPC_ERROR_CODES.OUTCOME_UNKNOWN;
    Modal.alert(
        t(uncertain ? 'toolView.pending.unknownTitle' : 'common.error'),
        uncertain ? t('toolView.pending.unknownDescription') : failure.reason,
        [
            ...(failure.recovery ? [{ text: failure.recovery.label, onPress: failure.recovery.onPress }] : []),
            { text: t('approvals.technicalDetails'), onPress: () => Modal.alert(t('approvals.technicalDetails'), details) },
            { text: t('common.ok'), style: 'cancel' },
        ],
    );
}
