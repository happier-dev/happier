import { machineServiceNativeIdentityKeyV1 } from '@happier-dev/protocol/machines/machineServiceWatchesV1';
import type { MachineServiceRowV1, MachineServicesListInputV1 } from '@happier-dev/protocol/actions/specs/machine/services';

/** P30 matches existing native facts. Compose labels, display labels and container targets are not runtime names or published ports. */
export function createMachineServicePreflightMatcher(query: MachineServicesListInputV1['preflight']) {
    if (!query) return (_row: MachineServiceRowV1 | null) => true;
    const ports = new Set(query.ports.map(String));
    const names = new Set(query.nativeNames.map(machineServiceNativeIdentityKeyV1));
    return (row: MachineServiceRowV1 | null): boolean => row !== null && (
        row.nativeInstance !== undefined && names.has(machineServiceNativeIdentityKeyV1(row.nativeInstance))
        || row.port != null && ports.has(String(row.port))
        || row.configuration?.ports.some(port => port.published != null && ports.has(String(port.published))) === true
    );
}
