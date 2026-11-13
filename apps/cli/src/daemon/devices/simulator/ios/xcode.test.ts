import { describe, expect, it, vi } from 'vitest';

import { resolveIosSimulatorXcodeEnvironment } from './xcode';

describe('resolveIosSimulatorXcodeEnvironment', () => {
    it('does not run Xcode commands on unsupported hosts', async () => {
        const runCommand = vi.fn();
        await expect(resolveIosSimulatorXcodeEnvironment({
            platform: 'linux',
            runCommand,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'unsupported_host',
        });
        expect(runCommand).not.toHaveBeenCalled();
    });

    it.each([
        { exitCode: 1, stdout: '', stderr: 'xcrun: unable to find simctl' },
        { exitCode: 0, stdout: '\n', stderr: '' },
    ])('returns xcode_unavailable when platform tooling cannot resolve simctl: %j', async (result) => {
        await expect(resolveIosSimulatorXcodeEnvironment({
            platform: 'darwin',
            runCommand: async () => result,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'xcode_unavailable',
        });
    });

    it('accepts simctl resolved by xcrun without deriving framework paths', async () => {
        await expect(resolveIosSimulatorXcodeEnvironment({
            platform: 'darwin',
            // xcrun is the platform boundary for the active developer selection.
            runCommand: async ({ command, args }) => {
                expect({ command, args }).toEqual({ command: 'xcrun', args: ['--find', 'simctl'] });
                return {
                    exitCode: 0,
                    stdout: '/Volumes/Developer Tools/Xcode.app/Contents/Developer/usr/bin/simctl\n',
                    stderr: '',
                };
            },
        })).resolves.toEqual({ ok: true });
    });
});
