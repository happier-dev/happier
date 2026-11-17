import { ManagedMachineFailureDetailsV1Schema, type ManagedMachineFailureDetailsV1, type ManagedNativeFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineProvisionerNativeCauseV1Schema, type MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { projectActionFailureCauseV1,
    type ActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import { isSessionSpawnNewActionIdV1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { isPluginErrorData } from '@happier-dev/protocol/plugins/errors';
import { PluginDiagnosticRemediationV1Schema } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import { PluginError } from '../../plugins/errors.js';

export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string, readonly status?: number,
        readonly details?: ManagedMachineFailureDetailsV1,
        readonly failureCause?: ActionFailureCauseV1, cause?: unknown) {
        super(code, cause ? { cause } : undefined);
        this.name = 'ManagedMachineControllerError';
    }

    /** Reporting failure must not erase a native cause or turn uncertainty into refusal. */
    static fromUnknownNativeResult(result: Readonly<{
        kind: string; code?: string; nativeCause?: MachineProvisionerNativeCauseV1;
    }>): ManagedMachineControllerError | undefined {
        if (result.kind !== 'unknown' || !result.nativeCause) return undefined;
        return new ManagedMachineControllerError(result.code ?? 'native_intent_unconfirmed', undefined,
            { kind: 'managedNative', nativeCause: result.nativeCause });
    }

    /** Child Actions return public failures, never raw exceptions or message text. */
    static fromActionFailure(failure: ActionExecuteFailure, phase: ActionId,
        action?: PluginContributionIdentityV1): ManagedMachineControllerError {
        const error = new ManagedMachineControllerError(failure.errorCode);
        const parsedDetails = ManagedMachineFailureDetailsV1Schema.safeParse(failure.details);
        const details = parsedDetails.success ? parsedDetails.data : readManagedNativeFailureDetails(failure, action);
        const spawn = isSessionSpawnNewActionIdV1(phase) ? SessionSpawnNewResultV1Schema.safeParse(failure.details) : undefined;
        const publicDetails = spawn?.success && spawn.data.type === 'error' && spawn.data.code === failure.errorCode
            ? spawn.data : details;
        const failureCause = failure.failureCause ?? projectActionFailureCauseV1(error, phase);
        const authored = isPluginErrorData(failure.details) && failure.details.code === failure.errorCode ? failure.details : undefined;
        const message = authored?.message?.trim();
        const remediation = PluginDiagnosticRemediationV1Schema.safeParse(authored && 'remediation' in authored ? authored.remediation : undefined);
        // Keep native-only diagnostics in their existing closed shape. Authored
        // repairs travel as the existing public Action failure in Error.cause.
        const presentation = authored && (message && message !== authored.code || remediation.success)
            ? { error: message || failure.errorCode,
                details: new PluginError({ code: authored.code, message, retryable: authored.retryable,
                    ...(remediation.success ? { remediation: remediation.data } : {}),
                    ...(details ? { details } : {}) }).data }
            : failure.error.trim() && failure.error !== failure.errorCode || publicDetails !== details
                ? { error: failure.error.trim() || failure.errorCode, ...(publicDetails ? { details: publicDetails } : {}) }
                : undefined;
        const retained = presentation ?? (failure.requestId !== undefined || failure.effectAttempted !== undefined
            ? normalizeActionExecutorThrownError(new this(failure.errorCode, undefined, details, failureCause), phase)
            : undefined);
        const cause: ActionExecuteFailure | undefined = retained && { ...retained, ok: false, errorCode: failure.errorCode, failureCause,
            ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
            ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }) };
        return new this(failure.errorCode, undefined, details, failureCause, cause);
    }
}

/** Preserve only canonical schema paths/codes or the closed native PluginError diagnostic. */
export function readManagedNativeFailureDetails(failure: ActionExecuteFailure, action?: PluginContributionIdentityV1): ManagedNativeFailureDetailsV1 | undefined {
    if (failure.errorCode === 'plugin_action_input_schema_invalid' && action && failure.details
        && typeof failure.details === 'object' && !Array.isArray(failure.details) && 'issues' in failure.details) {
        const cause = MachineProvisionerNativeCauseV1Schema.safeParse({ localCause: failure.errorCode, action, issues: failure.details.issues });
        if (cause.success) return { kind: 'managedNative', nativeCause: cause.data };
    }
    const { details: data, errorCode: code } = failure;
    if (!isPluginErrorData(data) || data.code !== code || !('details' in data)) return undefined;
    const details = data.details;
    if (!details || typeof details !== 'object' || Array.isArray(details) || !('nativeCause' in details)) return undefined;
    const cause = MachineProvisionerNativeCauseV1Schema.safeParse(details.nativeCause);
    return cause.success ? { kind: 'managedNative', nativeCause: cause.data } : undefined;
}

export class ManagedMachineNativeRefusal extends ManagedMachineControllerError {}
export class ManagedMachineNativeEffectGuardRefusal extends ManagedMachineNativeRefusal {}
export class ManagedMachineNativeObservationFailure extends ManagedMachineControllerError {}
export class ManagedRetentionWaitSuperseded extends ManagedMachineControllerError {
    constructor() { super('intent_changed'); }
}
