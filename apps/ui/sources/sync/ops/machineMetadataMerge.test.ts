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

    it('preserves windowsRemoteSessionConsole from intended metadata', () => {
        const merged = mergeMachineMetadataForVersionMismatch({
            latest: { host: 'h', platform: 'win32', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' } as any,
            intended: { windowsRemoteSessionConsole: 'visible' } as any,
        });
        expect((merged as any).windowsRemoteSessionConsole).toBe('visible');
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
                windowsRemoteSessionConsole: 'hidden',
            } as any,
            intended: { displayName: undefined, windowsRemoteSessionConsole: undefined } as any,
        });
        expect((merged as any).displayName).toBe('Latest');
        expect((merged as any).windowsRemoteSessionConsole).toBe('hidden');
    });
});
