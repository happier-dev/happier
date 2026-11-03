import type { ManagedAgentIsolationFailureDetailsV1, ManagedBootstrapFailureDetailsV1, ManagedControllerRequestFailureDetailsV1, ManagedNativeFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineProvisionerNativeCauseV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ActionExceptionFailureDetailsV1Schema, projectActionExceptionFailureDetailsV1,
    type ActionExecuteFailure, type ActionExceptionFailureDetailsV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string, readonly status?: number,
        readonly details?: ManagedControllerRequestFailureDetailsV1 | ManagedNativeFailureDetailsV1 | ManagedBootstrapFailureDetailsV1 | ManagedAgentIsolationFailureDetailsV1 | ActionExceptionFailureDetailsV1) {
        super(code);
        this.name = 'ManagedMachineControllerError';
    }

    /** Child Actions return public failures, never raw exceptions or message text. */
    static fromActionFailure(failure: ActionExecuteFailure, phase: ActionId): ManagedMachineControllerError {
        const error = new ManagedMachineControllerError(failure.errorCode);
        const cause = ActionExceptionFailureDetailsV1Schema.safeParse(failure.details);
        return new ManagedMachineControllerError(failure.errorCode, undefined,
            cause.success ? { ...cause.data, phase } : projectActionExceptionFailureDetailsV1(error, phase));
    }
}

/** Preserve only the closed native diagnostic from the dispatcher's PluginError payload. */
export function readManagedNativeFailureDetails(data: unknown, code: string): ManagedNativeFailureDetailsV1 | undefined {
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
