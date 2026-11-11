import { ManagedMachineFailureDetailsV1Schema, type ManagedMachineFailureDetailsV1, type ManagedNativeFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineProvisionerNativeCauseV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { projectActionFailureCauseV1,
    type ActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string, readonly status?: number,
        readonly details?: ManagedMachineFailureDetailsV1,
        readonly failureCause?: ActionFailureCauseV1) {
        super(code);
        this.name = 'ManagedMachineControllerError';
    }

    /** Child Actions return public failures, never raw exceptions or message text. */
    static fromActionFailure(failure: ActionExecuteFailure, phase: ActionId): ManagedMachineControllerError {
        const error = new ManagedMachineControllerError(failure.errorCode);
        const details = ManagedMachineFailureDetailsV1Schema.safeParse(failure.details);
        return new ManagedMachineControllerError(failure.errorCode, undefined,
            details.success ? details.data : undefined, failure.failureCause ?? projectActionFailureCauseV1(error, phase));
    }
}

/** Preserve only canonical schema paths/codes or the closed native PluginError diagnostic. */
export function readManagedNativeFailureDetails(failure: ActionExecuteFailure, action: PluginContributionIdentityV1): ManagedNativeFailureDetailsV1 | undefined {
    if (failure.errorCode === 'plugin_action_input_schema_invalid' && failure.details
        && typeof failure.details === 'object' && !Array.isArray(failure.details) && 'issues' in failure.details) {
        const cause = MachineProvisionerNativeCauseV1Schema.safeParse({ localCause: failure.errorCode, action, issues: failure.details.issues });
        if (cause.success) return { kind: 'managedNative', nativeCause: cause.data };
    }
    const { details: data, errorCode: code } = failure;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('name' in data) || data.name !== 'PluginError'
        || !('code' in data) || data.code !== code || !('details' in data)) return undefined;
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
