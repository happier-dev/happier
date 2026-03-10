import type { MachineMetadata } from '../domains/state/storageTypes';

export function mergeMachineMetadataForVersionMismatch(params: Readonly<{
    latest: MachineMetadata;
    intended: MachineMetadata;
}>): MachineMetadata {
    return {
        ...params.latest,
        displayName: params.intended.displayName ?? params.latest.displayName,
        windowsRemoteSessionLaunchMode:
            params.intended.windowsRemoteSessionLaunchMode ?? params.latest.windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole: params.intended.windowsRemoteSessionConsole ?? params.latest.windowsRemoteSessionConsole,
    };
}
