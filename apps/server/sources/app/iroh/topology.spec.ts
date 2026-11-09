import { describe, expect, it } from 'vitest';

import { readHomeIrohTopologyFailure } from './topology';

describe('Home Iroh process placement', () => {
    it.each([
        { HAPPIER_SOCKET_ADAPTER: 'redis-streams' },
        { HAPPIER_SOCKET_REDIS_ADAPTER: '1' },
    ])('admits the explicitly declared holder with $HAPPIER_SOCKET_ADAPTER$HAPPIER_SOCKET_REDIS_ADAPTER', adapter => {
        expect(readHomeIrohTopologyFailure({ ...adapter, HAPPIER_HOME_IROH_HOLDER: '1' })).toBeNull();
    });

    it.each([undefined, '0', 'invalid'])('keeps redis-streams HTTPS-only without a valid holder declaration (%s)', holder => {
        expect(readHomeIrohTopologyFailure({
            HAPPIER_SOCKET_ADAPTER: 'redis-streams', HAPPIER_HOME_IROH_HOLDER: holder,
        })).toBe('iroh_multi_instance_unsupported');
    });

    it.each([{}, { HAPPIER_SOCKET_ADAPTER: 'memory' }])('preserves single-process defaults for %o', env => {
        expect(readHomeIrohTopologyFailure(env)).toBeNull();
    });
});
