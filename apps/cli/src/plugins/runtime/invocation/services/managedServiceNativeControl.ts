import { machineNativeEffectAdmission, MachineNativeEffectAdmissionError,
    type MachineNativeEffectKey, type MachineNativeEffectOperation, type MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { ManagedWorkloadControlResultV1 } from '@happier-dev/plugin-sdk/managed-services';
import { PluginError, type PluginProjectNativeFailureV1 } from '@happier-dev/plugin-sdk';

/** Native settlement is separate from the caller's current snapshot/read authority. */
export type ManagedServiceNativeControlResult = ManagedWorkloadControlResultV1;

export function throwNativeServiceControlFailure(failure: PluginProjectNativeFailureV1): never {
    throw new PluginError({ code: failure.code, message: 'Native service control was refused' });
}

export type ManagedServiceNativeControl = Readonly<{
    operation: MachineNativeEffectOperation;
    /** Resolves after the admitted native operation settles, never merely its response. */
    settlement: Promise<void>;
}>;

/** One fact on the semantic service entry supplies exact-service exclusion,
 * retirement and maintenance. The existing native admission owns coordinates
 * and native settlement; no separate operation store is retained here. */
export async function runManagedServiceNativeControl<T>(
    entry: { nativeControl?: ManagedServiceNativeControl },
    input: Readonly<{ operation: MachineNativeEffectOperation; keys: readonly MachineNativeEffectKey[];
        admittedContext?: MachineNativeEffectContext;
        settleNative?: () => Promise<void> }>,
    effect: (context: MachineNativeEffectContext) => Promise<T>,
    notify: () => void,
): Promise<T> {
    if (entry.nativeControl) throw new MachineNativeEffectAdmissionError('effect_in_progress', entry.nativeControl.operation.operationId);
    const admitted: { control?: ManagedServiceNativeControl; settled?: () => void } = {};
    try {
        const run = input.admittedContext
            ? (effect: (context: MachineNativeEffectContext) => Promise<T>) => machineNativeEffectAdmission.runAdmitted(input.admittedContext!, input, effect)
            : (effect: (context: MachineNativeEffectContext) => Promise<T>) => machineNativeEffectAdmission.run(input, effect);
        return await run(async context => {
            if (entry.nativeControl) throw new MachineNativeEffectAdmissionError('effect_in_progress', entry.nativeControl.operation.operationId);
            admitted.control = { operation: input.operation, settlement: new Promise<void>(resolve => { admitted.settled = resolve; }) };
            entry.nativeControl = admitted.control;
            notify();
            return await effect(context);
        });
    } finally {
        if (admitted.control && entry.nativeControl === admitted.control) {
            entry.nativeControl = undefined;
            notify();
        }
        admitted.settled?.();
    }
}
