import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readDynamicConfigOptionsProbeCache,
    resetDynamicConfigOptionsProbeCacheForTests,
    writeDynamicConfigOptionsProbeCacheSuccess,
    writeDynamicConfigOptionsProbeCacheUnavailable,
} from './dynamicConfigOptionsProbeCache';

describe('dynamic config options probe cache', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('lets explicit unavailable results override previous successful config options during cooldown', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicConfigOptionsProbeCacheForTests();

        writeDynamicConfigOptionsProbeCacheSuccess('key-1', [{
            id: 'sandbox',
            name: 'Sandbox',
            type: 'boolean',
            currentValue: 'true',
        }], 1_000);

        writeDynamicConfigOptionsProbeCacheUnavailable('key-1', 2_000);

        expect(readDynamicConfigOptionsProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 2_000,
            expiresAt: 62_000,
            value: [],
            unavailable: true,
        });
    });
});
