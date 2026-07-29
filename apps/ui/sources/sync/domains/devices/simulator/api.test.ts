import { describe, expect, it } from 'vitest';

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
});
