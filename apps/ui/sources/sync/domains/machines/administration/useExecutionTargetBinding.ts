import * as React from 'react';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { isMachineAdministrationExecutionTargetCurrent } from './operationCurrentness';
import { machineAdministrationTargetsEqual } from './targetSelection';
import type {
    FreshMachineAdministrationExecutionTargetV1,
    MachineAdministrationTargetSelectionV1,
    MachineAdministrationExecutionTargetOptions,
} from './useTargetSelection';

/**
 * Binds screen work to the Administration selection without owning another
 * selection. Callbacks stay stable while reading the latest controller; the
 * controller still resolves freshness and owns selection/daemon revisions.
 */
export function useMachineAdministrationExecutionTargetBinding({
    selectedTarget,
    resolveExecutionTarget,
}: Pick<MachineAdministrationTargetSelectionV1, 'selectedTarget' | 'resolveExecutionTarget'>) {
    const selectionKey = selectedTarget
        ? `${selectedTarget.serverIdentityId}\0${selectedTarget.machineId}`
        : '';
    const currentRef = React.useRef({ selectionKey, resolveExecutionTarget });
    currentRef.current = { selectionKey, resolveExecutionTarget };

    const isSelectionCurrent = React.useCallback((expectedSelection: string): boolean => (
        currentRef.current.selectionKey === expectedSelection
    ), []);

    const resolveExactExecutionTarget = React.useCallback((
        expectedTarget: MachineAdministrationTargetV1 | null,
        options?: MachineAdministrationExecutionTargetOptions,
    ): FreshMachineAdministrationExecutionTargetV1 | null => {
        const resolved = currentRef.current.resolveExecutionTarget(options);
        return expectedTarget !== null
            && resolved !== null
            && machineAdministrationTargetsEqual(expectedTarget, resolved.target)
            ? resolved
            : null;
    }, []);

    const isExecutionTargetCurrent = React.useCallback((
        expectedSelection: string,
        expectedTarget: FreshMachineAdministrationExecutionTargetV1,
        options?: MachineAdministrationExecutionTargetOptions,
    ): boolean => isMachineAdministrationExecutionTargetCurrent({
        expectedTarget,
        resolveCurrentTarget: () => currentRef.current.resolveExecutionTarget(options),
        expectedSelectionKey: expectedSelection,
        currentSelectionKey: currentRef.current.selectionKey,
    }), []);

    return React.useMemo(() => ({
        selectionKey,
        isSelectionCurrent,
        resolveExactExecutionTarget,
        isExecutionTargetCurrent,
    }), [selectionKey, isSelectionCurrent, resolveExactExecutionTarget, isExecutionTargetCurrent]);
}
