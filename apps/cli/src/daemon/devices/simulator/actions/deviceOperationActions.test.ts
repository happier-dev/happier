import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSessionImageMediaWriter } from '@/session/media/createSessionImageMediaWriter';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createSimulatorPreviewDaemonRuntime } from '../runtime';
import { createSimulatorDaemonRuntimeActionExecutor } from './runtimeActionExecutor';

const gate = { isEnabled: () => true, refresh: async () => {} };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

describe('simulator device Action integration', () => {
    it('refuses the retired keyframe-only snapshot event', async () => {
        const runtime = createSimulatorPreviewDaemonRuntime({ machineId: 'machine' });
        try {
            expect(await runtime.routes.dispatchAction({ type: 'simulator.snapshot.request',
                simulatorId: 'device', streamId: 'stream', sourceId: 'source', eventId: 'capture' }))
                .toMatchObject({ status: 'unavailable', reasonCode: 'simulator_screenshot_requires_device_action' });
        } finally { await runtime.stop(); }
    });

    it('refuses a device operation when the device-operation owner is unavailable', async () => {
        const runtime = createSimulatorPreviewDaemonRuntime({ machineId: 'machine' });
        const execute = createSimulatorDaemonRuntimeActionExecutor({ routes: runtime.routes, featureGate: gate });
        try {
            expect(await execute({ actionId: 'devices.simulator.device.boot',
                input: { operation: 'boot', platform: 'ios', deviceId: 'owned-device' }, context: {} }))
                .toMatchObject({ ok: false, errorCode: 'simulator_device_operations_unavailable', step: 'boot' });
        } finally { await runtime.stop(); }
    });

    it('persists actual screenshot bytes through Session media and binds agent captures to their Session', async () => {
        const { createSimulatorDeviceOperations } = await import('../operations/deviceOperations');
        const { createSimulatorDeviceOperationRoutes } = await import('../operations/routes');
        const cwd = await mkdtemp(join(tmpdir(), 'happier-simulator-media-'));
        const runtime = createSimulatorPreviewDaemonRuntime({ machineId: 'machine' });
        // The native process is the boundary; operation dispatch and media persistence are real.
        let nativeCaptures = 0;
        const operations = createSimulatorDeviceOperations({ platform: 'linux',
            resolveAdb: async () => ({ ok: true, command: '/sdk/adb', source: 'path' }), run: async () => {
            nativeCaptures += 1;
            return { exitCode: 0, stdout: PNG, stderr: '' };
        } });
        const routes = createSimulatorDeviceOperationRoutes({ previewRoutes: runtime.routes, operations,
            mediaWriter: createSessionImageMediaWriter({ workingDirectory: cwd, storage: 'daemon',
                pathAllowanceRegistry: createTransferPathAllowanceRegistry() }) });
        const execute = createSimulatorDaemonRuntimeActionExecutor({ routes, featureGate: gate });
        try {
            const input = { operation: 'screenshot', platform: 'android', deviceId: 'owned-device', sessionId: 'session-1' };
            const captured = await execute({ actionId: 'devices.simulator.screenshot.capture', input,
                context: { defaultSessionId: 'session-1' } });
            expect(captured).toMatchObject({ ok: true, media: { width: 1, height: 1,
                file: { sessionId: 'session-1', storage: 'daemon', mimeType: 'image/png' } } });
            const { SimulatorDeviceOperationResultV1Schema } = await import('@happier-dev/protocol/devices/simulator/operationsV1');
            const result = SimulatorDeviceOperationResultV1Schema.parse(captured);
            if (!result.ok || !result.media?.file) throw new Error('Expected real screenshot media');
            expect(await readFile(join(cwd, result.media.file.path))).toEqual(PNG);

            expect(await execute({ actionId: 'devices.simulator.stream.snapshot', input: { ...input, sessionId: 'other-session' },
                context: { defaultSessionId: 'session-1' } }))
                .toMatchObject({ ok: false, errorCode: 'simulator_screenshot_session_mismatch', step: 'screenshot' });
            expect(await execute({ actionId: 'devices.simulator.screenshot.capture', input, context: {} }))
                .toMatchObject({ ok: false, errorCode: 'simulator_screenshot_session_required', step: 'screenshot' });
            expect(nativeCaptures).toBe(1);
        } finally {
            await runtime.stop();
            await rm(cwd, { recursive: true, force: true });
        }
    });
});
