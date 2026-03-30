import { describe, expect, it } from 'vitest';

import { mergeMachineMetadataForVersionMismatch } from './machineMetadataMerge';

describe('mergeMachineMetadataForVersionMismatch', () => {
    it('preserves displayName from intended metadata', () => {
        const merged = mergeMachineMetadataForVersionMismatch({
            latest: { host: 'h', platform: 'win32', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' } as any,
            intended: { displayName: 'My PC' } as any,
        });
        expect((merged as any).displayName).toBe('My PC');
    });

    it('preserves windowsRemoteSessionLaunchMode from intended metadata', () => {
        const merged = mergeMachineMetadataForVersionMismatch({
            latest: { host: 'h', platform: 'win32', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' } as any,
            intended: { windowsRemoteSessionLaunchMode: 'windows_terminal' } as any,
        });
        expect((merged as any).windowsRemoteSessionLaunchMode).toBe('windows_terminal');
    });

    it('preserves latest values when intended fields are undefined', () => {
        const merged = mergeMachineMetadataForVersionMismatch({
            latest: {
                host: 'h',
                platform: 'win32',
                happyCliVersion: '1',
                happyHomeDir: '/h',
                homeDir: '/u',
                displayName: 'Latest',
                windowsRemoteSessionLaunchMode: 'console',
                windowsRemoteSessionConsole: 'hidden',
            } as any,
            intended: { displayName: undefined, windowsRemoteSessionLaunchMode: undefined, windowsRemoteSessionConsole: undefined } as any,
        });
        expect((merged as any).displayName).toBe('Latest');
        expect((merged as any).windowsRemoteSessionLaunchMode).toBe('console');
        expect((merged as any).windowsRemoteSessionConsole).toBe('hidden');
    });
});
