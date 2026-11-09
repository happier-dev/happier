import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readDynamicConfigOptionsProbeCache,
    resetDynamicConfigOptionsProbeCacheForTests,
    writeDynamicConfigOptionsProbeCacheSuccess,
    writeDynamicConfigOptionsProbeCacheUnavailable,
    writeDynamicConfigOptionsProbeCacheError,
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

    it('retains transient unknown metadata alongside the original successful observation age', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicConfigOptionsProbeCacheForTests();
        const options = [{ id: 'sandbox', name: 'Sandbox', type: 'boolean', currentValue: 'true' }];
        writeDynamicConfigOptionsProbeCacheSuccess('key-unknown', options, 1_000, ' native-choice ');
        writeDynamicConfigOptionsProbeCacheError('key-unknown', 2_000, {
            reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown',
        });
        expect(readDynamicConfigOptionsProbeCache('key-unknown')).toMatchObject({
            kind: 'success', updatedAt: 1_000, value: options,
            modelConfigOptionId: ' native-choice ',
            reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown',
        });
        writeDynamicConfigOptionsProbeCacheSuccess('key-unknown', options, 3_000);
        expect(readDynamicConfigOptionsProbeCache('key-unknown')).not.toHaveProperty('reason');
    });
});
