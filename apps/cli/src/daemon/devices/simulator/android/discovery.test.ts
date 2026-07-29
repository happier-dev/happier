import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

function sha256(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const trustedServerBytes = new TextEncoder().encode('trusted scrcpy server bytes');
const trustedScrcpyArtifact = {
    version: '3.2',
    digest: sha256(trustedServerBytes),
};

describe('discoverAndroidSimulatorResources', () => {
    it('returns adb_unavailable diagnostics without resolving the scrcpy artifact', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverAndroidSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverAndroidSimulatorResources) return;

        await expect(mod.discoverAndroidSimulatorResources({
            resolveAdbTooling: async () => ({
                ok: false,
                reasonCode: 'adb_unavailable',
                diagnostics: [{ code: 'adb_missing' }],
            }),
            resolveScrcpyServerArtifact: async () => {
                throw new Error('scrcpy artifact should not be read');
            },
            runAdb: async () => {
                throw new Error('adb devices should not run');
            },
        })).resolves.toMatchObject({
            resources: [],
            health: {
                status: 'unavailable',
                reasonCode: 'adb_unavailable',
            },
            diagnostics: [expect.objectContaining({ reasonCode: 'adb_unavailable' })],
        });
    });

    it('projects authorized emulators with unavailable capture when the scrcpy server artifact is missing', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverAndroidSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverAndroidSimulatorResources) return;

        await expect(mod.discoverAndroidSimulatorResources({
            resolveAdbTooling: async () => ({
                ok: true,
                command: '/android/platform-tools/adb',
                source: 'android_sdk',
                version: '1.0.41',
            }),
            resolveScrcpyServerArtifact: async () => ({
                ok: false,
                reasonCode: 'scrcpy_server_artifact_missing',
                diagnostics: [{ code: 'scrcpy_missing' }],
            }),
            runAdb: async () => ({
                exitCode: 0,
                stdout: [
                    'List of devices attached',
                    'emulator-5554 device product:sdk model:Pixel_9 device:emu64 transport_id:1',
                ].join('\n'),
                stderr: '',
            }),
        })).resolves.toMatchObject({
            resources: [{
                simulatorId: 'android:emulator:emulator-5554',
                platform: 'android',
                deviceId: 'emulator-5554',
                displayName: 'Pixel_9',
                capture: {
                    status: 'unavailable',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    reasonCode: 'scrcpy_server_artifact_missing',
                },
                unavailableReason: 'scrcpy_server_artifact_missing',
            }],
            health: {
                status: 'unavailable',
                reasonCode: 'scrcpy_server_artifact_missing',
            },
            diagnostics: [expect.objectContaining({
                reasonCode: 'scrcpy_server_artifact_missing',
            })],
        });
    });

    it('keeps physical devices unsupported and emulators bridge-unavailable after trusted artifact discovery', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverAndroidSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverAndroidSimulatorResources) return;

        await expect(mod.discoverAndroidSimulatorResources({
            resolveAdbTooling: async () => ({
                ok: true,
                command: '/android/platform-tools/adb',
                source: 'android_sdk',
                version: '1.0.41',
            }),
            resolveScrcpyServerArtifact: async () => ({
                ok: true,
                path: '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
                version: trustedScrcpyArtifact.version,
                digest: trustedScrcpyArtifact.digest,
                source: 'dev_fixture',
            }),
            runAdb: async () => ({
                exitCode: 0,
                stdout: [
                    'List of devices attached',
                    'emulator-5554 device product:sdk model:Pixel_9 device:emu64 transport_id:1',
                    'R58M1234567 device model:Pixel_8 product:oriole device:oriole transport_id:2',
                ].join('\n'),
                stderr: '',
            }),
        })).resolves.toMatchObject({
            resources: [
                {
                    simulatorId: 'android:emulator:emulator-5554',
                    capture: {
                        status: 'unavailable',
                        reasonCode: 'android_emulator_bridge_unavailable',
                    },
                    unavailableReason: 'android_emulator_bridge_unavailable',
                },
                {
                    simulatorId: 'android:physical:R58M1234567',
                    capture: {
                        status: 'unavailable',
                        reasonCode: 'physical_device_not_supported_v1',
                    },
                    unavailableReason: 'physical_device_not_supported_v1',
                },
            ],
            health: {
                status: 'unavailable',
                reasonCode: 'android_emulator_bridge_unavailable',
            },
            diagnostics: [expect.objectContaining({
                reasonCode: 'android_emulator_bridge_unavailable',
            })],
        });
    });

    it('builds a default discovery reader that projects trusted emulator bridge health as available', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.createDefaultAndroidSimulatorResourcesDiscovery).toBeTypeOf('function');
        if (!mod?.createDefaultAndroidSimulatorResourcesDiscovery) return;

        const discovery = mod.createDefaultAndroidSimulatorResourcesDiscovery({
            resolveAdbTooling: async () => ({
                ok: true,
                command: '/android/platform-tools/adb',
                source: 'android_sdk',
                version: '1.0.41',
            }),
            resolveScrcpyServerArtifact: async () => ({
                ok: true,
                path: '/runtime/assets/android/scrcpy-server/scrcpy-server.jar',
                version: trustedScrcpyArtifact.version,
                digest: trustedScrcpyArtifact.digest,
                source: 'dev_fixture',
            }),
            runAdb: async () => ({
                exitCode: 0,
                stdout: [
                    'List of devices attached',
                    'emulator-5554 device product:sdk model:Pixel_9 device:emu64 transport_id:1',
                ].join('\n'),
                stderr: '',
            }),
        });

        await expect(discovery()).resolves.toMatchObject({
            resources: [{
                simulatorId: 'android:emulator:emulator-5554',
                platform: 'android',
                deviceId: 'emulator-5554',
                displayName: 'Pixel_9',
                capture: {
                    status: 'available',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    supportedCodecs: ['h264.avcc'],
                    inputMode: 'exclusive',
                },
            }],
            health: {
                status: 'available',
                transport: 'scrcpy-local-sockets-over-pms',
                scrcpyServerVersion: trustedScrcpyArtifact.version,
                scrcpyServerDigest: trustedScrcpyArtifact.digest,
            },
            diagnostics: [],
        });
    });
});
