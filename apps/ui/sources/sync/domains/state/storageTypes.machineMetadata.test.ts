import { describe, expect, it } from 'vitest';

import { MachineMetadataSchema } from './storageTypes';

describe('MachineMetadataSchema', () => {
    it('accepts windowsRemoteSessionConsole on Windows machines', () => {
        const parsed = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'win32',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happy',
            homeDir: '/tmp',
            windowsRemoteSessionConsole: 'visible',
        } as any);
        expect((parsed as any).windowsRemoteSessionConsole).toBe('visible');
    });

    it('does not require windowsRemoteSessionConsole', () => {
        const parsed = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'win32',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happy',
            homeDir: '/tmp',
        } as any);
        expect((parsed as any).windowsRemoteSessionConsole).toBeUndefined();
    });
});

