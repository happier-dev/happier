import type { ActionExecutorContext, MachineServiceControlResultV1 } from '@happier-dev/protocol';
import type { MachineServiceTargetHandle } from './machineServiceTarget';
import { isProjectNativeProcessUncertain } from '@/plugins/runtime/exec/errors';

/** Both admitted service Actions spend the same handle and settlement owner. */
export async function controlNativeServiceForHost(input: Readonly<{
    handle: MachineServiceTargetHandle;
    operation: 'start' | 'stop' | 'restart';
    operationId: string;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>): Promise<MachineServiceControlResultV1> {
    const { handle, context } = input;
    if (!handle.controlNative) return { kind: 'unsupported', reason: 'unsupported' };
    const operation = { operationId: input.operationId };
    const signal = AbortSignal.any([handle.retirementSignal, ...(input.signal ? [input.signal] : [])]);
    const uncertain = (): MachineServiceControlResultV1 => {
        context.operationOwnerUpdate?.update({ cancellation: 'unsupported', outcome: {
            ok: false, errorCode: 'action_outcome_unknown', error: 'Native service control settlement is unknown',
        } });
        return { kind: 'outcome_unknown', operation };
    };
    try {
        const result = await handle.controlNative(input.operation, { operation: { ...operation, kind: 'serviceControl', signal }, signal });
        if (result.kind === 'outcome_unknown') return uncertain();
        if (result.kind === 'unsupported') return result;
        if (result.kind === 'accepted') return { kind: 'accepted', operation };
        return { kind: 'observed', serviceId: handle.serviceId, generation: handle.instanceId, state: result.state, operation };
    } catch (error) {
        if (isProjectNativeProcessUncertain(error)) return uncertain();
        throw error;
    }
}
