import { describe, expect, it } from 'vitest';

import { mergeMachineMetadataForVersionMismatch } from './machineMetadataMerge';
import { MachineMetadataSchema } from '../domains/state/storageTypes';

describe('mergeMachineMetadataForVersionMismatch', () => {
    it('opens a stored finite policy without dropping it or defaulting malformed policy', () => {
        const metadata = { host: 'h', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' };
        expect(MachineMetadataSchema.parse({ ...metadata, finitePolicyV1: { accepting: false, runAtMost: 7, future: true } }))
            .toMatchObject({ finitePolicyV1: { accepting: false, runAtMost: 7 } });
        expect(MachineMetadataSchema.safeParse({ ...metadata, finitePolicyV1: { accepting: true, runAtMost: -1 } }).success).toBe(false);
    });

    it('preserves latest policy when rebasing an unrelated presentation edit', () => {
        const metadata = { host: 'h', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' };
        const merged = mergeMachineMetadataForVersionMismatch({
            latest: { ...metadata, finitePolicyV1: { accepting: false, runAtMost: 2 } },
            intended: { ...metadata, displayName: 'Edited name', finitePolicyV1: { accepting: true, runAtMost: null } },
        });
        expect(merged).toMatchObject({ displayName: 'Edited name', finitePolicyV1: { accepting: false, runAtMost: 2 } });
    });
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
