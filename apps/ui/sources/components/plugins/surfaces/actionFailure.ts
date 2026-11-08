import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE,
    PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE,
    projectPluginActionUnavailableOutcomeCode,
    readPluginActionFailureAuthorPayload,
    pluginActionDeclarationIsReadOnlyForInput,
    type PluginActionInvocationResult,
} from '@happier-dev/protocol/plugins/actions/invocation';
import type { PluginDiagnosticRemediationV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import type { PluginUiHostApiErrorPayloadV1, PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiActionProjection } from '@/sync/domains/plugins/ui/projection';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';

import {
    createPluginSurfaceHostApiError,
    createPluginSurfaceHostApiPluginErrorData,
    readPluginSurfaceHostApiFailureMetadata,
} from './createPluginSurfaceHostApi';

export type PluginSurfaceActionDispatchOutcome =
    | Readonly<{ ok: true; result: PluginUiJsonValueV1 }>
    | Readonly<{
        ok: false;
        code: string;
        reason: string;
        message?: string;
        retryable?: boolean;
        remediation?: PluginDiagnosticRemediationV1;
        diagnostics?: readonly string[];
        layer?: PluginUiHostApiErrorPayloadV1['layer'];
        phase?: PluginUiHostApiErrorPayloadV1['phase'];
        details?: PluginUiJsonValueV1;
        failureCause?: ActionFailureCauseV1;
    }>;

type Failure = Extract<PluginSurfaceActionDispatchOutcome, Readonly<{ ok: false }>>;
type FailureMetadata = Omit<Failure, 'ok' | 'code' | 'reason'>;
type ActionEffectDeclaration = Pick<PluginUiActionProjection, 'readOnly' | 'accountActionDeclaration'>;

export function createPluginSurfaceActionFailure(code: string, reason: string, author?: FailureMetadata): Failure {
    return {
        ok: false, code, reason,
        ...(author?.message === undefined ? {} : { message: author.message }),
        ...(author?.retryable === undefined ? {} : { retryable: author.retryable }),
        ...(author?.remediation === undefined ? {} : { remediation: author.remediation }),
        ...(author?.diagnostics === undefined ? {} : { diagnostics: author.diagnostics }),
        ...(author?.layer === undefined ? {} : { layer: author.layer }),
        ...(author?.phase === undefined ? {} : { phase: author.phase }),
        ...(author?.details === undefined ? {} : { details: author.details }),
        ...(author?.failureCause === undefined ? {} : { failureCause: author.failureCause }),
    };
}

/** The host's response and a nested author call retain the same producer diagnostics. */
export function createPluginSurfaceActionFailurePayload(outcome: Failure,
    options?: Readonly<{ connectionPendingEligible?: boolean }>): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(outcome.code, outcome.diagnostics ?? [outcome.reason], outcome.message,
        { ...options, ...outcome });
}

export function createPluginSurfaceActionFailureError(outcome: Failure, requestId?: string): PluginError {
    return new PluginError({
        ...createPluginSurfaceHostApiPluginErrorData(outcome.reason === 'plugin_ui_action_outcome_unknown'
            ? PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE : outcome.reason,
            outcome.diagnostics ?? [outcome.reason], outcome.message, { ...outcome, requestId }),
        ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
        ...(outcome.failureCause === undefined ? {} : { failureCause: outcome.failureCause }),
    });
}

/** A deliberate decline remains a decision, not an unavailable operation. */
export function actionDeclinedFailure(code: string): Failure | null {
    return code === PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE
        ? createPluginSurfaceActionFailure('denied', code) : null;
}

/** Unknown mutations retain indeterminate effects; declared reads allow manual retry. */
export function actionOutcomeUnknownFailure(
    code: string,
    declaration: ActionEffectDeclaration,
    input: unknown,
    author?: FailureMetadata,
): Failure | null {
    return code === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        ? createPluginSurfaceActionFailure('timeout', 'plugin_ui_action_outcome_unknown',
            { ...author, layer: 'transport', phase: 'settlement', retryable: pluginActionDeclarationIsReadOnlyForInput(
                declaration.accountActionDeclaration ?? declaration, input) }) : null;
}

export function clientActionFailure(code: string, author?: FailureMetadata): Failure {
    return actionDeclinedFailure(code) ?? createPluginSurfaceActionFailure(
        author?.layer ? code : code === 'plugin_action_generation_retired' ? 'stale_surface' : 'unavailable', code, author);
}

/** Lazy preparation can refuse before invocation; retain the same authored recovery. */
export function clientActionPreparationFailure(error: unknown): Failure {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'activation_failed';
    const metadata = readPluginSurfaceHostApiFailureMetadata(error);
    const authored = isPluginError(error) ? error : undefined;
    const author = readPluginActionFailureAuthorPayload(authored?.data);
    return clientActionFailure(code, {
        ...metadata,
        ...(authored?.data.message === undefined
            ? metadata.layer ? { message: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code }).body } : {}
            : { message: authored.data.message }),
        ...(author.details === undefined ? {} : { details: author.details }),
        ...(author.failureCause === undefined ? {} : { failureCause: author.failureCause }),
        ...(author.remediation === undefined ? {} : { remediation: author.remediation }),
        ...(error && typeof error === 'object' && 'retryable' in error && typeof error.retryable === 'boolean'
            ? { retryable: error.retryable } : {}),
        ...(author.diagnostics?.length ? { diagnostics: author.diagnostics.map(diagnostic => diagnostic.code) }
            : error && typeof error === 'object' && 'diagnostics' in error && Array.isArray(error.diagnostics)
                ? { diagnostics: error.diagnostics.filter((value: unknown): value is string => typeof value === 'string') } : {}),
    });
}

/** The invocation owner has already admitted the author's structured failure. */
export function projectClientActionInvocationFailure(
    result: Exclude<PluginActionInvocationResult, Readonly<{ status: 'executed' }>>,
    declaration: ActionEffectDeclaration,
    input: unknown,
): Failure {
    if (result.status === 'invalid') return clientActionFailure(result.code);
    if (result.status === 'unavailable') {
        const code = projectPluginActionUnavailableOutcomeCode(result.code, result.actionHandlerInvocation);
        return actionOutcomeUnknownFailure(code, declaration, input) ?? clientActionFailure(code);
    }
    const author = readPluginActionFailureAuthorPayload(result.data);
    const metadata: FailureMetadata = {
        message: result.message,
        ...readPluginSurfaceHostApiFailureMetadata(author.details),
        ...(author.details === undefined ? {} : { details: author.details }),
        ...(author.failureCause === undefined ? {} : { failureCause: author.failureCause }),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...(author.remediation === undefined ? {} : { remediation: author.remediation }),
        ...(author.diagnostics?.length ? { diagnostics: author.diagnostics.map(diagnostic => diagnostic.code) } : {}),
    };
    return actionOutcomeUnknownFailure(result.code, declaration, input, metadata) ?? clientActionFailure(result.code, metadata);
}
