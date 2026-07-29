import { describe, expect, it } from 'vitest';

describe('discoverIosSimulatorResources', () => {
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
            resolveHelperArtifact: async () => {
                throw new Error('helper should not be resolved');
            },
            probeHelperHealth: async () => {
                throw new Error('helper should not be probed');
            },
            runSimctl: async () => {
                throw new Error('simctl should not run');
            },
        })).resolves.toMatchObject({
            resources: [],
            health: {
                status: 'unavailable',
                reasonCode: 'unsupported_host',
            },
            diagnostics: [expect.objectContaining({ reasonCode: 'unsupported_host' })],
        });
    });

    it('projects booted simulators with unavailable capture when the helper artifact is missing', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        await expect(mod.discoverIosSimulatorResources({
            resolveXcodeEnvironment: async () => ({
                ok: true,
                developerDir: '/Applications/Xcode.app/Contents/Developer',
                privateFrameworks: {
                    CoreSimulator: '/CoreSimulator.framework',
                    SimulatorKit: '/SimulatorKit.framework',
                },
            }),
            resolveHelperArtifact: async () => ({
                ok: false,
                reasonCode: 'helper_artifact_missing',
                diagnostics: [{ code: 'helper_missing' }],
            }),
            probeHelperHealth: async () => {
                throw new Error('helper should not be probed');
            },
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
                    reasonCode: 'helper_artifact_missing',
                },
                unavailableReason: 'helper_artifact_missing',
            }],
            health: {
                status: 'unavailable',
                reasonCode: 'helper_artifact_missing',
            },
        });
    });

    it('keeps helper-healthy booted simulators unavailable until the stream adapter is wired', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        await expect(mod.discoverIosSimulatorResources({
            resolveXcodeEnvironment: async () => ({
                ok: true,
                developerDir: '/Applications/Xcode.app/Contents/Developer',
                privateFrameworks: {
                    CoreSimulator: '/CoreSimulator.framework',
                    SimulatorKit: '/SimulatorKit.framework',
                },
            }),
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/tmp/helper',
                version: '1.2.3',
                digest: 'sha256:helper',
            }),
            probeHelperHealth: async () => ({
                v: 1,
                platform: 'ios',
                status: 'available',
                usesPrivateFrameworks: true,
                helperDistribution: 'prebuilt-signed',
                requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                supportedCodecs: ['image.mjpeg'],
                supportedInputKinds: ['tap'],
                helperVersion: '1.2.3',
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

    it('projects helper-healthy booted simulators as MJPEG exclusive resources when the stream adapter is explicitly available', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.discoverIosSimulatorResources).toBeTypeOf('function');
        if (!mod?.discoverIosSimulatorResources) return;

        const input = {
            resolveXcodeEnvironment: async () => ({
                ok: true,
                developerDir: '/Applications/Xcode.app/Contents/Developer',
                privateFrameworks: {
                    CoreSimulator: '/CoreSimulator.framework',
                    SimulatorKit: '/SimulatorKit.framework',
                },
            }),
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/tmp/helper',
                version: '1.2.3',
                digest: 'sha256:helper',
            }),
            probeHelperHealth: async () => ({
                v: 1,
                platform: 'ios',
                status: 'available',
                usesPrivateFrameworks: true,
                helperDistribution: 'prebuilt-signed',
                requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                supportedCodecs: ['image.mjpeg'],
                supportedInputKinds: ['tap'],
                helperVersion: '1.2.3',
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

    it('keeps the pinned helper artifact fail-closed until a real signed artifact is vendored', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.resolvePinnedIosSimulatorHelperArtifact).toBeTypeOf('function');
        if (!mod?.resolvePinnedIosSimulatorHelperArtifact) return;

        // The pinned constant carries the all-zero placeholder digest, so resolution must fail
        // closed (helper_artifact_missing) regardless of host — capture availability stays off
        // until a genuine signed/notarized helper + digest is pinned and the verifier accepts it.
        await expect(mod.resolvePinnedIosSimulatorHelperArtifact()).resolves.toMatchObject({
            ok: false,
        });
    });

    it('derives capture availability from a verified pinned helper resolution', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.resolveIosSimulatorCaptureAdapterAvailability).toBeTypeOf('function');
        if (!mod?.resolveIosSimulatorCaptureAdapterAvailability) return;

        // Verified resolution → available; failed resolution → unavailable. This is the gate the
        // daemon uses to flip captureAdapterAvailable, so it must be true ONLY when the artifact
        // verifies.
        await expect(mod.resolveIosSimulatorCaptureAdapterAvailability({
            resolveHelperArtifact: async () => ({
                ok: true,
                path: '/tmp/helper',
                version: '1.2.3',
                digest: 'sha256:helper',
            }),
        })).resolves.toBe(true);

        await expect(mod.resolveIosSimulatorCaptureAdapterAvailability({
            resolveHelperArtifact: async () => ({
                ok: false,
                reasonCode: 'helper_artifact_missing',
                diagnostics: [],
            }),
        })).resolves.toBe(false);
    });

    it('builds an injectable default discovery reader for startup wiring', async () => {
        const mod = await import('./discovery').catch(() => null);

        expect(mod?.createDefaultIosSimulatorResourcesDiscovery).toBeTypeOf('function');
        if (!mod?.createDefaultIosSimulatorResourcesDiscovery) return;

        const discovery = mod.createDefaultIosSimulatorResourcesDiscovery({
            platform: 'darwin',
            pathExists: async () => true,
            resolveHelperArtifact: async () => ({
                ok: false,
                reasonCode: 'helper_artifact_missing',
                diagnostics: [{ code: 'helper_missing' }],
            }),
            runCommand: async (input) => {
                if (input.command === 'xcode-select') {
                    return {
                        exitCode: 0,
                        stdout: '/Applications/Xcode.app/Contents/Developer\n',
                        stderr: '',
                    };
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
            runHelper: async () => {
                throw new Error('helper should not be probed when artifact is missing');
            },
        });

        await expect(discovery()).resolves.toMatchObject({
            resources: [{
                simulatorId: 'A1B2-C3D4',
                capture: {
                    status: 'unavailable',
                    reasonCode: 'helper_artifact_missing',
                },
            }],
            health: {
                status: 'unavailable',
                reasonCode: 'helper_artifact_missing',
            },
        });
    });
});
