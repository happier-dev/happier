import { describe, expect, it } from 'vitest';
import { SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { SimulatorDeviceOperationResultV1, SimulatorDeviceOperationV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';

describe('simulator preview API boundary', () => {
    it('dispatches typed device, stream, lease, sideband, control, and snapshot actions', async () => {
        const mod = await import('./api').catch((error: unknown) => ({ importError: error }));
        const builders = await import('@happier-dev/protocol')
            .then((protocol) => protocol as unknown as Record<string, unknown>)
            .catch(() => null);

        expect(mod).toHaveProperty('createSimulatorPreviewApi');
        expect(builders?.createSimulatorPreviewOpenStreamEventV1).toBeTypeOf('function');
        if (!('createSimulatorPreviewApi' in mod)) return;
        const createOpenStreamEvent = builders?.createSimulatorPreviewOpenStreamEventV1;
        if (typeof createOpenStreamEvent !== 'function') return;

        const events: unknown[] = [];
        const api = mod.createSimulatorPreviewApi({
            executeDeviceOperationAction: async () => ({ ok: true }),
            dispatch: (event: unknown) => {
                events.push(event);
            },
            createEventId: (kind: string) => `${kind}_event`,
        });

        await api.listDevices();
        await api.openStream({ simulatorId: 'sim_1', sourceId: 'source_1' });
        await api.acquireLease({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
        });
        await api.renewLease({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            leaseId: 'lease_1',
            viewerId: 'viewer_1',
        });
        await api.requestSideband({ simulatorId: 'sim_1', kind: 'logs' });
        await api.sendControl({
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'keyframe_1',
                kind: 'request_keyframe',
            },
        });
        await api.requestSnapshot({ simulatorId: 'sim_1', streamId: 'stream_1', sourceId: 'source_1' });
        await api.closeStream({ simulatorId: 'sim_1', streamId: 'stream_1' });
        await api.releaseLease({ simulatorId: 'sim_1', streamId: 'stream_1', sourceId: 'source_1', leaseId: 'lease_1' });

        expect(events).toEqual([
            { type: 'simulator.devices.list' },
            createOpenStreamEvent({ simulatorId: 'sim_1', sourceId: 'source_1' }),
            {
                type: 'simulator.lease.acquire',
                simulatorId: 'sim_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                viewerId: 'viewer_1',
            },
            {
                type: 'simulator.lease.renew',
                simulatorId: 'sim_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                leaseId: 'lease_1',
                viewerId: 'viewer_1',
            },
            { type: 'simulator.sideband.request', simulatorId: 'sim_1', kind: 'logs' },
            {
                type: 'simulator.control.send',
                control: expect.objectContaining({ kind: 'request_keyframe' }),
            },
            {
                type: 'simulator.snapshot.request',
                simulatorId: 'sim_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'snapshot_event',
            },
            { type: 'simulator.stream.close', simulatorId: 'sim_1', streamId: 'stream_1' },
            {
                type: 'simulator.lease.release',
                simulatorId: 'sim_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                leaseId: 'lease_1',
            },
        ]);
    });
    it('addresses device operations to the Machine Action route and preserves screenshot media, Session context and native failures', async () => {
        const { createSimulatorPreviewApi } = await import('./api');
        const { createSimulatorPreviewRuntimeActionExecutor } = await import('./actions/runtimeActionExecutor');
        const requests: RuntimeActionExecuteArgs[] = [];
        const media: SimulatorDeviceOperationResultV1 = {
            ok: true,
            media: { mediaId: 'image_1', mediaKind: 'image', width: 100, height: 200, sizeBytes: 250 },
        };
        const refusal: SimulatorDeviceOperationResultV1 = {
            ok: false, errorCode: 'simulator_device_unavailable', step: 'boot',
        };
        // The captured Machine transport is the network boundary; retain the real Action router.
        const execute = createSimulatorPreviewRuntimeActionExecutor({
            resolveMachineId: () => 'session_machine',
            executeOnMachine: async (request) => {
                requests.push(request);
                return request.actionId === SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1.screenshot ? media : refusal;
            },
        });
        const context = {
            serverId: 'selected_home', expectedAccountId: 'selected_account',
            externalActionTarget: { kind: 'machine' as const, machineId: 'selected_machine' },
            signal: new AbortController().signal,
        };
        const api = createSimulatorPreviewApi({
            dispatch: () => { throw new Error('Device operations must use the Machine Action route'); },
            executeDeviceOperationAction: async (actionId, operation) => execute({ actionId, input: operation, context: {
                ...context,
                ...(operation.operation === 'screenshot' ? { defaultSessionId: operation.sessionId } : {}),
            } }) as Promise<SimulatorDeviceOperationResultV1>,
        });
        const screenshot: SimulatorDeviceOperationV1 = {
            operation: 'screenshot', platform: 'android', deviceId: 'emulator-5554', sessionId: 'session_1',
        };
        const boot: SimulatorDeviceOperationV1 = { operation: 'boot', platform: 'ios', deviceId: 'stopped_device' };

        await expect(api.executeDeviceOperation(screenshot)).resolves.toEqual(media);
        await expect(api.executeDeviceOperation(boot)).resolves.toEqual(refusal);
        expect(requests).toEqual([
            { actionId: SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1.screenshot, input: screenshot, context: { ...context, defaultSessionId: 'session_1' } },
            { actionId: SIMULATOR_DEVICE_OPERATION_ACTION_IDS_V1.boot, input: boot, context },
        ]);
    });
});
