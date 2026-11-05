import { PluginError } from '@happier-dev/plugin-sdk';
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
        details?: ActionFailureCauseV1;
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
    };
}

/** The host's response and a nested author call retain the same producer diagnostics. */
export function createPluginSurfaceActionFailurePayload(outcome: Failure,
    options?: Readonly<{ connectionPendingEligible?: boolean }>): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(outcome.code, outcome.diagnostics ?? [outcome.reason], outcome.message,
        { ...options, ...outcome });
}

export function createPluginSurfaceActionFailureError(outcome: Failure): PluginError {
    return new PluginError({
        ...createPluginSurfaceHostApiPluginErrorData(outcome.reason === 'plugin_ui_action_outcome_unknown'
            ? PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE : outcome.reason,
            outcome.diagnostics ?? [outcome.reason], outcome.message, outcome),
        ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
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
): Failure | null {
    return code === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        ? createPluginSurfaceActionFailure('timeout', 'plugin_ui_action_outcome_unknown',
            { layer: 'transport', phase: 'settlement', retryable: pluginActionDeclarationIsReadOnlyForInput(
                declaration.accountActionDeclaration ?? declaration, input) }) : null;
}

export function clientActionFailure(code: string, author?: FailureMetadata): Failure {
    return actionDeclinedFailure(code) ?? createPluginSurfaceActionFailure(
        author?.layer ? code : code === 'plugin_action_generation_retired' ? 'stale_surface' : 'unavailable', code, author);
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
    return actionOutcomeUnknownFailure(result.code, declaration, input) ?? clientActionFailure(result.code, {
        message: result.message,
        ...readPluginSurfaceHostApiFailureMetadata(author.details),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...(author.remediation === undefined ? {} : { remediation: author.remediation }),
        ...(author.diagnostics?.length ? { diagnostics: author.diagnostics.map(diagnostic => diagnostic.code) } : {}),
    });
}
