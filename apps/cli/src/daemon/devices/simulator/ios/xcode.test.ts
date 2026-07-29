import { describe, expect, it, vi } from 'vitest';

describe('resolveIosSimulatorXcodeEnvironment', () => {
    it('does not run Xcode commands on unsupported hosts', async () => {
        const mod = await import('./xcode').catch(() => null);

        expect(mod?.resolveIosSimulatorXcodeEnvironment).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorXcodeEnvironment) return;

        const runCommand = vi.fn();
        await expect(mod.resolveIosSimulatorXcodeEnvironment({
            platform: 'linux',
            runCommand,
            pathExists: async () => true,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'unsupported_host',
        });
        expect(runCommand).not.toHaveBeenCalled();
    });

    it('returns xcode_unavailable when selected Xcode cannot be resolved', async () => {
        const mod = await import('./xcode').catch(() => null);

        expect(mod?.resolveIosSimulatorXcodeEnvironment).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorXcodeEnvironment) return;

        await expect(mod.resolveIosSimulatorXcodeEnvironment({
            platform: 'darwin',
            runCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'xcode-select: error' }),
            pathExists: async () => true,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'xcode_unavailable',
        });
    });

    it('requires CoreSimulator and SimulatorKit private frameworks', async () => {
        const mod = await import('./xcode').catch(() => null);

        expect(mod?.resolveIosSimulatorXcodeEnvironment).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorXcodeEnvironment) return;

        await expect(mod.resolveIosSimulatorXcodeEnvironment({
            platform: 'darwin',
            runCommand: async () => ({ exitCode: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '' }),
            pathExists: async (path) => !path.includes('SimulatorKit.framework'),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'xcode_private_frameworks_unavailable',
        });
    });

    it('returns selected Xcode and private framework paths on supported hosts', async () => {
        const mod = await import('./xcode').catch(() => null);

        expect(mod?.resolveIosSimulatorXcodeEnvironment).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorXcodeEnvironment) return;

        await expect(mod.resolveIosSimulatorXcodeEnvironment({
            platform: 'darwin',
            runCommand: async () => ({ exitCode: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '' }),
            pathExists: async () => true,
        })).resolves.toEqual({
            ok: true,
            developerDir: '/Applications/Xcode.app/Contents/Developer',
            privateFrameworks: {
                CoreSimulator: '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/PrivateFrameworks/CoreSimulator.framework',
                SimulatorKit: '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/PrivateFrameworks/SimulatorKit.framework',
            },
        });
    });
});
