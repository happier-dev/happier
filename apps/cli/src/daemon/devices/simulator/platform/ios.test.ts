import { describe, expect, it, vi } from 'vitest';

import type { SimulatorPreviewActionV1 } from '@happier-dev/protocol';

import { createDefaultIosSimulatorResourcesDiscovery } from '../ios/discovery';
import { resolveIosSimulatorNativeProducer, type IosSimulatorNativeAddon } from '../ios/native';
import { createIosSimulatorPlatformAdapter } from './ios';

// Genuine N-API and developer-tool process boundaries; discovery and platform logic stay real.
const addon: IosSimulatorNativeAddon = {
    SimCapture: class {
        async start() {} async stop() {}
        async subscribe() { return () => {}; }
        async screenSize() { return { width: 1179, height: 2556 }; }
        async updateStreamSettings() {}
    },
    SimHID: class { async touch() {} async button() {} async key() {} },
    async axTypeKeyboardCharacter() { return true; },
};

function discovery(options: { unavailable?: boolean; captureReady?: boolean; empty?: boolean } = {}) {
    const native = resolveIosSimulatorNativeProducer({ platform: 'darwin', arch: 'arm64', loadAddon: () => {
        if (options.unavailable) throw Object.assign(new Error('missing native dependency'), { code: 'ERR_DLOPEN_FAILED' });
        return addon;
    } });
    return createDefaultIosSimulatorResourcesDiscovery({
        platform: 'darwin', readProducerHealth: () => native.health,
        captureAdapterAvailable: options.captureReady !== false,
        runCommand: async ({ args }) => ({
            exitCode: 0, stderr: '', stdout: args[0] === '--find' ? '/selected-xcode/simctl' : JSON.stringify({ devices: {
                'iOS-runtime': options.empty ? [] : [{ udid: 'device-1', name: 'iPhone', state: 'Booted', isAvailable: true }],
            } }),
        }),
    });
}

const control = { v: 1, streamId: 'stream-1', sourceId: 'ios-simulator:device-1:screen', eventId: 'input-1', kind: 'tap', x: 0.2, y: 0.8 } as const;
const event: SimulatorPreviewActionV1 = { type: 'simulator.control.send', control };

describe('iOS simulator platform adapter', () => {
    it('consumes native discovery health and keeps a device visible when its producer cannot load', async () => {
        const adapter = createIosSimulatorPlatformAdapter({ discoverResources: discovery({ unavailable: true }) });
        await expect(adapter.health()).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'ios_native_producer_unavailable' });
        await expect(adapter.listResources()).resolves.toMatchObject([{ deviceId: 'device-1', capture: { status: 'unavailable', reasonCode: 'ios_native_producer_unavailable' } }]);
        await expect(adapter.capture({ simulatorId: 'device-1' })).resolves.toEqual({ ok: false, reasonCode: 'ios_native_producer_unavailable' });
        await expect(adapter.listDiagnostics()).resolves.toMatchObject([{ reasonCode: 'ios_native_producer_unavailable' }]);
    });

    it('uses resource capture readiness even when native health is available', async () => {
        const adapter = createIosSimulatorPlatformAdapter({ discoverResources: discovery({ captureReady: false }) });
        await expect(adapter.health()).resolves.toMatchObject({ status: 'available' });
        await expect(adapter.capture({ simulatorId: 'device-1' })).resolves.toEqual({ ok: false, reasonCode: 'ios_capture_adapter_unavailable' });
        const [resource] = await adapter.listResources();
        await expect(adapter.dispatchAction({ event, resource })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'ios_capture_adapter_unavailable' });
    });

    it('publishes the native codecs and dispatches through the native input boundary', async () => {
        const sendInputCommand = vi.fn(async () => ({ ok: true as const }));
        const adapter = createIosSimulatorPlatformAdapter({ discoverResources: discovery(), sendInputCommand });
        const [resource] = await adapter.listResources();
        expect(resource.capture).toMatchObject({ status: 'available', supportedCodecs: ['h264.avcc', 'image.mjpeg'] });
        await expect(adapter.capture({ simulatorId: resource.simulatorId })).resolves.toEqual({ ok: true });
        await expect(adapter.dispatchAction({ event, resource })).resolves.toMatchObject({ status: 'accepted' });
        expect(sendInputCommand).toHaveBeenCalledWith(control);
    });

    it('refuses control without resource authority, a discovered target or an input sender', async () => {
        const available = createIosSimulatorPlatformAdapter({ discoverResources: discovery() });
        const [resource] = await available.listResources();
        await expect(available.dispatchAction({ event })).resolves.toMatchObject({ status: 'rejected', reasonCode: 'simulator_resource_authority_required' });
        await expect(available.dispatchAction({ event, resource })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'ios_simulator_input_sender_unavailable' });
        const absent = createIosSimulatorPlatformAdapter({ discoverResources: discovery({ empty: true }) });
        await expect(absent.dispatchAction({ event, resource })).resolves.toMatchObject({ status: 'rejected', reasonCode: 'simulator_resource_authority_required' });
        await expect(absent.capture({ simulatorId: resource.simulatorId })).resolves.toEqual({ ok: false, reasonCode: 'unknown_simulator' });
        await expect(available.dispatchAction({ event: { ...event, control: { ...control, sourceId: 'ios-simulator:other:screen' } }, resource })).resolves.toMatchObject({ status: 'rejected', reasonCode: 'unknown_simulator_source' });
    });

    it('returns capture health from the same discovery result and refuses unsupported sidebands', async () => {
        const adapter = createIosSimulatorPlatformAdapter({ discoverResources: discovery(), now: () => 123 });
        const [resource] = await adapter.listResources();
        await expect(adapter.dispatchAction({ event: { type: 'simulator.sideband.request', simulatorId: resource.simulatorId, kind: 'capture_health' }, resource })).resolves.toMatchObject({
            status: 'accepted', sideband: { status: 'available', emittedAtMs: 123 },
        });
        await expect(adapter.dispatchAction({ event: { type: 'simulator.sideband.request', simulatorId: resource.simulatorId, kind: 'logs' }, resource })).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'simulator_logs_not_started' });
    });
});
