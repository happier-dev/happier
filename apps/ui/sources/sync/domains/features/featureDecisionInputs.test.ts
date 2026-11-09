import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { storage } from '@/sync/domains/state/storage';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    isRuntimeFeatureEnabled,
    resolveRuntimeFeatureDecision,
    resolveRuntimeFeatureDecisionOrThrow,
} from './featureDecisionInputs';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const initialStorageState = storage.getState();

function createFeaturesResponse(friendsEnabled: boolean): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            social: {
                friends: { enabled: friendsEnabled },
            },
        },
        capabilities: {},
    });
}

describe('featureDecisionInputs', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        resetServerFeaturesClientForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        resetServerFeaturesClientForTests();
    });

    it.each([undefined, false, true])('enables Friends with experiments off and retained preference %s', storedChoice => {
        storage.getState().applySettingsLocal({
            experiments: false,
            featureToggles: storedChoice === undefined ? {} : { 'social.friends': storedChoice },
        });

        primeServerFeaturesSnapshot({ serverId: 'server-1', snapshot: {
            status: 'ready', features: createFeaturesResponse(true),
        } });
        return expect(resolveRuntimeFeatureDecision({
            featureId: 'social.friends',
        })).resolves.toMatchObject({ state: 'enabled', blockedBy: null });
    });

    it.each([false, undefined, 'true'])('keeps Friends unavailable for server bit %s', async enabled => {
        storage.getState().applySettingsLocal({ experiments: false, featureToggles: {} });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            features: { social: { friends: enabled === undefined ? {} : { enabled } } }, capabilities: {},
        })) as unknown as typeof fetch);

        expect(await isRuntimeFeatureEnabled({ featureId: 'social.friends' })).toBe(false);
    });

    it('fails closed when /v1/features is missing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => ({}),
            })) as unknown as typeof fetch,
        );

        const enabled = await isRuntimeFeatureEnabled({
            featureId: 'social.friends',
        });

        expect(enabled).toBe(false);
    });

    it('evaluates an explicit spawn scope against its exact server snapshot', async () => {
        primeServerFeaturesSnapshot({
            serverId: 'server-1',
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { providers: { enabled: false } },
                    capabilities: {},
                }),
            },
        });
        primeServerFeaturesSnapshot({
            serverId: 'server-2',
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { providers: { enabled: true } },
                    capabilities: {},
                }),
            },
        });

        const decision = await resolveRuntimeFeatureDecision({
            featureId: 'providers',
            scope: {
                scopeKind: 'spawn',
                serverId: 'server-2',
            },
        });

        expect(decision).toMatchObject({
            featureId: 'providers',
            state: 'enabled',
            scope: {
                scopeKind: 'spawn',
                serverId: 'server-2',
            },
        });
    });

    it('preserves a transient probe failure as a retryable error for state-loading callers', async () => {
        storage.getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('network unavailable');
        }) as unknown as typeof fetch);

        await expect(resolveRuntimeFeatureDecisionOrThrow({
            featureId: 'social.friends',
        })).rejects.toMatchObject({
            name: 'RuntimeFeatureDecisionUnavailableError',
            retryable: true,
        });
    });
});
