import { ManagedControllerRequestFailureDetailsV1Schema, ManagedGuestHomeFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineProvisionerNativeCauseV1, ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { HomeEnrollmentCarrierFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

/** Existing Details disclosures accept only typed causes and the Action's correlation identity. */
export function describeManagedActionFailureDiagnostic(code: string, details?: unknown, requestId?: string, failureCause?: ActionFailureCauseV1): string {
    let diagnostic = code;
    const native = ManagedNativeFailureDetailsV1Schema.safeParse(details);
    const controller = ManagedControllerRequestFailureDetailsV1Schema.safeParse(details);
    const guestHome = ManagedGuestHomeFailureDetailsV1Schema.safeParse(details);
    if (native.success) diagnostic = describeManagedNativeFailureDiagnostic(code, native.data.nativeCause);
    else if (guestHome.success) diagnostic = describeManagedHomeCarrierFailureDiagnostic(code, guestHome.data.carrierFailure);
    else if (controller.success) diagnostic = [code, controller.data.category,
        controller.data.status ? `HTTP ${controller.data.status}` : undefined,
        controller.data.code === code ? undefined : controller.data.code].filter(Boolean).join(' · ');
    else {
        const parsed = ExternalActionHttpErrorSchema.safeParse(details);
        if (parsed.success && 'code' in parsed.data && parsed.data.code === 'action_outcome_unknown'
            && parsed.data.code === code && 'diagnostic' in parsed.data) {
            const cause = parsed.data.diagnostic;
            diagnostic = [code, cause.reason, 'errorCode' in cause ? cause.errorCode : undefined].filter(Boolean).join(' · ');
        }
    }
    if (failureCause) {
        const presentation = presentActionExecutionFailure({ ok: false, errorCode: code, failureCause });
        diagnostic = [diagnostic, ...presentation.technicalDetails.filter(detail => detail.key !== 'code').map(detail => detail.value)].join(' · ');
    }
    return requestId ? `${diagnostic} · ${t('session.startFailure.requestId', { id: requestId })}` : diagnostic;
}

/** Technical facts and privacy-projected command stderr for the existing Details disclosure. */
export function describeManagedNativeCause(cause: MachineProvisionerNativeCauseV1): string {
    if ('localCause' in cause && cause.localCause === 'native_command_failed') {
        return [cause.command, cause.exitCode === null ? 'interrupted' : `exit ${cause.exitCode}`, cause.stderr,
            cause.stderrTruncated ? 'stderr truncated' : null].filter(Boolean).join(' · ');
    }
    if ('localCause' in cause && cause.localCause === 'plugin_action_input_schema_invalid') {
        return [cause.localCause, `${cause.action.pluginId}/${cause.action.localId}`,
            ...cause.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.code}`)].join(' · ');
    }
    if ('localCause' in cause) return ['httpStatus' in cause ? `HTTP ${cause.httpStatus}` : null, cause.localCause].filter(Boolean).join(' · ');
    if ('httpStatusClass' in cause) return [`HTTP ${cause.httpStatusClass}`, cause.code, cause.fields?.join(', ')].filter(Boolean).join(' · ');
    if ('grpcStatusCode' in cause) return `gRPC ${cause.grpcStatusCode}`;
    return cause.sdkError;
}

export function describeManagedNativeFailureDiagnostic(code: string, cause?: MachineProvisionerNativeCauseV1): string {
    return cause ? `${code} · ${describeManagedNativeCause(cause)}` : code;
}

function describeManagedHomeCarrierFailureDiagnostic(code: string, cause?: HomeEnrollmentCarrierFailure): string {
    return cause ? [code, cause.attemptedCarrier, cause.reason,
        ...(cause.irohAttempt ? ['iroh', cause.irohAttempt.reason] : [])].join(' · ') : code;
}

export function describeManagedObservationDiagnostic(observation: Pick<ProviderObservationV1, 'reason' | 'nativeCause' | 'carrierFailure'>): string {
    return describeManagedHomeCarrierFailureDiagnostic(
        describeManagedNativeFailureDiagnostic(observation.reason ?? 'provider_unavailable', observation.nativeCause), observation.carrierFailure);
}

/** A preset's availability card presents the typed use-time refusal, never the controller label or inventory read. */
export function describeManagedPresetAvailabilityFailure(code: string): string {
    switch (code) {
        case 'permission_denied': return t('session.startFailure.cause.permission_denied');
        case 'controller_unavailable': return t('session.startFailure.cause.controller_unavailable');
        case 'credential_unavailable': return t('session.startFailure.cause.credential_unavailable');
        case 'provider_unavailable': return t('session.startFailure.cause.provider_unavailable');
        case 'controller_retired': return t('session.startFailure.cause.controller_retired');
        case 'request_conflict': return t('session.startFailure.cause.request_conflict');
        case 'intent_changed': return t('session.startFailure.cause.intent_changed');
        case 'managed_not_found': return t('session.startFailure.cause.managed_not_found');
        case 'enrollment_retired': return t('session.startFailure.cause.enrollment_retired');
        default: return t('managedMachines.options.unavailable');
    }
}

export function describeManagedOperationDiagnostic(error: NonNullable<ActionOperationSnapshotV1['error']>): string {
    const details = error.details;
    if (details && 'kind' in details && (details.kind === 'managedNative' || details.kind === 'managedGuestHome')) {
        return describeManagedActionFailureDiagnostic(error.errorCode, details, undefined, error.failureCause);
    }
    return [describeManagedActionFailureDiagnostic(error.errorCode, details, undefined, error.failureCause), error.error]
        .filter((part, index, parts) => part && parts.indexOf(part) === index).join(' · ');
}
