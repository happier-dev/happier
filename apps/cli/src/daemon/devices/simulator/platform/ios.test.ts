import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1, type SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

const iosControlResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'A1B2-C3D4',
    platform: 'ios',
    deviceId: 'A1B2-C3D4',
    displayName: 'iPhone 16 Pro',
    capture: {
        status: 'available',
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

describe('iOS simulator platform adapter', () => {
    it('keeps private-framework capture isolated behind typed unavailable diagnostics', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({ helperAvailable: false });
        expect(adapter.platform).toBe('ios');
        expect(adapter.usesPrivateFrameworks).toBe(true);
        await expect(adapter.health()).resolves.toMatchObject({
            v: 1,
            platform: 'ios',
            status: 'unavailable',
            reasonCode: 'ios_private_helper_unavailable',
        });
        await expect(adapter.capture({ simulatorId: 'sim_1' })).resolves.toEqual({
            ok: false,
            reasonCode: 'ios_private_helper_unavailable',
            requiredOwner: 'signed_ios_simulator_private_framework_helper',
            privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
        });
    });

    it('does not advertise input verbs in health while the capture adapter is unavailable (L1 honesty)', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        // Helper reports healthy but the capture adapter is not wired: the resource downgrades to
        // ios_capture_adapter_unavailable, so health must not advertise input verbs it cannot service.
        const adapter = mod.createIosSimulatorPlatformAdapter({ helperAvailable: true });
        const health = await adapter.health();
        expect(health.status).toBe('available');
        if (health.status !== 'available') return;
        expect(health.supportedInputKinds).toEqual([]);
    });

    it('advertises input verbs in health only once the capture adapter is wired', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            captureAdapterAvailable: true,
        });
        const health = await adapter.health();
        expect(health.status).toBe('available');
        if (health.status !== 'available') return;
        expect(health.supportedInputKinds).toEqual(['tap', 'swipe', 'keyboard_text', 'hardware_button']);
    });

    it('keeps helper-healthy iOS simulators unavailable until the capture adapter is wired', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            discoverBootedSimulators: async () => [{
                udid: 'A1B2-C3D4',
                name: 'iPhone 16 Pro',
                runtime: 'iOS 18.0',
            }],
        });

        await expect(adapter.listResources()).resolves.toEqual([{
            v: 1,
            simulatorId: 'A1B2-C3D4',
            platform: 'ios',
            deviceId: 'A1B2-C3D4',
            displayName: 'iPhone 16 Pro',
            capture: {
                status: 'unavailable',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                reasonCode: 'ios_capture_adapter_unavailable',
            },
            unavailableReason: 'ios_capture_adapter_unavailable',
        }]);
    });

    it('projects booted iOS simulators as available when the capture adapter is explicitly wired', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            captureAdapterAvailable: true,
            discoverBootedSimulators: async () => [{
                udid: 'A1B2-C3D4',
                name: 'iPhone 16 Pro',
                runtime: 'iOS 18.0',
            }],
        });

        await expect(adapter.listResources()).resolves.toEqual([{
            v: 1,
            simulatorId: 'A1B2-C3D4',
            platform: 'ios',
            deviceId: 'A1B2-C3D4',
            displayName: 'iPhone 16 Pro',
            capture: {
                status: 'available',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                supportedCodecs: ['image.mjpeg'],
                inputMode: 'exclusive',
                supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'hardware_button'],
                streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
            },
        }]);
    });

    it('returns capture-health sidebands from the iOS platform adapter without entering input dispatch', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const sendInputCommand = vi.fn(async () => ({ ok: true as const }));
        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            captureAdapterAvailable: true,
            sendInputCommand,
        });

        await expect(adapter.dispatchAction({
            resource: iosControlResource,
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'A1B2-C3D4',
                kind: 'capture_health',
            },
        })).resolves.toMatchObject({
            status: 'accepted',
            sideband: {
                kind: 'capture_health',
                simulatorId: 'A1B2-C3D4',
                status: 'available',
            },
        });
        expect(sendInputCommand).not.toHaveBeenCalled();
    });

    it('fails closed with a sideband-specific iOS reason for unsupported sidebands', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            captureAdapterAvailable: true,
        });

        await expect(adapter.dispatchAction({
            resource: iosControlResource,
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'A1B2-C3D4',
                kind: 'logs',
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_simulator_sideband_logs_unsupported',
        });
    });

    it('keeps discovered iOS simulators visible with unavailable capture when helper health fails', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: false,
            discoverBootedSimulators: async () => [{
                udid: 'A1B2-C3D4',
                name: 'iPhone 16 Pro',
                runtime: 'iOS 18.0',
            }],
        });

        await expect(adapter.listResources()).resolves.toEqual([{
            v: 1,
            simulatorId: 'A1B2-C3D4',
            platform: 'ios',
            deviceId: 'A1B2-C3D4',
            displayName: 'iPhone 16 Pro',
            capture: {
                status: 'unavailable',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                reasonCode: 'ios_private_helper_unavailable',
            },
            unavailableReason: 'ios_private_helper_unavailable',
        }]);
    });

    it('consumes iOS discovery results as the platform adapter source of truth', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [{
                    v: 1,
                    simulatorId: 'A1B2-C3D4',
                    platform: 'ios',
                    deviceId: 'A1B2-C3D4',
                    displayName: 'iPhone 16 Pro',
                    capture: {
                        status: 'unavailable',
                        sourceId: 'ios-simulator:A1B2-C3D4:screen',
                        reasonCode: 'helper_artifact_missing',
                    },
                    unavailableReason: 'helper_artifact_missing',
                }],
                diagnostics: [{
                    platform: 'ios',
                    reasonCode: 'helper_artifact_missing',
                }],
                health: {
                    v: 1,
                    platform: 'ios',
                    status: 'unavailable',
                    reasonCode: 'helper_artifact_missing',
                    diagnostics: [{ code: 'helper_missing' }],
                },
            }),
        });

        await expect(adapter.health()).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'helper_artifact_missing',
        });
        await expect(adapter.listResources()).resolves.toEqual([expect.objectContaining({
            simulatorId: 'A1B2-C3D4',
        })]);
        await expect(adapter.listDiagnostics()).resolves.toEqual([expect.objectContaining({
            reasonCode: 'helper_artifact_missing',
        })]);
    });

    it('uses discovery resource capture state instead of health alone for capture availability', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [{
                    v: 1,
                    simulatorId: 'A1B2-C3D4',
                    platform: 'ios',
                    deviceId: 'A1B2-C3D4',
                    displayName: 'iPhone 16 Pro',
                    capture: {
                        status: 'unavailable',
                        sourceId: 'ios-simulator:A1B2-C3D4:screen',
                        reasonCode: 'ios_capture_adapter_unavailable',
                    },
                    unavailableReason: 'ios_capture_adapter_unavailable',
                }],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'ios',
                    status: 'available',
                    usesPrivateFrameworks: true,
                    helperDistribution: 'prebuilt-signed',
                    requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                    supportedCodecs: ['image.mjpeg'],
                    supportedInputKinds: ['tap'],
                },
            }),
        });

        await expect(adapter.capture({ simulatorId: 'A1B2-C3D4' })).resolves.toEqual({
            ok: false,
            reasonCode: 'ios_capture_adapter_unavailable',
        });
    });

    it('fails closed for available controls when no iOS helper command sender is supplied', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createIosSimulatorPlatformAdapter({ helperAvailable: true });

        await expect(adapter.dispatchAction({
            resource: iosControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    eventId: 'event-1',
                    x: 0.25,
                    y: 0.75,
                },
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_simulator_input_sender_unavailable',
        });
    });

    it('fails closed instead of dispatching iOS input without composed resource authority', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const sendInputCommand = vi.fn(async () => ({ ok: true as const }));
        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            sendInputCommand,
        });

        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    eventId: 'event-1',
                    x: 0.25,
                    y: 0.75,
                },
            },
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'simulator_resource_authority_required',
        });
        expect(sendInputCommand).not.toHaveBeenCalled();
    });

    it('fails closed instead of dispatching iOS input for resources not returned by discovery', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const sendInputCommand = vi.fn(async () => ({ ok: true as const }));
        const adapter = mod.createIosSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'ios',
                    status: 'available',
                    usesPrivateFrameworks: true,
                    helperDistribution: 'prebuilt-signed',
                    requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                    supportedCodecs: ['image.mjpeg'],
                    supportedInputKinds: ['tap'],
                },
            }),
            sendInputCommand,
        });

        await expect(adapter.dispatchAction({
            resource: iosControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    eventId: 'event-1',
                    x: 0.25,
                    y: 0.75,
                },
            },
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'simulator_resource_authority_required',
        });
        expect(sendInputCommand).not.toHaveBeenCalled();
    });

    it('dispatches available control actions through the injected iOS helper sender', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const sendInputCommand = vi.fn(async () => ({ ok: true as const }));
        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            // Capability-truth: input verbs are only advertised — and therefore only dispatchable —
            // once the capture adapter is wired, matching the resource downgrade contract.
            captureAdapterAvailable: true,
            sendInputCommand,
        });

        await expect(adapter.dispatchAction({
            resource: iosControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    eventId: 'event-1',
                    x: 0.25,
                    y: 0.75,
                },
            },
        })).resolves.toMatchObject({ status: 'accepted' });
        expect(sendInputCommand).toHaveBeenCalledTimes(1);
    });

    it('fails closed for input dispatch while the capture adapter is unavailable even with a sender wired', async () => {
        const mod = await import('./ios').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createIosSimulatorPlatformAdapter');
        if (!('createIosSimulatorPlatformAdapter' in mod)) return;

        const sendInputCommand = vi.fn(async () => ({ ok: true as const }));
        const adapter = mod.createIosSimulatorPlatformAdapter({
            helperAvailable: true,
            sendInputCommand,
        });

        // health advertises no input verbs while capture is unavailable, so the verb is unsupported.
        await expect(adapter.dispatchAction({
            resource: iosControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'ios-simulator:A1B2-C3D4:screen',
                    eventId: 'event-1',
                    x: 0.25,
                    y: 0.75,
                },
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_simulator_control_unsupported',
        });
        expect(sendInputCommand).not.toHaveBeenCalled();
    });
});
