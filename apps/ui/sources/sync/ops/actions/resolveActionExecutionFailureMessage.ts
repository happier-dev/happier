import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { t } from '@/text';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';

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

function readFailureMessage(value: unknown): string | null {
    const record = asRecord(value);
    if (!record) return null;
    const code = record.errorCode ?? record.code;
    if (code === 'machine_admin_access_required') return t('errors.machineAdminAccessRequired');
    if (code === 'machine_network_review_required') return t('errors.machineNetworkReviewRequired');
    if (code === 'managed_cli_unavailable') return t('errors.machineManagedCliUnavailable');
    if (code === 'native_protocol_invalid') return t('errors.machineNativeProtocolInvalid');
    if (code === 'native_check_unavailable') return t('errors.machineNativeCheckUnavailable');
    if (code === 'native_check_unsupported') return t('errors.machineNativeCheckUnsupported');
    if (code === 'native_effect_failed') return t('errors.machineNativeEffectFailed');
    if (code === 'invalid_setting_value' || code === 'account_settings_mutation_invalid') return t('settings.writeValueRefused');
    if (code === 'setting_not_bound' || code === 'action_account_scope_changed'
        || code === 'account_settings_mutation_conflict') return t('settings.writeContextChanged');
    if (code === 'action_forbidden' || code === 'credential_scope_denied' || code === 'artifact_access_forbidden' || code === 'artifact_kind_internal'
        || code === 'project_account_access_denied' || code === 'forbidden') return t('errors.permissionDenied');
    if (code === 'version_mismatch' || code === 'version-mismatch') return t('artifacts.browser.conflict.title');
    if (code === 'artifact_not_found' || code === 'not_found') return t('artifacts.notFound');
    if (typeof code === 'string' && code.startsWith('project_account_')) return t('widgetAdd.refusals.areaUnavailable');
    if (code === 'server_unreachable' || code === 'home_unreachable') return t('settingsPlugins.targetSelection.unreachableThisHome');
    if (isActionTurnedOffErrorCode(code)) return t('actionConfirmations.turnedOffUnnamedMessage');
    if (code === 'outcome_unknown' || code === 'approval_execution_outcome_unknown') return t('entityDragDrop.preview.unknownDetail');
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

/** Thrown adapters retain the same typed failure copy as Action result envelopes. */
export function resolveActionExecutionErrorMessage(error: unknown, fallbackMessage: string): string {
    return readFailureMessage(error) ?? fallbackMessage;
}

function isFailedResult(value: unknown): boolean {
    const record = asRecord(value);
    return record?.ok === false;
}

export function resolveActionExecutionFailureMessage(
    result: unknown,
    fallbackMessage: string,
): string | null {
    const topLevel = asRecord(result);
    if (!topLevel) return fallbackMessage;

    if (topLevel.ok === false) {
        return readFailureMessage(topLevel) ?? fallbackMessage;
    }

    const inner = asRecord(topLevel.result);
    if (!inner) return null;

    if (inner.ok === false) {
        return readFailureMessage(inner) ?? fallbackMessage;
    }

    const results = Array.isArray(inner.results) ? inner.results : [];
    const firstFailed = results.find(isFailedResult);
    if (firstFailed) {
        return readFailureMessage(firstFailed) ?? fallbackMessage;
    }

    return null;
}
