import { VENDOR_HANDOFF_UNSUPPORTED } from '@happier-dev/agents';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDeferredApprovalResult } from '@happier-dev/protocol/actions/executor/resultProjection';
import { Modal } from '@/modal';
import type { PluginUiActionFailureV1, PluginUiActionFailurePresentationV1 } from '@happier-dev/protocol/plugins/ui/client';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';
import { isPluginError } from '@happier-dev/protocol/plugins/errors';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { PluginDiagnosticRemediationV1Schema } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import { isActionOutcomeUnknownErrorCodeV1, isActionTurnedOffErrorCode, readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DiscussionErrorCodeV1Schema } from '@happier-dev/protocol/discussions/api';
import { MachineElevationFailureV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineReachabilityNativeFailureDetailsV1Schema } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readDeploymentInstallationReplacementRefusalV1, readDeploymentRefusalRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { FeatureDecisionSchema } from '@happier-dev/protocol/features/decision';
import { readTeamCreationPolicyRefusalV1 } from '@happier-dev/protocol/teams';
import { teamsCreateRefusalText } from '@/components/settings/teams/collection/teamsCreateGuidanceText';

import { t } from '@/text';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { connectedServiceUxDiagnosticBodyKey } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { describeManagedAcquisitionRefusal } from './managedAcquisitionFailureCopy';
import { discussionFailureLabel } from '@/components/discussions/discussionFailureLabel';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';
import { readSessionSpawnNewFailure, resolveSessionSpawnNewResultFailureMessage } from './sessionSpawnFailurePresentation';
import { resolveMachineCustodyRefusalCopy, resolveMachineTargetUnavailableReasonCopy, resolvePluginSurfaceStaleReasonMessage, resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { getUiFeatureDefinition } from '@/sync/domains/features/featureRegistry';

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
export function describeMachineNativeFailureCode(code: unknown, details?: unknown, failure?: unknown): string | null {
    const nativeDetails = MachineReachabilityNativeFailureDetailsV1Schema.safeParse(details);
    if (nativeDetails.success) return nativeDetails.data.remedy;
    const wrapped = asRecord(details);
    const elevation = MachineElevationFailureV1Schema.safeParse(failure
        ?? (wrapped?.kind === 'machineSetup' ? wrapped.failure : undefined));
    if (elevation.success && elevation.data.remedy) return elevation.data.remedy;
    switch (code) {
        case 'machine_setup_conflict': return t('machinePresets.setup.sourceConflict');
        case 'native_protocol_invalid': return t('errors.machineNativeProtocolInvalid');
        case 'native_check_unavailable': return t('errors.machineNativeCheckUnavailable');
        case 'native_check_unsupported': return t('errors.machineNativeCheckUnsupported');
        case 'native_effect_failed': return t('errors.machineNativeEffectFailed');
        default: return null;
    }
}

/**
 * A runtime family's refusal carries its typed reason inside the envelope's error, in the one format Protocol's
 * `createRuntimeActionDisabledResult` writes (`runtime_action_disabled:<family>:<reason>`); a host-side opener may
 * write the bare reason. Closed decode only: anything else is not a reason and reads as nothing.
 */
export function readRuntimeActionDisabledReason(value: unknown): Readonly<{ family: string | null; reason: string }> | null {
    const record = asRecord(value);
    if ((record?.errorCode ?? record?.code) !== 'runtime_action_disabled' || typeof record?.error !== 'string') return null;
    const namespaced = /^runtime_action_disabled:([a-z][A-Za-z0-9_.]*):([a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)*)$/u.exec(record.error);
    if (namespaced) return { family: namespaced[1], reason: namespaced[2] };
    return /^[a-z][a-z0-9_]*$/u.test(record.error) && record.error !== 'runtime_action_disabled'
        ? { family: null, reason: record.error } : null;
}

export type FailurePresentationOptions = Readonly<{ safeToRetry?: boolean; notAppliedMessage?: string; closedCodesOnly?: boolean;
    detailsAudience?: 'recipient';
    serviceCommand?: Readonly<{ service: string; machine: string }> }>;

/** The Machine itself did not answer: its daemon is offline or its socket is gone. */
export function isMachineUnreachableFailureCode(code: unknown): boolean {
    return code === 'machine_unavailable' || code === 'machine_offline' || code === 'machine_socket_unavailable';
}

/** A refused read needs its prerequisite resolved, rather than another identical attempt. */
export function describeActionExecutionPrerequisite(code: unknown): Readonly<{
    message: string;
    recovery: 'machine_security' | 'machine_console' | 'access';
}> | null {
    if (code === 'not_preauthorized') {
        return { message: t('machineDetailPage.security.reasons.restorePasswordlessSudo'), recovery: 'machine_console' };
    }
    if (code === 'mode_none') {
        return { message: t('machineDetailPage.security.reasons.needsAdminToCheck'), recovery: 'machine_security' };
    }
    if (code === 'action_forbidden' || code === 'credential_scope_denied' || code === 'machine_manage_required' || code === 'artifact_access_forbidden' || code === 'artifact_kind_internal'
        || code === 'project_account_access_denied' || code === 'session_access_denied' || code === 'deployment_access_denied'
        || code === 'forbidden' || code === 'access_denied'
        || code === 'permission_denied' || code === 'denied'
        || code === RPC_ERROR_CODES.FORBIDDEN) {
        return { message: t('errors.permissionDenied'), recovery: 'access' };
    }
    return null;
}

function readFailureMessage(value: unknown, options?: FailurePresentationOptions): string | null {
    const record = asRecord(value);
    if (!record) return null;
    if (options?.closedCodesOnly) return readFailureFallbackMessage({
        errorCode: record.errorCode ?? record.code ?? record.rpcErrorCode,
        // Only the runtime refusal's closed reason is read from it; its text never becomes the sentence here.
        error: record.error,
        details: options.detailsAudience === 'recipient' ? undefined : record.details,
        failureCause: record.failureCause,
    }, options);
    if (record.type === 'error') {
        const spawn = readSessionSpawnNewFailure(record);
        return spawn ? resolveSessionSpawnNewResultFailureMessage(spawn) : null;
    }
    const pluginError = isPluginError(value);
    // Resource snapshots retain adapter diagnostics in `message`; only an
    // authored failure envelope (or PluginError) supplies user-facing repair.
    const authoredMessage = pluginError ? value.data.message
        : !(value instanceof Error) && isFailedResult(record) ? record.message : undefined;
    const message = typeof authoredMessage === 'string' ? authoredMessage.trim() : '';
    const code = record.errorCode ?? record.code ?? record.rpcErrorCode;
    const remediation = pluginError ? readPluginActionFailureAuthorPayload(value.data).remediation
        : PluginDiagnosticRemediationV1Schema.safeParse(record.remediation).data;
    const reason = (message && message !== code ? message : null) || readFailureFallbackMessage(record, options);
    return reason && remediation?.kind === 'retry' ? `${reason} ${t('errors.tryAgain')}` : reason;
}

/** Host code copy is the fallback when the author supplied no reason. */
function readFailureFallbackMessage(record: Record<string, unknown>, options?: FailurePresentationOptions): string | null {
    const childSession = readSessionSpawnNewFailure(record);
    if (childSession) {
        return resolveSessionSpawnNewResultFailureMessage(childSession);
    }
    const code = record.errorCode ?? record.code ?? record.rpcErrorCode;
    if (code === VENDOR_HANDOFF_UNSUPPORTED) return t('session.actionMenu.handoffUnavailable.agentUnsupported');
    // A runtime family's refusal is read by its typed reason, not by the family-wide wrapper code. A bare reason
    // code (a Service flow's own refusal) keeps its caller's named copy.
    const runtimeRefusal = readRuntimeActionDisabledReason(record);
    if (runtimeRefusal?.reason === 'browser_view_unavailable') return t('localServices.actions.failure.browserViewUnavailable');
    const installationReplacement = readDeploymentInstallationReplacementRefusalV1(code, record.details);
    if (installationReplacement) return installationReplacement.remedy;
    const stalePluginViewMessage = typeof code === 'string' ? resolvePluginSurfaceStaleReasonMessage(code) : null;
    if (stalePluginViewMessage) return stalePluginViewMessage;
    const teamCreationRefusal = readTeamCreationPolicyRefusalV1(code, record.details);
    if (teamCreationRefusal) return teamsCreateRefusalText(teamCreationRefusal.reason === 'managed_only'
        ? { kind: 'administered', administratorNames: [] }
        : { kind: 'off' });
    if (code === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE) return t('errors.networkError');
    if (code === 'database_outcome_unknown') return t('plugins.database.failure.database_outcome_unknown');
    const transient = readTransientFailure(record, options);
    if (transient) return !options?.safeToRetry && transient.effectMayHaveApplied ? t('toolView.pending.unknownDescription') : transient.message;
    // An unconfirmed effect keeps its recovery even when its transport cause is known.
    // One neutral sentence for every surface; drag-and-drop keeps its own list wording at its own call sites.
    if (isActionOutcomeUnknownErrorCodeV1(code)) return t(options?.safeToRetry ? 'errors.tryAgain' : 'errors.scmOutcomeUnknown');
    // A transport wrapper can say Forbidden while its producer names unavailable
    // infrastructure. Present that validated cause before the wrapper's generic copy.
    const cause = record.failureCause === undefined ? null : readActionFailureCauseV1(record.failureCause);
    const custodyCopy = resolveMachineCustodyRefusalCopy(code, cause);
    if (custodyCopy) return custodyCopy;
    if (code === 'target_unavailable' && cause?.phase === 'execution_authorization'
        && cause.errorCode === 'unsupported_operation') {
        return t('errors.machineOperationUnsupported');
    }
    if (cause && !('kind' in cause) && cause.errorCode !== null && cause.errorCode !== code) {
        const causeMessage = readFailureFallbackMessage({ code: cause.errorCode }, options);
        if (causeMessage) return causeMessage;
    }
    if (code === 'provider_account_grant_stale' || code === 'provider_account_scope_required') {
        return t(presentProviderError(code).descriptionKey);
    }
    if (code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialScopeMissing) {
        return t(connectedServiceUxDiagnosticBodyKey(code));
    }
    if (code === 'plugin_connected_account_binding_out_of_scope') {
        return t('connectedServices.errors.accountAccessUnavailable');
    }
    if (options?.serviceCommand) {
        const { service, machine } = options.serviceCommand;
        switch (code) {
            case 'service_admission_unavailable':
            case 'service_operation_unavailable':
            case 'service_selection_invalid':
            case 'compose_service_unavailable':
            case 'unsupported_action': return t('machineServices.command.reason.unavailable', { service, machine });
            case 'secret_redaction_unavailable':
            case 'secret_redaction_redeploy_required': return t('machineServices.command.reason.redeploy', { service });
            case 'action_account_scope_changed': return t('machineServices.command.reason.account');
        }
    }
    if (isMachineUnreachableFailureCode(code)) {
        return t('errors.daemonUnavailableBody');
    }
    if (code === 'upstream_error' || code === 'service_unavailable') return t('errors.serverError');
    if (code === 'command_failed') return t('workflows.problem.commandFailed');
    const discussionCode = typeof code === 'string' && code.startsWith('discussion')
        ? DiscussionErrorCodeV1Schema.safeParse(code) : null;
    if (discussionCode?.success) return discussionFailureLabel(discussionCode.data);
    const prerequisite = describeActionExecutionPrerequisite(code);
    if (prerequisite) return prerequisite.message;
    if (code === 'contributed_action_unavailable') return t('pluginRuntime.actionUnavailable');
    if (code === 'session_input_target_unavailable') return t('session.pendingMessages.admissionRejected.targetUnavailable');
    if (code === 'client_required') return t('errors.clientRequired');
    if (code === 'secret_save_client_required') return t('errors.secretSaveClientRequired');
    if (code === 'secret_use_client_required') return t('errors.secretUseClientRequired');
    if (code === 'resource_in_use') return t('secrets.catalog.inUseTitle');
    if (code === 'role_policy_unenforceable') return t('errors.rolePolicyUnenforceable');
    if (code === 'compose_docker_tool_unavailable') return t('errors.machineComposeDockerToolUnavailable');
    if (code === 'systemd_tool_unavailable') return t('errors.machineSystemdToolUnavailable');
    if (code === 'machine_admin_access_required') return t('errors.machineAdminAccessRequired');
    if (code === 'machine_network_review_required') return t('errors.machineNetworkReviewRequired');
    if (code === 'managed_cli_unavailable') return t('errors.machineManagedCliUnavailable');
    if (code === 'agent_isolation_unavailable') return t('errors.agentIsolationUnavailable');
    // Sync and Service moves to another person's Machine wait for an owner-decided consent step; none exists yet.
    if (code === 'requester_credential_disclosure_required') return t('errors.requesterCredentialDisclosureRequired');
    // A person's Stop holds a Send; it waits in Pending until a person resumes the Session (docs/pending-delivery.md).
    if (code === 'held_by_person') return t('errors.sessionHeldByPerson');
    if (code === 'sandbox_unavailable') return resolveReasonCopy({ kind: 'browserFrame', reasonCode: code }).body;
    if (code === 'profile_exists') return t('browserShell.profile.management.profileExists');
    if (code === 'profile_not_found') return t('browserShell.profile.management.profileNotFound');
    if (code === 'profile_unavailable') return t('browserShell.profile.management.profileUnavailable');
    if (code === 'profile_purge_failed') return t('browserShell.profile.management.profilePurgeFailed');
    if (code === 'managed_browser_required') return t('browserShell.profile.management.managedBrowserRequired');
    if (code === 'file_save_failed' || code === 'file_save_unavailable' || code === 'browser_download_unavailable') {
        return t('files.fileWriteFailed');
    }
    if (code === 'navigation_placement_not_applied'
        || code === 'space_reorder_not_applied'
        || code === 'saved_view_reorder_not_applied') return t('entityDragDrop.reasons.generic');
    if (code === 'project_workspace_unavailable') return t('terminalEmbedded.errors.projectWorkspaceUnavailable');
    if (code === 'terminal_busy') return t('terminalEmbedded.errors.busy');
    const nativeFailure = describeMachineNativeFailureCode(code, record.details, record.failure);
    if (nativeFailure) return nativeFailure;
    if (code === 'invalid_setting_value' || code === 'account_settings_mutation_invalid') return t('settings.writeValueRefused');
    // A Settings write sets a value, so repeating it after no answer is safe.
    if (code === 'account_settings_mutation_outcome_unknown') return t('errors.tryAgain');
    if (code === 'setting_not_bound' || code === 'action_account_scope_changed'
        || code === 'account_settings_mutation_conflict') return t('settings.writeContextChanged');
    if (code === 'mcp_catalog_conflict' || code === 'acp_catalog_conflict' || code === 'revision_conflict'
        || code === 'resource_changed' || code === 'settings_conflict' || code === 'references_conflict') {
        return t('approvals.conflictFailure');
    }
    if (code === 'version_mismatch' || code === 'version-mismatch') return t('artifacts.browser.conflict.title');
    if (code === 'artifact_not_found' || code === 'not_found') return t('artifacts.notFound');
    if (code === 'public_share_not_found') return t('shareSheet.publicLink.gone');
    if (typeof code === 'string' && code.startsWith('project_account_')) return t('widgetAdd.refusals.areaUnavailable');
    if (code === 'server_unreachable' || code === 'home_unreachable') return t('settingsPlugins.targetSelection.unreachableThisHome');
    if (code === 'unreachable' || (code == null && record.kind === 'unreachable')) return t('errors.networkError');
    if (code === 'invalid_encrypted_envelope' || code === 'plugin_action_input_schema_invalid') return t('common.requestFailed');
    if (code === 'plugin_action_unavailable') return t('ui.pluginUi.actionUnavailable');
    if (code === 'preset_limit_reached') return t('machinePresets.limitWaits');
    if (code === 'pool_no_available_machine') return t('machinePresets.poolNoMachine');
    if (code === 'approval_required') return options?.notAppliedMessage ?? t('notifications.activity.permissionFallbackBody');
    if (code === 'approval_canceled' || code === 'plugin_action_current_intent_rejected') {
        return options?.notAppliedMessage ?? t('voiceSurface.actionCanceled');
    }
    if (isActionTurnedOffErrorCode(code)) {
        // Decode the owner's decision at the public failure boundary; presentation never resolves policy again.
        const decision = FeatureDecisionSchema.safeParse(asRecord(record.details)?.featureDecision).data;
        const titleKey = decision && resolveFeatureAvailabilityArm(decision) === 'policy_disabled' && decision.blockedBy === 'local_policy'
            ? getUiFeatureDefinition(decision.featureId).settingsToggle?.titleKey : undefined;
        return titleKey
            ? t('settingsVoice.pages.conversations.agentFeatureRequired', { feature: t(titleKey) })
            : t('actionConfirmations.turnedOffUnnamedMessage');
    }
    const widgetRefusal = readWidgetRefusalMessage(code, record.details);
    if (widgetRefusal) return widgetRefusal;
    const sessionInputLabel = getSessionInputFailureLabelKey({ code });
    if (sessionInputLabel) return t(sessionInputLabel);
    if (code === 'feature_policy_disabled') return t('settingsVoice.pages.conversations.agentFeatureRequired', { feature: t('settingsFeatures.expVoiceAgent') });
    if (code === 'account_mode_mismatch' || code === 'recipient_mode_unsupported') return t('secrets.catalog.status.recipient_mode_unsupported');
    const managedRefusal = typeof code === 'string' ? describeManagedAcquisitionRefusal(code) : null;
    if (managedRefusal) return managedRefusal;
    if (code === 'database_editing_off') return t('plugins.database.access.editingOff');
    if (code === 'database_not_an_editor') return t('plugins.database.access.notEditor');
    switch (code) {
        case 'read_role_invalid':
        case 'target_mismatch':
        case 'database_connection_unavailable':
        case 'database_read_role_binding_failed':
        case 'database_read_role_database_unavailable':
        case 'database_read_role_mandatory_roles':
        case 'database_read_role_not_read_only':
        case 'database_read_role_plan_changed':
        case 'database_read_role_setup_failed':
        case 'database_read_role_setup_incomplete':
        case 'database_read_role_tls_hostname_required':
        case 'database_cancelled':
            return t(`plugins.database.failure.${code}`);
    }
    const deploymentRefusal = code === 'template_domain_required' ? readDeploymentRefusalRecoveryV1(code, record.details) : null;
    if (deploymentRefusal) return deploymentRefusal.remedy;
    // The Home refused the target Machine as offline (its admission's typed availability diagnostic, carried as the
    // HTTP refusal body or as the diagnostic itself): say so instead of a bare "Request failed."
    if (code === 'target_unavailable') {
        const details = asRecord(record.details);
        const availabilityCopy = resolveMachineTargetUnavailableReasonCopy(details);
        if (availabilityCopy) return availabilityCopy;
        // A Workflow start whose project folder the target Machine could not use (`workflow_workspace` refusal).
        if (details?.reason === 'workspace_unavailable') return t('errors.workspaceUnavailableOnMachine');
    }
    if (options?.closedCodesOnly) return null;
    // An error text that only repeats its code ("target_unavailable") is not a sentence: the caller's fallback speaks.
    // A runtime refusal's error is its reason code, not a sentence.
    const error = typeof record.error === 'string' && !runtimeRefusal ? record.error.trim() : '';
    if (error.length > 0 && error !== code) return error;
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage.trim() : '';
    if (errorMessage.length > 0 && errorMessage !== code) return errorMessage;
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
    return record?.ok === false || record?.type === 'error';
}

/** Both thrown adapters and returned Action envelopes use the cause owner's title. */
export function resolveActionExecutionFailureTitle(value: unknown, fallbackTitle: string): string {
    const failure = readActionExecutionFailureRecord(value) ?? asRecord(value);
    return readTransientFailure(failure)?.title ?? fallbackTitle;
}

export function readActionExecutionFailureRecord(value: unknown): Record<string, unknown> | null {
    const topLevel = asRecord(value);
    if (!topLevel || isFailedResult(topLevel)) return topLevel;
    const inner = asRecord(topLevel.result);
    if (isFailedResult(inner)) return inner;
    const results = Array.isArray(inner?.results) ? inner.results : [];
    return asRecord(results.find(isFailedResult));
}

export function resolveActionExecutionFailureMessage(
    result: unknown,
    fallbackMessage: string,
    options?: FailurePresentationOptions,
): string | null {
    if (!asRecord(result)) return fallbackMessage;
    const failure = readActionExecutionFailureRecord(result);
    return failure ? readFailureMessage(failure, options) ?? fallbackMessage : null;
}


/** The existing combined reason/recovery copy, with the disclosure's safe reference fields. */
export function presentActionExecutionFailure(failure: PluginUiActionFailureV1, fallbackMessage = t('common.requestFailed'), options?: FailurePresentationOptions): PluginUiActionFailurePresentationV1 {
    // New document and link recipient disclosures use the Action envelope's reference fields.
    const details = options?.detailsAudience === 'recipient' ? {} : readSafeFailureDetails(failure.details);
    const technicalDetails = [
        { key: 'code', label: t('workflows.run.technical.failureCode'), value: failure.errorCode },
        ...(failure.requestId ? [{ key: 'requestId', label: t('browserDiagnostics.host.devtools.fields.requestId'), value: failure.requestId }] : []),
        ...(failure.effectAttempted === undefined ? [] : [{ key: 'effectAttempted', label: t('approvals.failureTechnicalLabels.effectAttempted'), value: String(failure.effectAttempted) }]),
        ...Object.entries(details).map(([key, value]) => ({ key, label: key, value: String(value) })),
        ...(failure.failureCause ? [
            { key: 'causePhase', label: t('approvals.failureTechnicalLabels.causePhase'), value: failure.failureCause.phase },
            { key: 'errorClass', label: t('approvals.failureTechnicalLabels.errorClass'), value: failure.failureCause.errorClass },
            ...(failure.failureCause.errorCode ? [{ key: 'causeCode', label: t('approvals.failureTechnicalLabels.causeCode'), value: failure.failureCause.errorCode }] : []),
            ...('nativeErrorCode' in failure.failureCause && failure.failureCause.nativeErrorCode
                ? [{ key: 'nativeErrorCode', label: t('approvals.failureTechnicalLabels.causeCode'), value: failure.failureCause.nativeErrorCode }] : []),
            ...('nativeErrorReason' in failure.failureCause && failure.failureCause.nativeErrorReason
                ? [{ key: 'nativeErrorReason', label: t('approvals.failureTechnicalLabels.reason'), value: failure.failureCause.nativeErrorReason }] : []),
            ...(failure.failureCause.httpStatus != null ? [{ key: 'httpStatus', label: t('approvals.failureTechnicalLabels.httpStatus'), value: String(failure.failureCause.httpStatus) }] : []),
        ] : []),
    ];
    return { reason: resolveActionExecutionFailureMessage(failure, fallbackMessage, options) ?? fallbackMessage,
        // The presenter currently owns one combined message; never infer a second instruction from code.
        nextStep: null, technicalDetails };
}

/** UI callbacks preserve typed refusals and distinguish pending approval from completion. */
export function presentActionExecutionResult(result: ActionExecuteResult): void {
    if (!result.ok) {
        alertActionExecutionFailure(result);
    } else if (isDeferredApprovalResult(result)) {
        Modal.alert(t('toolView.approvalRequested.title'), t('toolView.approvalRequested.description'));
    }
}

export function alertActionExecutionFailure(failure: PluginUiActionFailureV1): void {
    alertActionFailure({
        reason: presentActionExecutionFailure(failure).reason,
        code: failure.errorCode,
        requestId: failure.requestId,
        context: {
            ...readSafeFailureDetails(failure.details),
            ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
        },
        failureCause: failure.failureCause,
    });
}
