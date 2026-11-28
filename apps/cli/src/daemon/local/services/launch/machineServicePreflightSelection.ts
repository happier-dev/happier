import { machineServiceNativeIdentityKeyV1 } from '@happier-dev/protocol/machines/machineServiceWatchesV1';
import type { MachineServiceRowV1, MachineServicesListInputV1 } from '@happier-dev/protocol/actions/specs/machine/services';

/** P30 matches visible labels and native facts separately. Display names do not identify native instances. */
export function createMachineServicePreflightMatcher(query: MachineServicesListInputV1['preflight']) {
    if (!query) return (_row: MachineServiceRowV1 | null) => true;
    const ports = new Set(query.ports.map(String));
    const names = new Set(query.nativeNames.map(machineServiceNativeIdentityKeyV1));
    const displayNames = new Set(query.displayNames);
    return (row: MachineServiceRowV1 | null): boolean => row !== null && (
        displayNames.has(row.name)
        || row.nativeInstance !== undefined && names.has(machineServiceNativeIdentityKeyV1(row.nativeInstance))
        || row.port != null && ports.has(String(row.port))
        || row.configuration?.ports.some(port => port.published != null && ports.has(String(port.published))) === true
    );
}
