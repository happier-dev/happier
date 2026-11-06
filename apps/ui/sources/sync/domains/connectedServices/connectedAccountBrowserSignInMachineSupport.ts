import { supportsMachineOperationProtocolCapabilityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

import type { Machine } from '@/sync/domains/state/storageTypes';

export function readConnectedAccountBrowserSignInMachineSupport(
    machine: Pick<Machine, 'isShared' | 'operationProtocolCapabilities'> | null | undefined,
): 'supported' | 'custodian_only' | 'cli_update_required' {
    if (!machine) return 'cli_update_required';
    if (machine.isShared) return 'custodian_only';
    return supportsMachineOperationProtocolCapabilityV1(machine.operationProtocolCapabilities, 'connectedAccountAuthentication')
        ? 'supported' : 'cli_update_required';
}
