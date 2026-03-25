import { describe, expect, it } from 'vitest';

import {
    resolveSocketFastDisconnectLogThresholdMsFromEnv,
    resolveSocketMaxHttpBufferSizeFromEnv,
    DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS,
    DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE,
} from './socket';

describe('resolveSocketMaxHttpBufferSizeFromEnv', () => {
    it('defaults to a buffer size large enough for SCM commit diffs', () => {
        expect(resolveSocketMaxHttpBufferSizeFromEnv({})).toBe(DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE);
        expect(DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE).toBeGreaterThanOrEqual(2_000_000);
    });

    it('reads an explicit size from env', () => {
        expect(resolveSocketMaxHttpBufferSizeFromEnv({ HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: '5000000' })).toBe(5_000_000);
        expect(resolveSocketMaxHttpBufferSizeFromEnv({ HAPPY_SOCKET_MAX_HTTP_BUFFER_SIZE: '6000000' })).toBe(6_000_000);
    });

    it('falls back to the default on invalid values', () => {
        expect(resolveSocketMaxHttpBufferSizeFromEnv({ HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'nope' })).toBe(
            DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE,
        );
        expect(resolveSocketMaxHttpBufferSizeFromEnv({ HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: '-1' })).toBe(
            DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE,
        );
    });
});

describe('resolveSocketFastDisconnectLogThresholdMsFromEnv', () => {
    it('defaults to a conservative threshold', () => {
        expect(resolveSocketFastDisconnectLogThresholdMsFromEnv({})).toBe(DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS);
        expect(DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS).toBeGreaterThanOrEqual(100);
    });

    it('reads an explicit threshold from env', () => {
        expect(resolveSocketFastDisconnectLogThresholdMsFromEnv({ HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '250' }))
            .toBe(250);
        expect(resolveSocketFastDisconnectLogThresholdMsFromEnv({ HAPPY_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '500' }))
            .toBe(500);
        expect(resolveSocketFastDisconnectLogThresholdMsFromEnv({ HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '0' }))
            .toBe(0);
    });

    it('falls back to the default on invalid values', () => {
        expect(resolveSocketFastDisconnectLogThresholdMsFromEnv({ HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'nope' }))
            .toBe(DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS);
        expect(resolveSocketFastDisconnectLogThresholdMsFromEnv({ HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '-1' }))
            .toBe(DEFAULT_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS);
    });
});
