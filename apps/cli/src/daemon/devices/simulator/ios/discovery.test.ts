import { describe, expect, it } from 'vitest';

describe('discoverIosSimulatorResources', () => {
    it.each(['command-failed', 'malformed', 'empty'] as const)('distinguishes %s from a successful device inventory', async outcome => {
        const { createDefaultIosSimulatorResourcesDiscovery } = await import('./discovery');
        const discover = createDefaultIosSimulatorResourcesDiscovery({
            platform: 'darwin',
            readProducerHealth: () => ({
                v: 1, platform: 'ios', status: 'unavailable', reasonCode: 'ios_native_producer_unavailable', diagnostics: [],
            }),
            runCommand: async ({ args }) => ({
                exitCode: args[0] === '--find' || outcome !== 'command-failed' ? 0 : 1,
                stdout: args[0] === '--find' ? '/Applications/Xcode.app/simctl'
                    : outcome === 'malformed' ? 'invalid json' : JSON.stringify({ devices: {} }),
                stderr: '',
            }),
        });
        expect(await discover()).toMatchObject({ refreshState: outcome === 'empty' ? 'idle' : 'error', resources: [] });
    });

    it('projects stopped devices independently of capture health', async () => {
        const { createIosSimulatorResource } = await import('./discovery');
        const resource = createIosSimulatorResource({
            device: { udid: 'stopped-device', name: 'iPhone', state: 'shutdown', runtime: 'ios-runtime' },
            health: {
                v: 1, platform: 'ios', status: 'unavailable', reasonCode: 'ios_native_producer_unavailable',
                diagnostics: [],
            },
        });
        expect(resource).toMatchObject({
            state: 'stopped', supportedDeviceOperations: ['boot'],
            capture: { status: 'unavailable', reasonCode: 'simulator_not_booted' },
            unavailableReason: 'simulator_not_booted',
        });
        expect(resource).not.toHaveProperty('runtimeId');
        expect(createIosSimulatorResource({
            device: { udid: 'running-device', name: 'iPhone', state: 'booted', runtime: 'ios-runtime' },
            health: { v: 1, platform: 'ios', status: 'unavailable', reasonCode: 'ios_native_producer_unavailable', diagnostics: [] },
        })).toMatchObject({ state: 'running', runtimeId: 'running-device' });
    });

    it('returns unsupported-host diagnostics without projecting resources', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        await expect(mod.discoverIosSimulatorResources({
            resolveXcodeEnvironment: async () => ({
                ok: false,
                reasonCode: 'unsupported_host',
                diagnostics: [{ code: 'unsupported_host' }],
            }),
            readProducerHealth: async () => { throw new Error('producer should not be read'); },
            runSimctl: async () => {
                throw new Error('simctl should not run');
            },
        })).resolves.toMatchObject({
            refreshState: 'idle',
            resources: [],
            health: {
                status: 'unavailable',
                reasonCode: 'unsupported_host',
            },
            diagnostics: [expect.objectContaining({ reasonCode: 'unsupported_host' })],
        });
    });

    it('projects booted simulators with unavailable capture when the native producer is unavailable', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        await expect(mod.discoverIosSimulatorResources({
            resolveXcodeEnvironment: async () => ({
                ok: true,
            }),
            readProducerHealth: async () => ({
                v: 1, platform: 'ios', status: 'unavailable', reasonCode: 'ios_native_producer_unavailable',
                diagnostics: [{ code: 'ios_native_producer_load_failed' }],
            }),
            runSimctl: async () => ({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                    devices: {
                        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
                            udid: 'A1B2-C3D4',
                            name: 'iPhone 16 Pro',
                            state: 'Booted',
                            isAvailable: true,
                        }],
                    },
                }),
            }),
        })).resolves.toMatchObject({
            resources: [{
                simulatorId: 'A1B2-C3D4',
                capture: {
                    status: 'unavailable',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    reasonCode: 'ios_native_producer_unavailable',
                },
                unavailableReason: 'ios_native_producer_unavailable',
            }],
            health: {
                status: 'unavailable',
                reasonCode: 'ios_native_producer_unavailable',
            },
        });
    });

    it('keeps producer-healthy booted simulators unavailable until the stream adapter is wired', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        await expect(mod.discoverIosSimulatorResources({
            resolveXcodeEnvironment: async () => ({
                ok: true,
            }),
            readProducerHealth: async () => ({
                v: 1,
                platform: 'ios',
                status: 'available',
                usesPrivateFrameworks: true,
                helperDistribution: 'bundled-native',
                requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                supportedCodecs: ['image.mjpeg'],
                supportedInputKinds: ['tap'],
            }),
            runSimctl: async () => ({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                    devices: {
                        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
                            udid: 'A1B2-C3D4',
                            name: 'iPhone 16 Pro',
                            state: 'Booted',
                            isAvailable: true,
                        }],
                    },
                }),
            }),
        })).resolves.toMatchObject({
            resources: [{
                simulatorId: 'A1B2-C3D4',
                capture: {
                    status: 'unavailable',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    reasonCode: 'ios_capture_adapter_unavailable',
                },
                unavailableReason: 'ios_capture_adapter_unavailable',
            }],
            health: {
                status: 'available',
            },
            diagnostics: [expect.objectContaining({
                reasonCode: 'ios_capture_adapter_unavailable',
            })],
        });
    });

    it('projects producer-healthy booted simulators as MJPEG exclusive resources when the stream adapter is explicitly available', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        const input = {
            resolveXcodeEnvironment: async () => ({
                ok: true,
            }),
            readProducerHealth: async () => ({
                v: 1,
                platform: 'ios',
                status: 'available',
                usesPrivateFrameworks: true,
                helperDistribution: 'bundled-native',
                requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                supportedCodecs: ['image.mjpeg'],
                supportedInputKinds: ['tap'],
            }),
            runSimctl: async () => ({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                    devices: {
                        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
                            udid: 'A1B2-C3D4',
                            name: 'iPhone 16 Pro',
                            state: 'Booted',
                            isAvailable: true,
                        }],
                    },
                }),
            }),
            captureAdapterAvailable: true,
        } as Parameters<typeof mod.discoverIosSimulatorResources>[0] & { captureAdapterAvailable: true };

        await expect(mod.discoverIosSimulatorResources(input)).resolves.toMatchObject({
            resources: [{
                simulatorId: 'A1B2-C3D4',
                capture: {
                    status: 'available',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    supportedCodecs: ['image.mjpeg'],
                    inputMode: 'exclusive',
                },
            }],
            health: {
                status: 'available',
            },
            diagnostics: [],
        });
    });



    it('discovers booted devices through platform tooling without assuming private framework locations', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.createDefaultIosSimulatorResourcesDiscovery).toBeTypeOf('function');
        if (!mod?.createDefaultIosSimulatorResourcesDiscovery) return;

        const discovery = mod.createDefaultIosSimulatorResourcesDiscovery({
            platform: 'darwin',
            readProducerHealth: async () => ({
                v: 1, platform: 'ios', status: 'unavailable', reasonCode: 'ios_native_producer_unavailable',
                diagnostics: [{ code: 'ios_native_producer_load_failed' }],
            }),
            runCommand: async (input) => {
                // The OS boundary models xcrun resolving the selected developer tools,
                // including a DEVELOPER_DIR override, rather than an Xcode directory layout.
                if (input.command === 'xcrun' && input.args.join(' ') === '--find simctl') {
                    return {
                        exitCode: 0,
                        stdout: '/Volumes/Developer Tools/Xcode.app/Contents/Developer/usr/bin/simctl\n',
                        stderr: '',
                    };
                }
                if (input.command !== 'xcrun' || input.args.join(' ') !== 'simctl list devices --json') {
                    return { exitCode: 1, stdout: '', stderr: 'unsupported developer tool' };
                }
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: JSON.stringify({
                        devices: {
                            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{
                                udid: 'A1B2-C3D4',
                                name: 'iPhone 16 Pro',
                                state: 'Booted',
                                isAvailable: true,
                            }],
                        },
                    }),
                };
            },
        });

        await expect(discovery()).resolves.toMatchObject({
            resources: [{
                simulatorId: 'A1B2-C3D4',
                capture: {
                    status: 'unavailable',
                    reasonCode: 'ios_native_producer_unavailable',
                },
            }],
            health: {
                status: 'unavailable',
                reasonCode: 'ios_native_producer_unavailable',
            },
        });
    });
});
