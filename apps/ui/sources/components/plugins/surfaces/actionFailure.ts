import { isPluginError, PluginError, readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { projectActionFailureCauseV1, type ActionExecuteResult, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE,
    PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE,
    readPluginActionFailureAuthorPayload,
    readPluginActionFailureHandlerInvocation,
    pluginActionDeclarationIsReadOnlyForInput,
    type PluginActionInvocationResult,
} from '@happier-dev/protocol/plugins/actions/invocation';
import type { PluginDiagnosticRemediationV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import type { PluginUiHostApiErrorPayloadV1, PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiActionProjection } from '@/sync/domains/plugins/ui/projection';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import {
    createPluginSurfaceHostApiError,
    createPluginSurfaceHostApiPluginErrorData,
    readPluginSurfaceHostApiFailureMetadata,
} from './createPluginSurfaceHostApi';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';

export type PluginSurfaceActionDispatchOutcome = Pick<ActionExecuteResult, 'automationNotices'> & (
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
        requestId?: string;
        effectAttempted?: boolean;
        failureCause?: ActionFailureCauseV1;
        actionHandlerInvocation?: 'notStarted';
    }>);

type Failure = Extract<PluginSurfaceActionDispatchOutcome, Readonly<{ ok: false }>>;
type FailureMetadata = Omit<Failure, 'ok' | 'code' | 'reason'>;
type ActionEffectDeclaration = Pick<PluginUiActionProjection, 'readOnly' | 'accountActionDeclaration'>;

export function createPluginSurfaceActionFailure(code: string, reason: string, author?: FailureMetadata): Failure {
    return {
        ok: false, code, reason,
        ...(author?.requestId === undefined ? {} : { requestId: author.requestId }),
        ...(author?.effectAttempted === undefined ? {} : { effectAttempted: author.effectAttempted }),
        ...(author?.message === undefined ? {} : { message: author.message }),
        ...(author?.retryable === undefined ? {} : { retryable: author.retryable }),
        ...(author?.remediation === undefined ? {} : { remediation: author.remediation }),
        ...(author?.diagnostics === undefined ? {} : { diagnostics: author.diagnostics }),
        ...(author?.layer === undefined ? {} : { layer: author.layer }),
        ...(author?.phase === undefined ? {} : { phase: author.phase }),
        ...(author?.details === undefined ? {} : { details: author.details }),
        ...(author?.failureCause === undefined ? {} : { failureCause: author.failureCause }),
        ...(author?.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: author.actionHandlerInvocation }),
        ...(author?.automationNotices === undefined ? {} : { automationNotices: author.automationNotices }),
    };
}

/** The host's response and a nested author call retain the same producer diagnostics. */
export function createPluginSurfaceActionFailurePayload(outcome: Failure,
    options?: Readonly<{ connectionPendingEligible?: boolean }>): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(outcome.code, outcome.diagnostics ?? [outcome.reason], outcome.message,
        { ...options, ...outcome });
}

export function createPluginSurfaceActionFailureError(outcome: Failure, requestId?: string): PluginError {
    const data = {
        ...createPluginSurfaceHostApiPluginErrorData(outcome.reason === 'plugin_ui_action_outcome_unknown'
            ? PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE : outcome.reason,
            outcome.diagnostics ?? [outcome.reason], outcome.message, { ...outcome, requestId: outcome.requestId ?? requestId }),
        ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),

        ...(outcome.failureCause === undefined ? {} : { failureCause: outcome.failureCause }),
    };
    return outcome.actionHandlerInvocation === 'notStarted'
        ? createPluginActionHandlerNotStartedError(data) : new PluginError(data);
}

/** One projection for typed host, daemon and client Action refusals. */
export function projectPluginActionFailure(result: Readonly<{
    code: string; message?: string; retryable?: boolean; data?: PluginUiJsonValueV1;
    details?: PluginUiJsonValueV1; failureCause?: ActionFailureCauseV1;
    remediation?: PluginDiagnosticRemediationV1; requestId?: string; effectAttempted?: boolean;
    actionHandlerInvocation?: 'notStarted';
}>): Failure {
    const author = readPluginActionFailureAuthorPayload(result.data ?? {
        ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {}),
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }),
        ...(result.remediation === undefined ? {} : { remediation: result.remediation }),
    });
    const correlation = isJsonObject(result.data) ? result.data : {};
    const requestId = result.requestId ?? readPluginErrorRequestIdV1({ details: author.details })
        ?? (typeof correlation.requestId === 'string' ? correlation.requestId : undefined);
    const detailsEffect = isJsonObject(author.details) ? author.details.effectAttempted : undefined;
    const effectAttempted = result.effectAttempted ?? (typeof correlation.effectAttempted === 'boolean' ? correlation.effectAttempted
        : typeof detailsEffect === 'boolean' ? detailsEffect : undefined);
    const actionHandlerInvocation = result.actionHandlerInvocation ?? readPluginActionFailureHandlerInvocation({ ...result, message: result.message ?? result.code });
    const { diagnostics, ...payload } = author;
    return createPluginSurfaceActionFailure(result.code, result.code, {
        ...payload,
        ...readPluginSurfaceHostApiFailureMetadata(author.details),
        ...(diagnostics === undefined ? {} : { diagnostics: diagnostics.map(diagnostic => diagnostic.code) }),
        ...(result.message === undefined ? {} : { message: result.message }),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(effectAttempted === undefined ? {} : { effectAttempted }),
        ...(actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation }),
    });
}

/** A deliberate decline remains a decision, not an unavailable operation. */
export function actionDeclinedFailure(code: string, author?: FailureMetadata): Failure | null {
    return code === PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE
        ? createPluginSurfaceActionFailure('denied', code, author) : null;
}

/** Unknown mutations retain indeterminate effects; declared reads allow manual retry. */
export function actionOutcomeUnknownFailure(
    code: string,
    declaration: ActionEffectDeclaration | boolean,
    input: unknown,
    author?: FailureMetadata,
): Failure | null {
    return code === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        ? createPluginSurfaceActionFailure('timeout', 'plugin_ui_action_outcome_unknown',
            { ...author, layer: 'transport', phase: 'settlement', retryable: typeof declaration === 'boolean' ? declaration
                : pluginActionDeclarationIsReadOnlyForInput(declaration.accountActionDeclaration ?? declaration, input) }) : null;
}

export function clientActionFailure(code: string, author?: FailureMetadata): Failure {
    return actionDeclinedFailure(code, author) ?? createPluginSurfaceActionFailure(
        author?.layer || author?.failureCause ? code : code === 'plugin_action_generation_retired' ? 'stale_surface' : 'unavailable', code, author);
}

/** Lazy preparation can refuse before invocation; retain the same authored recovery. */
export function clientActionPreparationFailure(error: unknown): Failure {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'activation_failed';
    const metadata = readPluginSurfaceHostApiFailureMetadata(error);
    const authored = isPluginError(error) ? error : undefined;
    const author = readPluginActionFailureAuthorPayload(authored?.data);
    const actionHandlerInvocation = authored ? readPluginActionFailureHandlerInvocation({
        code: authored.code, message: authored.message, data: authored.data,
    }) : undefined;
    if (authored && (author.failureCause || (
        code !== PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE && code !== 'plugin_action_generation_retired'
    ))) return projectPluginActionFailure({ code, data: authored.data,
        message: authored.data.message ?? (metadata.layer ? resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code }).body : undefined),
        retryable: authored.retryable, actionHandlerInvocation });
    return clientActionFailure(code, {
        ...(actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation }),
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
    declaration: ActionEffectDeclaration | boolean,
    input: unknown,
): Failure {
    if (result.status === 'invalid') return projectPluginActionFailure({ code: result.code });
    const metadata = projectPluginActionFailure(result.status === 'unavailable' && result.message === result.code
        ? { ...result, message: undefined }
        : result);
    if (metadata.failureCause) return metadata;
    return actionOutcomeUnknownFailure(result.code, declaration, input, metadata)
        ?? (result.status === 'unavailable' ? clientActionFailure(result.code, metadata) : metadata);
}

/** Retain the schema owner's public field paths and the Machine that supplied that schema. */
export function projectDaemonActionPreparationFailure(
    result: Exclude<PluginActionInvocationResult, Readonly<{ status: 'executed' }>>,
    declaration: ActionEffectDeclaration,
    input: unknown,
    binding: Readonly<{ machineId: string; serverId?: string | null }>,
): Failure {
    if (result.status !== 'invalid' || !result.issues?.length) {
        return projectClientActionInvocationFailure(result, declaration, input);
    }
    const { machineId, serverId } = binding;
    const state = getStorage().getState();
    const machine = serverId && state.profileScope && areServerProfileIdentifiersEquivalent(serverId, state.profileScope.serverId)
        ? state.machineDisplayById[machineId] : undefined;
    const path = result.issues[0]!.path.join('.');
    const reason = t('pluginRuntime.invalidParameters');
    return projectPluginActionFailure({
        code: result.code,
        message: t('errors.fieldError', { field: getMachineDisplayName(machine) ?? machineId,
            reason: path ? t('errors.fieldError', { field: path, reason }) : reason }),
        details: { machineId, issues: result.issues.map(({ code, path }) => ({ code, path: [...path] })) },
        failureCause: projectActionFailureCauseV1({ code: result.code, name: 'TypeError' },
            'action.input_validation', { allowUnknownErrorCode: true }),
        effectAttempted: false,
        actionHandlerInvocation: 'notStarted',
    });
}
