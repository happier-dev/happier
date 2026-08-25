import type { FreshMachineAdministrationExecutionTargetV1 } from './useTargetSelection';

/** Exact authority identity for one administration operation. */
export function sameMachineAdministrationExecutionTarget(
    left: FreshMachineAdministrationExecutionTargetV1,
    right: FreshMachineAdministrationExecutionTargetV1,
): boolean {
    return left.target.serverIdentityId === right.target.serverIdentityId
        && left.machine.id === right.machine.id
        && left.serverId === right.serverId
        && left.machine.daemonStateVersion === right.machine.daemonStateVersion;
}

/**
 * The sole settlement/dispatch currentness rule for machine Administration.
 * A screen may additionally bind the operation to its own selected-row key;
 * target authority always includes the exact daemon generation.
 */
export function isMachineAdministrationExecutionTargetCurrent(params: Readonly<{
    expectedTarget: FreshMachineAdministrationExecutionTargetV1;
    resolveCurrentTarget: () => FreshMachineAdministrationExecutionTargetV1 | null;
    expectedSelectionKey?: string;
    currentSelectionKey?: string;
}>): boolean {
    if (
        params.expectedSelectionKey !== undefined
        && params.expectedSelectionKey !== params.currentSelectionKey
    ) return false;
    const current = params.resolveCurrentTarget();
    return current !== null
        && sameMachineAdministrationExecutionTarget(current, params.expectedTarget);
}
