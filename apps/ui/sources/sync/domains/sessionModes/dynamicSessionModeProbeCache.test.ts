import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readDynamicSessionModeProbeCache,
    resetDynamicSessionModeProbeCacheForTests,
    writeDynamicSessionModeProbeCacheSuccess,
    writeDynamicSessionModeProbeCacheUnavailable,
} from './dynamicSessionModeProbeCache';

describe('dynamic session mode probe cache', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('lets explicit unavailable results override a previous successful mode list during cooldown', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicSessionModeProbeCacheForTests();

        writeDynamicSessionModeProbeCacheSuccess('key-1', {
            availableModes: [{ id: 'plan', name: 'Plan' }],
        }, 1_000);

        writeDynamicSessionModeProbeCacheUnavailable('key-1', {
            availableModes: [],
            unavailable: true,
        }, 2_000);

        expect(readDynamicSessionModeProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 2_000,
            expiresAt: 62_000,
            value: {
                availableModes: [],
                unavailable: true,
            },
        });
    });
});
