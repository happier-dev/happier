import * as React from 'react';

import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import type { PluginMachineMaterializationAdmission } from '@/sync/domains/plugins/availability/reader';

import { buildPluginMachineMatrix, type PluginMachineMatrixV1 } from './pluginMachineMatrix';

const UNLOADED: PluginMachineMaterializationAdmission = Object.freeze({
    kind: 'unavailable',
    code: 'account_availability_not_loaded',
});

/**
 * Reads the Account-wide plugin/machine matrix from the owners that already
 * hold its facts: the Account Availability projection and the all-profile
 * machine inventory. It adds no fetch, refresh, or cache of its own.
 */
export function usePluginMachineMatrix(params: Readonly<{
    pluginId?: string;
}> = {}): PluginMachineMatrixV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    const machineSnapshots = useAllProfileMachineInventorySnapshots();
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const admission = React.useMemo(
        () => reader?.readMaterializations() ?? UNLOADED,
        [reader],
    );
    const pluginId = params.pluginId;
    return React.useMemo(() => buildPluginMachineMatrix({
        admission,
        machineSnapshots,
        classifyRelease,
        ...(pluginId === undefined ? {} : { pluginId }),
    }), [admission, classifyRelease, machineSnapshots, pluginId]);
}
