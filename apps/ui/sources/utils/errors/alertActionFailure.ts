import { Modal } from '@/modal';
import { t } from '@/text';
import { ActionRefusalDiagnosticV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

export type ActionFailureContext = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Technical details admit safe reference fields and the protocol's closed refusal reason.
 * Arbitrary producer prose, paths, tokens and nested payloads stay private.
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
    const diagnostic = ActionRefusalDiagnosticV1Schema.safeParse(record.diagnostic);
    if (diagnostic.success) safe.reason = diagnostic.data.reason;
    return safe;
}

/** The deliberate reveal shared by inline recovery and failure alerts. */
export function showActionFailureDetails(failure: Readonly<{ code: string; context?: ActionFailureContext }>): void {
    const details = failure.context && Object.keys(failure.context).length > 0
        ? JSON.stringify({ code: failure.code, ...failure.context }, null, 2)
        : failure.code;
    Modal.alert(t('approvals.technicalDetails'), details);
}

/** Deliberate disclosure of a typed Action failure, never its private transport details. */
export function alertActionFailure(failure: Readonly<{
    title?: string;
    reason: string;
    code: string | null;
    requestId?: string | null;
    context?: ActionFailureContext;
    recovery?: Readonly<{ label: string; onPress: () => void }>;
}>): void {
    const code = failure.code;
    if (!code) {
        Modal.alert(t('common.error'), failure.reason);
        return;
    }
    const uncertain = code === RPC_ERROR_CODES.OUTCOME_UNKNOWN;
    Modal.alert(
        failure.title ?? t(uncertain ? 'toolView.pending.unknownTitle' : 'common.error'),
        uncertain ? t('toolView.pending.unknownDescription') : failure.reason,
        [
            ...(failure.recovery ? [{ text: failure.recovery.label, onPress: failure.recovery.onPress }] : []),
            { text: t('approvals.technicalDetails'), onPress: () => showActionFailureDetails({ code, context: {
                ...failure.context,
                ...(failure.requestId ? { requestId: failure.requestId } : {}),
            } }) },
            { text: t('common.ok'), style: 'cancel' },
        ],
    );
}
