import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DiscussionErrorCodeV1Schema } from '@happier-dev/protocol/discussions/api';
import { MachineElevationFailureV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { t } from '@/text';
import { discussionFailureLabel } from '@/components/discussions/discussionFailureLabel';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * Why the Home refused a widget's inputs, from the refusal's own field reasons: the first field that names a
 * cause the person can act on decides, so a locked Session, a choice that is gone and choices that could not
 * load each say so. A refusal with no such reason keeps the general sentence.
 */
function readWidgetInputsInvalidMessage(details: unknown): string {
    const fields = asRecord(details)?.fields;
    for (const field of Array.isArray(fields) ? fields : []) {
        const record = asRecord(field);
        if (!record) continue;
        if (record.status === 'denied') return t('widgetAdd.refusals.inputsAccessDenied');
        if (record.status === 'unavailable') return t('widgetAdd.refusals.inputsChoicesUnavailable');
        if (record.reasonCode === 'input_type_option_invalid' || record.reasonCode === 'widget_input_option_unavailable') return t('widgetAdd.refusals.inputsChoiceGone');
    }
    return t('widgetAdd.refusals.inputsInvalid');
}

/** Widget write refusals whose reason and next step the person can act on; any other code keeps the caller's fallback. */
function readWidgetRefusalMessage(code: unknown, details?: unknown): string | null {
    switch (code) {
        case 'widget_area_layout_default_protected': return t('projects.dashboard.defaultProtected');
        case 'widget_area_layout_owner_required': return t('errors.permissionDenied');
        case 'widget_area_owner_mismatch': return t('widgetAdd.areaScopeRecovery');
        case 'widget_area_layout_owner_ambiguous':
        case 'widget_area_layout_owner_unavailable': return t('widgetAdd.areaScopeRecovery');
        case 'widget_area_not_found': return t('artifacts.notFound');
        case 'widget_layouts_unavailable': return t('widgetAdd.refusals.areaUnavailable');
        case 'artifact_access_unavailable': return t('widgetAdd.refusals.areaUnavailable');
        case 'invalid_widget_area_record': return t('errors.invalidFormat');
        case 'widget_area_unavailable': return t('widgetAdd.refusals.areaUnavailable');
        case 'widget_area_scope_retired':
        case 'widget_scope_unavailable': return t('widgetAdd.areaScopeRecovery');
        case 'widget_inputs_invalid': return readWidgetInputsInvalidMessage(details);
        case 'widget_type_unavailable': return t('widgetAdd.refusals.typeUnavailable');
        case 'widget_size_unsupported': return t('widgetAdd.refusals.sizeUnsupported');
        case 'widget_edit_denied': return t('widgetAdd.refusals.editDenied');
        default:
            // A write whose acknowledgement never came back (`widget_add_unknown`, `widget_write_ack_unknown`, …) may or may
            // not have landed: say the Home did not confirm it, never that it simply failed.
            return typeof code === 'string' && /^widget_[a-z_]+_unknown$/.test(code) ? t('widgetAdd.refusals.writeUnconfirmed') : null;
    }
}

/**
 * A Machine's native setup refusal, in words. Action results and recorded Workflow failures (a Setup step's
 * reported code) read the same sentence; the raw code stays with the caller's technical detail.
 */
export function describeMachineNativeFailureCode(code: unknown): string | null {
    switch (code) {
        case 'native_protocol_invalid': return t('errors.machineNativeProtocolInvalid');
        case 'native_check_unavailable': return t('errors.machineNativeCheckUnavailable');
        case 'native_check_unsupported': return t('errors.machineNativeCheckUnsupported');
        case 'native_effect_failed': return t('errors.machineNativeEffectFailed');
        default: return null;
    }
}

type FailurePresentationOptions = Readonly<{ safeToRetry?: boolean; notAppliedMessage?: string }>;

function readFailureMessage(value: unknown, options?: FailurePresentationOptions): string | null {
    const record = asRecord(value);
    if (!record) return null;
    const code = record.errorCode ?? record.code;
    const transient = readTransientFailure(record, options);
    if (transient) return !options?.safeToRetry && transient.effectMayHaveApplied ? t('toolView.pending.unknownDescription') : transient.message;
    const discussionCode = typeof code === 'string' && code.startsWith('discussion')
        ? DiscussionErrorCodeV1Schema.safeParse(code) : null;
    if (discussionCode?.success) return discussionFailureLabel(discussionCode.data);
    if (code === 'machine_admin_access_required') return t('errors.machineAdminAccessRequired');
    if (code === 'machine_network_review_required') return t('errors.machineNetworkReviewRequired');
    if (code === 'managed_cli_unavailable') return t('errors.machineManagedCliUnavailable');
    const nativeFailure = describeMachineNativeFailureCode(code);
    if (nativeFailure) {
        const details = asRecord(record.details);
        const failure = MachineElevationFailureV1Schema.safeParse(record.failure
            ?? (details?.kind === 'machineSetup' ? details.failure : undefined));
        return failure.success ? failure.data.remedy ?? nativeFailure : nativeFailure;
    }
    if (code === 'invalid_setting_value' || code === 'account_settings_mutation_invalid') return t('settings.writeValueRefused');
    if (code === 'setting_not_bound' || code === 'action_account_scope_changed'
        || code === 'account_settings_mutation_conflict') return t('settings.writeContextChanged');
    if (code === 'action_forbidden' || code === 'credential_scope_denied' || code === 'artifact_access_forbidden' || code === 'artifact_kind_internal'
        || code === 'project_account_access_denied' || code === 'forbidden'
        || code === RPC_ERROR_CODES.FORBIDDEN) return t('errors.permissionDenied');
    if (code === 'version_mismatch' || code === 'version-mismatch') return t('artifacts.browser.conflict.title');
    if (code === 'artifact_not_found' || code === 'not_found') return t('artifacts.notFound');
    if (typeof code === 'string' && code.startsWith('project_account_')) return t('widgetAdd.refusals.areaUnavailable');
    if (code === 'server_unreachable' || code === 'home_unreachable') return t('settingsPlugins.targetSelection.unreachableThisHome');
    if (code === 'plugin_action_input_schema_invalid') return t('common.requestFailed');
    if (code === 'plugin_action_unavailable') return t('ui.pluginUi.actionUnavailable');
    if (code === 'approval_required') return options?.notAppliedMessage ?? t('notifications.activity.permissionFallbackBody');
    if (code === 'approval_canceled' || code === 'plugin_action_current_intent_rejected') {
        return options?.notAppliedMessage ?? t('errors.actionCanceled');
    }
    if (isActionTurnedOffErrorCode(code)) return t('actionConfirmations.turnedOffUnnamedMessage');
    // Sent, with no answer back: it may or may not have landed.
    if (code === 'outcome_unknown' || code === 'outcome_uncertain' || code === 'approval_execution_outcome_unknown') return t(options?.safeToRetry ? 'errors.tryAgain' : 'entityDragDrop.preview.unknownDetail');
    const widgetRefusal = readWidgetRefusalMessage(code, record.details);
    if (widgetRefusal) return widgetRefusal;
    const sessionInputLabel = getSessionInputFailureLabelKey({ code });
    if (sessionInputLabel) return t(sessionInputLabel);
    const error = typeof record.error === 'string' ? record.error.trim() : '';
    if (error.length > 0) return error;
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage.trim() : '';
    if (errorMessage.length > 0) return errorMessage;
    return null;
}

function readTransientFailure(record: Record<string, unknown> | null, options?: FailurePresentationOptions) {
    return readTransientAvailabilityFailure(record?.errorCode ?? record?.code, options)
        ?? readTransientAvailabilityFailure(asRecord(record?.failureCause)?.errorCode, options);
}

/** Thrown adapters retain the same typed failure copy as Action result envelopes. */
export function resolveActionExecutionErrorMessage(error: unknown, fallbackMessage: string, options?: FailurePresentationOptions): string {
    return readFailureMessage(error, options) ?? fallbackMessage;
}

function isFailedResult(value: unknown): boolean {
    const record = asRecord(value);
    return record?.ok === false;
}

/** Both thrown adapters and returned Action envelopes use the cause owner's title. */
export function resolveActionExecutionFailureTitle(value: unknown, fallbackTitle: string): string {
    const failure = readFailureRecord(value) ?? asRecord(value);
    return readTransientFailure(failure)?.title ?? fallbackTitle;
}

function readFailureRecord(value: unknown): Record<string, unknown> | null {
    const topLevel = asRecord(value);
    if (!topLevel || topLevel.ok === false) return topLevel;
    const inner = asRecord(topLevel.result);
    if (inner?.ok === false) return inner;
    const results = Array.isArray(inner?.results) ? inner.results : [];
    return asRecord(results.find(isFailedResult));
}

export function resolveActionExecutionFailureMessage(
    result: unknown,
    fallbackMessage: string,
    options?: FailurePresentationOptions,
): string | null {
    if (!asRecord(result)) return fallbackMessage;
    const failure = readFailureRecord(result);
    return failure ? readFailureMessage(failure, options) ?? fallbackMessage : null;
}
