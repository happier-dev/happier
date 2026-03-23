import type { WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { TranslationKeyNoParams } from '@/text';

export const WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: ReadonlyArray<{
    value: WindowsRemoteSessionLaunchMode;
    labelKey: TranslationKeyNoParams;
    shortLabelKey: TranslationKeyNoParams;
    subtitleKey: TranslationKeyNoParams;
}> = [
    {
        value: 'hidden',
        labelKey: 'windowsRemoteSessionLaunchMode.hidden',
        shortLabelKey: 'windowsRemoteSessionLaunchMode.shortHidden',
        subtitleKey: 'windowsRemoteSessionLaunchMode.hiddenSubtitle',
    },
    {
        value: 'windows_terminal',
        labelKey: 'windowsRemoteSessionLaunchMode.windowsTerminal',
        shortLabelKey: 'windowsRemoteSessionLaunchMode.shortWindowsTerminal',
        subtitleKey: 'windowsRemoteSessionLaunchMode.windowsTerminalSubtitle',
    },
    {
        value: 'console',
        labelKey: 'windowsRemoteSessionLaunchMode.console',
        shortLabelKey: 'windowsRemoteSessionLaunchMode.shortConsole',
        subtitleKey: 'windowsRemoteSessionLaunchMode.consoleSubtitle',
    },
] as const;

export function listAvailableWindowsRemoteSessionLaunchModes(params: {
    windowsTerminalAvailable: boolean;
}): ReadonlyArray<WindowsRemoteSessionLaunchMode> {
    return params.windowsTerminalAvailable
        ? ['hidden', 'windows_terminal', 'console']
        : ['hidden', 'console'];
}

export function cycleWindowsRemoteSessionLaunchMode(params: {
    current: WindowsRemoteSessionLaunchMode;
    windowsTerminalAvailable: boolean;
}): WindowsRemoteSessionLaunchMode {
    const available = listAvailableWindowsRemoteSessionLaunchModes({
        windowsTerminalAvailable: params.windowsTerminalAvailable,
    });
    const currentIndex = available.indexOf(params.current);
    if (currentIndex < 0) return available[0] ?? 'hidden';
    return available[(currentIndex + 1) % available.length] ?? 'hidden';
}
