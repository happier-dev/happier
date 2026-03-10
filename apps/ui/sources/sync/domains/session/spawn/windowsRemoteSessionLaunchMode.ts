import type { WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

import type { Settings } from '@/sync/domains/settings/settings';
import type { MachineMetadata } from '@/sync/domains/state/storageTypes';

export type WindowsRemoteSessionLaunchModeResolution =
    | { mode: undefined; source: 'unsupported' }
    | { mode: WindowsRemoteSessionLaunchMode; source: 'session' | 'machine' | 'settings' | 'default' };

export function normalizeWindowsRemoteSessionLaunchMode(
    value: unknown,
): WindowsRemoteSessionLaunchMode | undefined {
    if (value === 'hidden' || value === 'windows_terminal' || value === 'console') return value;
    if (value === 'visible') return 'console';
    return undefined;
}

export function readMachineWindowsRemoteSessionLaunchMode(
    metadata: MachineMetadata | null | undefined,
): WindowsRemoteSessionLaunchMode | undefined {
    if (!metadata || metadata.platform !== 'win32') return undefined;
    return normalizeWindowsRemoteSessionLaunchMode(
        metadata.windowsRemoteSessionLaunchMode ?? metadata.windowsRemoteSessionConsole,
    );
}

export function resolveEffectiveWindowsRemoteSessionLaunchMode(params: {
    machineMetadata: MachineMetadata | null | undefined;
    settings: Pick<Settings, 'sessionWindowsRemoteSessionLaunchMode'>;
    sessionOverride?: WindowsRemoteSessionLaunchMode | undefined;
}): WindowsRemoteSessionLaunchModeResolution {
    if (params.machineMetadata?.platform !== 'win32') {
        return { mode: undefined, source: 'unsupported' };
    }

    const sessionOverride = normalizeWindowsRemoteSessionLaunchMode(params.sessionOverride);
    if (sessionOverride) return { mode: sessionOverride, source: 'session' };

    const machineOverride = readMachineWindowsRemoteSessionLaunchMode(params.machineMetadata);
    if (machineOverride) return { mode: machineOverride, source: 'machine' };

    const settingsMode = normalizeWindowsRemoteSessionLaunchMode(params.settings.sessionWindowsRemoteSessionLaunchMode);
    if (settingsMode) return { mode: settingsMode, source: 'settings' };

    return { mode: 'hidden', source: 'default' };
}
