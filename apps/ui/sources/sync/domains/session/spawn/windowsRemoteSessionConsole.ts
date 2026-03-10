import type { MachineMetadata } from '@/sync/domains/state/storageTypes';

import { readMachineWindowsRemoteSessionLaunchMode } from './windowsRemoteSessionLaunchMode';

export type WindowsRemoteSessionConsoleMode = 'hidden' | 'visible';

export function resolveWindowsRemoteSessionConsoleFromMachineMetadata(
    metadata: MachineMetadata | null | undefined,
): WindowsRemoteSessionConsoleMode | undefined {
    const mode = readMachineWindowsRemoteSessionLaunchMode(metadata);
    if (mode === 'hidden') return 'hidden';
    if (mode === 'console' || mode === 'windows_terminal') return 'visible';
    return undefined;
}
