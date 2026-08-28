import { describe, expect, it, vi } from 'vitest';

import {
    authorizeConnectedServiceRuntimeAuthFailureSource,
    handleConnectedServiceRuntimeAuthFailureForSession,
} from './handleConnectedServiceRuntimeAuthFailureForSession';
import { resolveConnectedServiceRuntimeAuthRecoverySelection } from './resolveConnectedServiceRuntimeAuthRecoverySelection';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { buildConnectedServiceSwitchContinuationAttemptId } from '../sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';

/**
 * Runtime-auth failure contract for a NOVEL EXTERNAL plugin service identified
 * only by its qualified Plugin contribution key (`{pluginId}/{localId}`).
 *
 * The failure, host recovery selection, retry/switch settlement, and the
 * session continuation must all carry the exact service key end to end, with
 * no Claude/Codex fallback and no closed legacy enum membership required.
 */
const EXTERNAL_SERVICE_KEY = 'acme.forge.gateway/acme-gateway-account';
const BUNDLED_LEGACY_SCALAR = 'openai-codex';
const BUNDLED_QUALIFIED_KEY = 'happier.agent.codex/openai-codex';

const externalClassification = {
    kind: 'usage_limit',
    serviceId: EXTERNAL_SERVICE_KEY,
    profileId: 'gateway-primary',
    groupId: 'acme-gateway',
    groupGeneration: 3,
    expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
    resetsAtMs: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error' as const,
};

describe('qualified external connected-service runtime-auth failure contract', () => {
    it('attributes a sanitized classification to the exact external qualified service key', () => {
        expect(sanitizeConnectedServiceRuntimeFailureClassification(externalClassification)).toMatchObject({
            kind: 'usage_limit',
            serviceId: EXTERNAL_SERVICE_KEY,
            groupId: 'acme-gateway',
        });
    });

    it('normalizes released bundled scalar keys to the canonical qualified key', () => {
        expect(sanitizeConnectedServiceRuntimeFailureClassification({
            ...externalClassification,
            serviceId: BUNDLED_LEGACY_SCALAR,
        })?.serviceId).toBe(BUNDLED_QUALIFIED_KEY);
    });

    it('rejects malformed and unknown scalar service keys with a typed invalid classification', () => {
        for (const serviceId of ['not a key', 'missing-separator', 'acme/UNKNOWN!']) {
            expect(sanitizeConnectedServiceRuntimeFailureClassification({
                ...externalClassification,
                serviceId,
            })).toBeNull();
        }
    });

    it('resolves the host recovery selection from the exact external qualified binding', () => {
        const resolved = resolveConnectedServiceRuntimeAuthRecoverySelection({
            classification: externalClassification,
            trackedConnectedServices: {
                v: 1,
                bindingsByServiceId: {
                    [EXTERNAL_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'acme-gateway',
                    },
                },
            },
        });

        expect(resolved).toMatchObject({
            source: 'tracked_spawn_options',
            selection: {
                kind: 'group',
                serviceId: EXTERNAL_SERVICE_KEY,
                groupId: 'acme-gateway',
            },
        });
    });

    it('authorizes the exact external failure source from the live runtime registry binding', async () => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 4242,
                happySessionId: 'sess_external_qualified',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_external_qualified',
            classification: externalClassification,
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: EXTERNAL_SERVICE_KEY,
                groupId: 'acme-gateway',
                profileId: 'gateway-primary',
                generation: 3,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                serviceId: EXTERNAL_SERVICE_KEY,
                groupId: 'acme-gateway',
                profileId: 'gateway-primary',
            },
        });
    });

    it('settles retry/switch through the canonical host owner and retains the exact service key in the continuation', async () => {
        const tracked = {
            startedBy: 'daemon' as const,
            pid: 4242,
            happySessionId: 'sess_external_switch',
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {},
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        [EXTERNAL_SERVICE_KEY]: {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'acme-gateway',
                        },
                    },
                },
            },
        };
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            serviceId: EXTERNAL_SERVICE_KEY,
            groupId: 'acme-gateway',
            activeProfileId: 'gateway-backup',
            credentialRevision: 'csr_backup000000000000000001',
            generation: 4,
            groupExhausted: false,
            retryAtMs: null,
            excluded: [],
        }));
        const continueAfterRuntimeAuthSwitch = vi.fn();
        const restartSession = vi.fn();

        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [tracked],
            switchCoordinator: { switchAfterClassifiedFailure } as never,
            switchAttemptTracker: new ConnectedServiceRuntimeAuthSwitchAttemptTracker(),
            emitSessionEvent: async () => undefined,
            restartSession,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_external_switch',
            switchesThisTurn: 0,
            classification: externalClassification,
        });

        expect(result.status).toBe('switch_attempted');
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure.mock.calls[0]?.[0]).toMatchObject({
            serviceId: EXTERNAL_SERVICE_KEY,
            groupId: 'acme-gateway',
        });
        // No Claude/Codex fallback: the switch is attributed only to the external key.
        expect(JSON.stringify(switchAfterClassifiedFailure.mock.calls)).not.toContain('claude-subscription');
        expect(JSON.stringify(switchAfterClassifiedFailure.mock.calls)).not.toContain('"openai-codex"');
        expect(JSON.stringify(switchAfterClassifiedFailure.mock.calls)).not.toContain('happier.agent.claude/');
        expect(JSON.stringify(switchAfterClassifiedFailure.mock.calls)).not.toContain('happier.agent.codex/');
        expect(restartSession).not.toHaveBeenCalled();

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        const continuation = continueAfterRuntimeAuthSwitch.mock.calls[0]?.[0];
        expect(continuation).toMatchObject({
            sessionId: 'sess_external_switch',
            action: 'hot_applied',
            switchReason: 'automatic_runtime_failure',
        });
        expect(continuation.normalizedBindings).toEqual({
            v: 1,
            bindingsByServiceId: {
                [EXTERNAL_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'acme-gateway',
                },
            },
        });
        expect(continuation.attemptId).toBe(buildConnectedServiceSwitchContinuationAttemptId({
            action: 'hot_applied',
            serviceIds: new Set([EXTERNAL_SERVICE_KEY]),
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    [EXTERNAL_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'acme-gateway',
                        profileId: 'gateway-backup',
                    },
                },
            },
            expectedGroupGenerationByServiceId: { [EXTERNAL_SERVICE_KEY]: 4 },
        }));
    });
});
