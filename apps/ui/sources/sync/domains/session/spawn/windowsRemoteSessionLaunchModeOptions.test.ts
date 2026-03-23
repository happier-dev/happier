import { describe, expect, it } from 'vitest';

import {
    cycleWindowsRemoteSessionLaunchMode,
    listAvailableWindowsRemoteSessionLaunchModes,
} from './windowsRemoteSessionLaunchModeOptions';

describe('windowsRemoteSessionLaunchModeOptions', () => {
    it('skips windows_terminal when Windows Terminal is unavailable', () => {
        expect(listAvailableWindowsRemoteSessionLaunchModes({
            windowsTerminalAvailable: false,
        })).toEqual(['hidden', 'console']);
    });

    it('cycles through all modes when Windows Terminal is available', () => {
        expect(cycleWindowsRemoteSessionLaunchMode({
            current: 'hidden',
            windowsTerminalAvailable: true,
        })).toBe('windows_terminal');
        expect(cycleWindowsRemoteSessionLaunchMode({
            current: 'windows_terminal',
            windowsTerminalAvailable: true,
        })).toBe('console');
    });
});
