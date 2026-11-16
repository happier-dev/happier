import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createSimulatorPreviewDaemonRuntime } from '../runtime';
import { createSimulatorDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createSimulatorDeviceOperationRoutes } from '../operations/routes';
import { createSimulatorDeviceOperations } from '../operations/deviceOperations';

const nativeSnapshot = { ok: true, protocolVersion: 1, appBundleId: 'dev.fixture',
    viewport: { width: 393, height: 852 }, truncated: false,
    tree: { XC_kAXXCAttributeElementType: 'UIApplication', XC_kAXXCAttributeChildren: [
        { XC_kAXXCAttributeElementType: 'UIButton', XC_kAXXCAttributeIdentifier: 'increment',
            XC_kAXXCAttributeFrame: { X: 20, Y: 300, Width: 350, Height: 100 }, XC_kAXXCAttributeChildren: [] },
    ] } };

describe('simulator accessibility Action integration', () => {
    it('returns the actual native tree through the existing Action route and fails closed on Android', async () => {
        const runtime = createSimulatorPreviewDaemonRuntime({ machineId: 'machine' });
        const operations = createSimulatorDeviceOperations({ platform: 'darwin', accessibility: {
            run: async ({ args }) => ({ exitCode: 0, stdout: Buffer.from(args[0] === 'simctl' ? JSON.stringify(nativeSnapshot) : ''), stderr: '' }),
        } });
        const routes = createSimulatorDeviceOperationRoutes({ previewRoutes: runtime.routes, operations,
            mediaWriter: { write: async () => ({ ok: false, reason: 'capture_failed' }) } });
        const execute = createSimulatorDaemonRuntimeActionExecutor({ routes,
            featureGate: { isEnabled: () => true, refresh: async () => {} } });
        try {
            expect(await execute({ actionId: 'devices.simulator.accessibility.snapshot',
                input: { operation: 'accessibility_snapshot', platform: 'ios', deviceId: 'owned' }, context: {} }))
                .toMatchObject({ ok: true, snapshot: { nodes: [
                    { index: 0, type: 'UIApplication' }, { index: 1, parentIndex: 0, identifier: 'increment' },
                ], truncated: false } });
            expect(await execute({ actionId: 'devices.simulator.accessibility.snapshot',
                input: { operation: 'accessibility_snapshot', platform: 'android', deviceId: 'owned' }, context: {} }))
                .toMatchObject({ ok: false, errorCode: 'simulator_accessibility_unavailable' });
        } finally { await runtime.stop(); }
    });
});
