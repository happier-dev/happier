import { Modal } from '@/modal';
import { t, type TranslationKeyNoParams } from '@/text';
import { type ActionFailureCauseV1, ActionRefusalDiagnosticV1Schema, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
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

/** The names Technical details give the references they reveal; a key without one is shown as itself. */
export const ACTION_FAILURE_DETAIL_LABELS = {
    code: 'common.error',
    phase: 'approvals.failureTechnicalLabels.phase',
    causePhase: 'approvals.failureTechnicalLabels.causePhase',
    causeCode: 'approvals.failureTechnicalLabels.causeCode',
    errorClass: 'approvals.failureTechnicalLabels.errorClass',
    nativeErrorCode: 'approvals.failureTechnicalLabels.nativeErrorCode',
    nativeErrorReason: 'approvals.failureTechnicalLabels.nativeErrorReason',
    effectAttempted: 'approvals.failureTechnicalLabels.effectAttempted',
    httpStatus: 'approvals.failureTechnicalLabels.httpStatus',
    requestId: 'approvals.failureTechnicalLabels.requestId',
    reason: 'approvals.failureTechnicalLabels.reason',
    step: 'approvals.failureTechnicalLabels.step',
    signal: 'approvals.failureTechnicalLabels.signal',
    requiredFact: 'approvals.failureTechnicalLabels.requiredFact',
    remedy: 'approvals.failureTechnicalLabels.remedy',
    targetHome: 'common.home',
} as const satisfies Record<string, TranslationKeyNoParams>;

/** Technical details as one labelled line per reference ("Error: outcome_unknown"), never a JSON dump. */
type ActionFailureDetails = Readonly<{ code: string; context?: ActionFailureContext; failureCause?: ActionFailureCauseV1 }>;

export function formatActionFailureDetails(failure: ActionFailureDetails): string {
    const cause = failure.failureCause;
    const causeContext: Record<string, string | number | boolean | null> = {};
    // Preserve the closed cause's scalar facts; nested payloads are never coerced to prose.
    if (cause) {
        for (const [key, value] of Object.entries(cause)) {
            if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                causeContext[key === 'errorCode' ? 'causeCode' : key] = value;
            }
        }
        Object.assign(causeContext, readSafeFailureDetails('diagnostic' in cause ? { diagnostic: cause.diagnostic } : undefined));
    }
    const labels: Readonly<Record<string, TranslationKeyNoParams>> = ACTION_FAILURE_DETAIL_LABELS;
    return Object.entries({ code: failure.code, ...failure.context,
        ...causeContext,
    })
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${labels[key] ? t(labels[key]) : key}: ${String(value)}`)
        .join('\n');
}

/** The deliberate reveal shared by inline recovery and failure alerts. */
export function showActionFailureDetails(failure: ActionFailureDetails): void {
    Modal.alert(t('approvals.technicalDetails'), formatActionFailureDetails(failure));
}

/** Deliberate disclosure of a typed Action failure, never its private transport details. */
export function alertActionFailure(failure: Readonly<{
    title?: string;
    reason: string;
    code: string | null;
    requestId?: string | null;
    context?: ActionFailureContext;
    failureCause?: ActionFailureCauseV1;
    recovery?: Readonly<{ label: string; onPress: () => void }>;
}>): void {
    const code = failure.code;
    if (!code) {
        Modal.alert(t('common.error'), failure.reason);
        return;
    }
    const uncertain = isActionOutcomeUnknownErrorCodeV1(code);
    Modal.alert(
        failure.title ?? t(uncertain ? 'toolView.pending.unknownTitle' : 'common.error'),
        uncertain ? t('toolView.pending.unknownDescription') : failure.reason,
        [
            ...(failure.recovery ? [{ text: failure.recovery.label, onPress: failure.recovery.onPress }] : []),
            { text: t('approvals.technicalDetails'), quiet: true, onPress: () => showActionFailureDetails({ code, failureCause: failure.failureCause, context: {
                ...failure.context,
                ...(failure.requestId ? { requestId: failure.requestId } : {}),
            } }) },
            { text: t('common.ok'), style: 'cancel' },
        ],
    );
}
