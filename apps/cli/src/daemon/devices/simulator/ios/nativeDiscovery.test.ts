import { describe, expect, it } from 'vitest';

import type { IosSimulatorAdapterHealthV1 } from '@happier-dev/protocol';

import { createDefaultIosSimulatorResourcesDiscovery } from './discovery';

describe('native producer discovery', () => {
    it('publishes a loaded producer for a booted device and keeps stopped devices discoverable without capture', async () => {
        const health: IosSimulatorAdapterHealthV1 = {
            v: 1, platform: 'ios', status: 'available', usesPrivateFrameworks: true,
            helperDistribution: 'bundled-native', requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
            supportedCodecs: ['h264.avcc', 'image.mjpeg'], supportedInputKinds: ['tap'],
        };
        const options = {
            platform: 'darwin', captureAdapterAvailable: true, readProducerHealth: () => health,
            runCommand: async ({ args }: { args: readonly string[] }) => ({
                exitCode: 0, stderr: '', stdout: args[0] === '--find' ? '/selected-xcode/simctl' : JSON.stringify({
                    devices: { 'iOS-18-6': [
                        { udid: 'running', name: 'iPhone', state: 'Booted', isAvailable: true },
                        { udid: 'stopped', name: 'iPad', state: 'Shutdown', isAvailable: true },
                    ] },
                }),
            }),
        };
        const result = await createDefaultIosSimulatorResourcesDiscovery(options)();
        expect(result.health).toEqual(health);
        expect(result.resources).toMatchObject([
            { deviceId: 'running', capture: { status: 'available', supportedCodecs: ['h264.avcc', 'image.mjpeg'] } },
            { deviceId: 'stopped', capture: { status: 'unavailable', reasonCode: 'simulator_not_booted' } },
        ]);
    });
});
