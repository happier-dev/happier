import type { ExternalSessionOperationOriginAvailability } from './externalSessionOperationProgressPresentation';

export type ExternalSessionOperationRowCapabilities = Readonly<{
    originAvailability: ExternalSessionOperationOriginAvailability;
    canInvokeOwnerActions: boolean;
}>;

export function resolveExternalSessionOperationRowCapabilities(input: Readonly<{
    canSendMessages: boolean;
    hasOperationMachineTarget: boolean;
    machineStatusKnown: boolean;
    machineOnline: boolean;
}>): ExternalSessionOperationRowCapabilities {
    const originAvailability =
        input.machineStatusKnown && input.machineOnline ? 'online' : 'offline';
    return {
        originAvailability,
        canInvokeOwnerActions:
            input.canSendMessages
            && input.hasOperationMachineTarget
            && originAvailability === 'online',
    };
}
