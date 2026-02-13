import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeaturesResponse } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    isRuntimeFeatureEnabled,
    resolveRuntimeFeatureDecision,
} from './featureDecisionInputs';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const initialStorageState = storage.getState();

function createFeaturesResponse(friendsEnabled: boolean): FeaturesResponse {
    return {
        features: {
            bugReports: {
                enabled: true,
                providerUrl: 'https://reports.happier.dev',
                defaultIncludeDiagnostics: true,
                maxArtifactBytes: 10 * 1024 * 1024,
                acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server', 'cli'],
                uploadTimeoutMs: 20_000,
                contextWindowMs: 30 * 60 * 1_000,
            },
            automations: {
                enabled: true,
                existingSessionTarget: false,
            },
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
            },
            voice: {
                enabled: false,
                configured: false,
                provider: null,
            },
            social: {
                friends: {
                    enabled: friendsEnabled,
                    allowUsername: false,
                    requiredIdentityProviderId: 'github',
                },
            },
            oauth: {
                providers: {
                    github: {
                        enabled: true,
                        configured: true,
                    },
                },
            },
            auth: {
                signup: { methods: [{ id: 'anonymous', enabled: true }] },
                login: { requiredProviders: [] },
                recovery: { providerReset: { enabled: false, providers: [] } },
                ui: {
                    autoRedirect: { enabled: false, providerId: null },
                    recoveryKeyReminder: { enabled: true },
                },
                providers: {
                    github: {
                        enabled: true,
                        configured: true,
                        restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                        offboarding: {
                            enabled: false,
                            intervalSeconds: 600,
                            mode: 'per-request-cache',
                            source: 'oauth_user_token',
                        },
                    },
                },
                misconfig: [],
            },
        },
    };
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

    it('returns a local-policy disabled decision when experiments are off', async () => {
        storage.getState().applySettingsLocal({
            experiments: false,
            expInboxFriends: false,
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => createFeaturesResponse(true),
            })) as unknown as typeof fetch,
        );

        const decision = await resolveRuntimeFeatureDecision({
            featureId: 'social.friends',
        });

        expect(decision.state).toBe('disabled');
        expect(decision.blockedBy).toBe('local_policy');
        expect(decision.blockerCode).toBe('flag_disabled');
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
});
