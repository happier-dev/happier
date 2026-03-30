import { describe, expect, it } from 'vitest';

import { MachineMetadataSchema } from './storageTypes';

describe('MachineMetadataSchema', () => {
    it('accepts windowsRemoteSessionLaunchMode on Windows machines', () => {
        const parsed = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'win32',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happy',
            homeDir: '/tmp',
            windowsRemoteSessionLaunchMode: 'windows_terminal',
        } as any);
        expect((parsed as any).windowsRemoteSessionLaunchMode).toBe('windows_terminal');
    });

    it('does not require windowsRemoteSessionLaunchMode', () => {
        const parsed = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'win32',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happy',
            homeDir: '/tmp',
        } as any);
        expect((parsed as any).windowsRemoteSessionLaunchMode).toBeUndefined();
    });
});
