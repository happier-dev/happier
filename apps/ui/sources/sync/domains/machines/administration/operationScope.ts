import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import { machineAdministrationTargetsEqual } from './targetSelection';

export type MachineAdministrationOperationScopeV1 = Readonly<{
    target: MachineAdministrationTargetV1;
    selectionRevision: string;
    daemonStateVersion?: number;
}>;

export function captureMachineAdministrationOperationScope(
    scope: MachineAdministrationOperationScopeV1,
): MachineAdministrationOperationScopeV1 {
    return Object.freeze({
        target: Object.freeze({ ...scope.target }),
        selectionRevision: scope.selectionRevision,
        ...(scope.daemonStateVersion === undefined ? {} : { daemonStateVersion: scope.daemonStateVersion }),
    });
}

/**
 * UI-settlement fence only. The incumbent daemon currentness owner remains the
 * authority for RPC admission; this prevents an A result from updating B after
 * the user changes or loses the selected target.
 */
export function isMachineAdministrationOperationScopeCurrent(
    scope: MachineAdministrationOperationScopeV1,
    current: Readonly<{
        target: MachineAdministrationTargetV1 | null;
        selectionRevision: string;
    }>,
): boolean {
    return current.target !== null
        && scope.selectionRevision === current.selectionRevision
        && machineAdministrationTargetsEqual(scope.target, current.target);
}
