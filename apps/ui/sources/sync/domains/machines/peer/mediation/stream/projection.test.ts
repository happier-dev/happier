import { describe, expect, it } from 'vitest';

import { resolveMachineLiveStreamProjection } from './projection';

describe('resolveMachineLiveStreamProjection', () => {
    it('preserves last-known active stream state during background refresh', () => {
        const active = {
            status: 'streaming',
            streamId: 'stream_1',
            routeKind: 'loopback_direct',
            bytesReceived: 1024,
            framesReceived: 5,
        } as const;

        expect(resolveMachineLiveStreamProjection({
            availability: { status: 'refreshing' },
            activeStream: active,
        })).toEqual({
            status: 'streaming',
            streamId: 'stream_1',
            routeKind: 'loopback_direct',
            bytesReceived: 1024,
            framesReceived: 5,
            stale: true,
        });
    });

    it('shows capped and paused state without frame payload data', () => {
        const projection = resolveMachineLiveStreamProjection({
            availability: {
                status: 'disabled',
                reasonCode: 'cap_exceeded',
                disabledReasons: ['cap_exceeded'],
            },
            activeStream: {
                status: 'paused',
                streamId: 'stream_1',
                routeKind: 'server_relay',
                reasonCode: 'max_total_bytes_exceeded',
                bytesReceived: 8,
                framesReceived: 1,
            },
        });

        expect(projection).toEqual({
            status: 'paused',
            streamId: 'stream_1',
            routeKind: 'server_relay',
            reasonCode: 'max_total_bytes_exceeded',
            bytesReceived: 8,
            framesReceived: 1,
            stale: false,
        });
        expect(JSON.stringify(projection)).not.toContain('payload');
    });
});
