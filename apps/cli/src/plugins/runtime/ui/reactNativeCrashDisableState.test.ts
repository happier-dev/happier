import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createReactNativeCrashDisableContributionKey,
    createReactNativeCrashDisableStateStore,
    recordReactNativeCrashDisableReport,
    resolveReactNativeCrashDisabledContributionIdsForProjection,
} from './reactNativeCrashDisableState';

describe('React Native crash-disable daemon state', () => {
    it('persists disabled records and filters them by the current executable cache identity', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-rn-crash-disable-'));
        const contributionKey = createReactNativeCrashDisableContributionKey({
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
        });

        const store = createReactNativeCrashDisableStateStore({ happyHomeDir });
        await store.update((current) => ({
            ...current,
            records: {
                ...current.records,
                [contributionKey]: {
                    pluginId: 'runtime.plugin',
                    contributionId: 'native-compatible',
                    cacheKey: 'cache-v1',
                    artifactDigest: 'sha256:v1',
                    crashCount: 3,
                    startupFailureCount: 1,
                    disabled: true,
                    disabledReason: 'render_error_threshold',
                    updatedAtMs: 1000,
                    disabledAtMs: 1000,
                },
            },
        }));

        const reloadedState = await createReactNativeCrashDisableStateStore({ happyHomeDir }).read();
        expect(reloadedState.records[contributionKey]).toMatchObject({
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
            cacheKey: 'cache-v1',
            disabled: true,
        });

        expect(resolveReactNativeCrashDisabledContributionIdsForProjection({
            state: reloadedState,
            currentCacheKeysByContributionId: {
                [contributionKey]: {
                    cacheKey: 'cache-v1',
                    artifactDigest: 'sha256:v1',
                },
            },
        })).toEqual([contributionKey]);

        expect(resolveReactNativeCrashDisabledContributionIdsForProjection({
            state: reloadedState,
            currentCacheKeysByContributionId: {
                [contributionKey]: {
                    cacheKey: 'cache-v2',
                    artifactDigest: 'sha256:v2',
                },
            },
        })).toEqual([]);
    });

    it('records threshold reports idempotently and keeps the first disabled timestamp', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-rn-crash-disable-report-'));
        const store = createReactNativeCrashDisableStateStore({ happyHomeDir });

        await recordReactNativeCrashDisableReport({
            store,
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
            cacheKey: 'cache-v1',
            artifactDigest: 'sha256:v1',
            disabledReason: 'render_error_threshold',
            crashCount: 1,
            startupFailureCount: 0,
            observedAtMs: 1_000,
        });
        const updated = await recordReactNativeCrashDisableReport({
            store,
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
            cacheKey: 'cache-v1',
            artifactDigest: 'sha256:v1',
            disabledReason: 'startup_ack_timeout_threshold',
            crashCount: 1,
            startupFailureCount: 2,
            observedAtMs: 2_000,
        });

        const contributionKey = createReactNativeCrashDisableContributionKey({
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
        });

        expect(updated.records[contributionKey]).toMatchObject({
            pluginId: 'runtime.plugin',
            contributionId: 'native-compatible',
            cacheKey: 'cache-v1',
            artifactDigest: 'sha256:v1',
            disabled: true,
            disabledReason: 'startup_ack_timeout_threshold',
            crashCount: 1,
            startupFailureCount: 2,
            disabledAtMs: 1_000,
            updatedAtMs: 2_000,
        });
    });
});
