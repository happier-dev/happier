import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readDynamicModelProbeCache,
    resetDynamicModelProbeCacheForTests,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheUnavailable,
} from './dynamicModelProbeCache';

describe('dynamic model probe cache', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps a previous successful model list visible during a transient unavailable cooldown', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicModelProbeCacheForTests();

        writeDynamicModelProbeCacheSuccess('key-1', {
            availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
            supportsFreeform: false,
        }, 1_000);

        writeDynamicModelProbeCacheUnavailable('key-1', 2_000);

        expect(readDynamicModelProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 1_000,
            expiresAt: 86_401_000,
            value: {
                availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
                supportsFreeform: false,
            },
            cacheable: true,
        });
    });

    it('shows unavailable during cooldown when no successful model list exists', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicModelProbeCacheForTests();

        writeDynamicModelProbeCacheUnavailable('key-1', 2_000);

        expect(readDynamicModelProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 2_000,
            expiresAt: 62_000,
            value: {
                availableModels: [],
                supportsFreeform: false,
                unavailable: true,
            },
            cacheable: false,
        });
    });

    it('honors a caller-owned shorter success max age without creating a second cache', () => {
        resetDynamicModelProbeCacheForTests();
        writeDynamicModelProbeCacheSuccess('selected-account', {
            availableModels: [{ id: 'claude-account-model', name: 'Account model' }],
            supportsFreeform: true,
        }, 1_000);

        expect(readDynamicModelProbeCache('selected-account', 5 * 60_000)).toMatchObject({
            kind: 'success', updatedAt: 1_000, expiresAt: 301_000,
        });
    });
});
