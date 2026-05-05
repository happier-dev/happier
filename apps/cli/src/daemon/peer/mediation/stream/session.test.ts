import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS, type MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';

import { createMachineLiveStreamSession } from './session';

const startRequest: MachineLiveStreamStartRequestV1 = {
    v: 1,
    streamId: 'stream_1',
    streamFamily: 'screen',
    routeKind: 'loopback_direct',
    sourceMachineId: 'machine_source',
    targetMachineId: 'machine_target',
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 12,
    maxFrameBytes: 32_000,
    maxDurationMs: 60_000,
    maxTotalBytes: 128_000,
};

describe('createMachineLiveStreamSession', () => {
    it('refuses to start before PMS route authorization succeeds', () => {
        expect(createMachineLiveStreamSession({
            startRequest,
            routeDecision: {
                kind: 'unavailable',
                reasonCode: 'grant_rejected',
                disabledReasons: ['grant_rejected'],
            },
            nowMs: () => 1_000,
        })).toEqual({
            ok: false,
            reasonCode: 'route_not_authorized',
        });
    });

    it('starts a live-stream session with a sanitized started receipt', () => {
        const result = createMachineLiveStreamSession({
            startRequest,
            routeDecision: {
                kind: 'selected',
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                disabledReasons: [],
            },
            routeAuthorization: {
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                streamId: 'stream_1',
                expiresAtMs: 61_000,
            },
            nowMs: () => 1_000,
        });

        expect(result).toMatchObject({
            ok: true,
            session: {
                streamId: 'stream_1',
                routeKind: 'loopback_direct',
                receipt: {
                    id: PEER_MEDIATION_RECEIPTS.streamStarted,
                    flowKind: 'live_stream',
                },
            },
        });
        expect(JSON.stringify(result)).not.toContain('grant');
        expect(JSON.stringify(result)).not.toContain('token');
    });

    it('refuses a start request when the selected route differs from the route authorization', () => {
        expect(createMachineLiveStreamSession({
            startRequest,
            routeDecision: {
                kind: 'selected',
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                disabledReasons: [],
            },
            routeAuthorization: {
                flowKind: 'live_stream',
                routeKind: 'server_relay',
                streamId: 'stream_1',
                expiresAtMs: 61_000,
            },
            nowMs: () => 1_000,
        })).toEqual({
            ok: false,
            reasonCode: 'route_not_authorized',
        });
    });
});
