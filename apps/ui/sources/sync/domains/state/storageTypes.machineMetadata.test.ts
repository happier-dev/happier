import { describe, expect, it } from 'vitest';

import { MachineMetadataSchema } from './storageTypes';

describe('MachineMetadataSchema', () => {
    it('retains the daemon fork build identifier', () => {
        const parsed = MachineMetadataSchema.parse({ host: 'host', platform: 'linux', happyCliVersion: '0.2.19', happyForkVersion: '0.2.19-fork.15', happyHomeDir: '/tmp/happier', homeDir: '/tmp' });
        expect(parsed.happyForkVersion).toBe('0.2.19-fork.15');
    });
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

    it('preserves the daemon typed session-attach capability when advertised', () => {
        const parsed = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '0.2.10',
            happyHomeDir: '/tmp/happier',
            homeDir: '/tmp',
            daemonTerminalSessionAttachSupported: true,
        });

        expect(parsed.daemonTerminalSessionAttachSupported).toBe(true);
    });

    it('preserves the daemon session-goal capability when advertised', () => {
        const parsed = MachineMetadataSchema.parse({
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '0.2.10',
            happyHomeDir: '/tmp/happier',
            homeDir: '/tmp',
            daemonSessionGoalControlsSupported: true,
        });

        expect(parsed.daemonSessionGoalControlsSupported).toBe(true);
    });
});
