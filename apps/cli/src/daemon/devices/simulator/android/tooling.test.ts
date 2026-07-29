import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    parseAdbDevicesLongOutput,
    resolveAndroidAdbTooling,
    type AndroidToolRunner,
} from './tooling';

function createVersionRunner(output = 'Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\n'): AndroidToolRunner {
    return async () => ({
        exitCode: 0,
        stdout: output,
        stderr: '',
    });
}

describe('parseAdbDevicesLongOutput', () => {
    it('parses emulator and physical adb device records from long output', () => {
        const parsed = parseAdbDevicesLongOutput([
            'List of devices attached',
            'emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
            'emulator-5556 offline product:sdk model:Pixel_7 device:emu64 transport_id:2',
            'emulator-5558 unauthorized product:sdk model:Pixel_8 device:emu64 transport_id:3',
            'R58M1234567 device model:Pixel_8 product:oriole device:oriole transport_id:4',
            '',
        ].join('\n'));

        expect(parsed.records).toEqual([
            {
                serial: 'emulator-5554',
                state: 'device',
                product: 'sdk_gphone64_arm64',
                model: 'sdk_gphone64_arm64',
                device: 'emu64a',
                transportId: '1',
                raw: 'emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
            },
            {
                serial: 'emulator-5556',
                state: 'offline',
                product: 'sdk',
                model: 'Pixel_7',
                device: 'emu64',
                transportId: '2',
                raw: 'emulator-5556 offline product:sdk model:Pixel_7 device:emu64 transport_id:2',
            },
            {
                serial: 'emulator-5558',
                state: 'unauthorized',
                product: 'sdk',
                model: 'Pixel_8',
                device: 'emu64',
                transportId: '3',
                raw: 'emulator-5558 unauthorized product:sdk model:Pixel_8 device:emu64 transport_id:3',
            },
            {
                serial: 'R58M1234567',
                state: 'device',
                product: 'oriole',
                model: 'Pixel_8',
                device: 'oriole',
                transportId: '4',
                raw: 'R58M1234567 device model:Pixel_8 product:oriole device:oriole transport_id:4',
            },
        ]);
        expect(parsed.diagnostics).toEqual([]);
    });

    it('ignores malformed adb lines and records diagnostics', () => {
        const parsed = parseAdbDevicesLongOutput([
            'List of devices attached',
            'missing-state-only',
            'emulator-5554 device model:Pixel_8',
        ].join('\n'));

        expect(parsed.records).toHaveLength(1);
        expect(parsed.records[0]?.serial).toBe('emulator-5554');
        expect(parsed.diagnostics).toEqual([expect.objectContaining({
            reasonCode: 'malformed_adb_devices_output',
            raw: 'missing-state-only',
        })]);
    });
});

describe('resolveAndroidAdbTooling', () => {
    it('returns adb_unavailable when no env, SDK, or PATH candidate exists', async () => {
        await expect(resolveAndroidAdbTooling({
            env: {},
            pathExists: async () => false,
            findOnPath: async () => null,
            runner: createVersionRunner(),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'adb_unavailable',
        });
    });

    it('prefers the explicit env override and probes adb version', async () => {
        const runner = vi.fn(createVersionRunner());
        await expect(resolveAndroidAdbTooling({
            env: {
                HAPPIER_ANDROID_ADB_PATH: '/explicit/adb',
                ANDROID_HOME: '/android-home',
                PATH: '/bin',
            },
            pathExists: async (path) => path === '/explicit/adb' || path === join('/android-home', 'platform-tools', 'adb'),
            findOnPath: async () => '/path/adb',
            runner,
        })).resolves.toEqual({
            ok: true,
            command: '/explicit/adb',
            source: 'env_override',
            version: '1.0.41',
        });
        expect(runner).toHaveBeenCalledWith(expect.objectContaining({
            command: '/explicit/adb',
            args: ['version'],
        }));
    });

    it('resolves adb from Android SDK roots before PATH fallback', async () => {
        await expect(resolveAndroidAdbTooling({
            env: {
                ANDROID_SDK_ROOT: '/sdk-root',
                PATH: '/bin',
            },
            pathExists: async (path) => path === join('/sdk-root', 'platform-tools', 'adb'),
            findOnPath: async () => '/path/adb',
            runner: createVersionRunner(),
        })).resolves.toMatchObject({
            ok: true,
            command: join('/sdk-root', 'platform-tools', 'adb'),
            source: 'android_sdk',
        });
    });

    it('tries ANDROID_SDK_ROOT when ANDROID_HOME does not contain adb', async () => {
        await expect(resolveAndroidAdbTooling({
            env: {
                ANDROID_HOME: '/missing-home',
                ANDROID_SDK_ROOT: '/sdk-root',
                PATH: '/bin',
            },
            pathExists: async (path) => path === join('/sdk-root', 'platform-tools', 'adb'),
            findOnPath: async () => '/path/adb',
            runner: createVersionRunner(),
        })).resolves.toMatchObject({
            ok: true,
            command: join('/sdk-root', 'platform-tools', 'adb'),
            source: 'android_sdk',
        });
    });

    it('uses PATH only through the injected executable finder', async () => {
        const findOnPath = vi.fn(async () => '/usr/local/bin/adb');
        await expect(resolveAndroidAdbTooling({
            env: { PATH: '/usr/local/bin' },
            pathExists: async () => false,
            findOnPath,
            runner: createVersionRunner(),
        })).resolves.toMatchObject({
            ok: true,
            command: '/usr/local/bin/adb',
            source: 'path',
        });
        expect(findOnPath).toHaveBeenCalledWith('adb', { PATH: '/usr/local/bin' });
    });

    it('returns typed diagnostics when adb version probing fails', async () => {
        await expect(resolveAndroidAdbTooling({
            env: { HAPPIER_ANDROID_ADB_PATH: '/explicit/adb' },
            pathExists: async () => true,
            findOnPath: async () => null,
            runner: async () => ({
                exitCode: 1,
                stdout: 'x'.repeat(2_000),
                stderr: 'adb failed',
            }),
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'adb_unavailable',
            diagnostics: [expect.objectContaining({
                source: 'env_override',
                command: '/explicit/adb',
                probe: 'adb version',
                exitCode: 1,
                stdout: expect.stringMatching(/^x{512}$/),
                stderr: 'adb failed',
            })],
        });
    });
});
