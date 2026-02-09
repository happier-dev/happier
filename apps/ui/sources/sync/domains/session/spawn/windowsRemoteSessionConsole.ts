import type { MachineMetadata } from '@/sync/domains/state/storageTypes';

export type WindowsRemoteSessionConsoleMode = 'hidden' | 'visible';

export function resolveWindowsRemoteSessionConsoleFromMachineMetadata(
    metadata: MachineMetadata | null | undefined,
): WindowsRemoteSessionConsoleMode | undefined {
    if (!metadata) return undefined;
    if (metadata.platform !== 'win32') return undefined;
    if (metadata.windowsRemoteSessionConsole === 'hidden') return 'hidden';
    if (metadata.windowsRemoteSessionConsole === 'visible') return 'visible';
    return undefined;
}
