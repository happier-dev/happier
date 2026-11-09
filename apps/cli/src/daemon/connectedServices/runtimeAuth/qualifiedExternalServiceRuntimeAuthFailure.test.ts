import { describe, expect, it, vi } from 'vitest';

import {
    authorizeConnectedServiceRuntimeAuthFailureSource,
    handleConnectedServiceRuntimeAuthFailureForSession,
} from './handleConnectedServiceRuntimeAuthFailureForSession';
import { resolveConnectedServiceRuntimeAuthRecoverySelection } from './resolveConnectedServiceRuntimeAuthRecoverySelection';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './sanitizeConnectedServiceRuntimeFailureClassification';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

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
    quotaScope: 'account' as const,
    resetsAtMs: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error' as const,
} satisfies ConnectedServiceRuntimeFailureClassification;

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

    it.each([
        { deliveryMode: 'brokered' as const },
        {
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'acme.forge.gateway', localId: 'acme-gateway-account' },
                accountId: 'source-account-1',
            },
        },
    ])('does not reinterpret a Team $deliveryMode resource binding as personal Connected Account recovery authority', (teamBinding) => {
        expect(resolveConnectedServiceRuntimeAuthRecoverySelection({
            classification: {
                ...externalClassification,
                profileId: null,
                groupId: null,
            },
            trackedConnectedServices: {
                v: 2,
                bindingsByServiceId: {
                    [EXTERNAL_SERVICE_KEY]: {
                        source: 'team_resource',
                        resourceId: 'resource-1',
                        ...teamBinding,
                    },
                },
            },
        })).toEqual({ selection: null, source: null });
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

    it.each([
        [null, 'gateway-backup', 'reset-1', 80, 1_000, true],
        [null, 'gateway-primary', 'reset-1', 80, 1_000, false],
        ['no_receipt', 'gateway-primary', 'reset-1', 80, 1_000, true],
        ['not_available', 'gateway-primary', 'reset-1', 80, 1_000, true],
        ['unknown_after_timeout', 'gateway-primary', 'reset-1', 80, 1_000, false],
        ['consumed', 'gateway-primary', 'reset-1', 80, 1_000, true],
        ['consumed', 'gateway-primary', 'reset-2', 80, 1_000, true],
        ['already_consumed', 'gateway-primary', 'reset-1', 80, 1_000, true],
        ['nothing_to_reset', 'gateway-primary', 'reset-1', 80, 1_000, true],
        ['consumed', 'gateway-primary', 'reset-1', 0, 1_000, false],
        ['consumed', 'gateway-primary', 'reset-1', NaN, 1_000, false],
        ['consumed', 'gateway-primary', 'reset-1', 80, NaN, false],
    ] as const)('retains the exact qualified service continuation and usable reset identity (%s, %s, %s, %s, %s)', async (resetStatus, activeProfileId, resetKey, remainingPercent, capturedAtMs, shouldContinue) => {
        const generation = activeProfileId === 'gateway-backup' ? 4 : 3;
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
        const switchAfterClassifiedFailure = vi.fn(async (_input: Readonly<{
            serviceId: string;
            groupId: string;
        }>) => ({
            status: 'observed_generation' as const,
            serviceId: EXTERNAL_SERVICE_KEY,
            groupId: 'acme-gateway',
            activeProfileId,
            credentialRevision: activeProfileId === 'gateway-backup'
                ? 'csr_backup000000000000000001' : externalClassification.expectedCredentialRevision,
            generation,
            ...(resetStatus ? { quotaRecovery: {
                ...(resetStatus === 'no_receipt' ? {} : { receipt: { idempotencyKey: resetKey, status: resetStatus } }),
                quotaSnapshot: { effectiveRemainingPercent: remainingPercent, capturedAtMs },
            } } : {}),
            groupExhausted: false,
            retryAtMs: null,
            excluded: [],
        }));
        type ContinueAfterRuntimeAuthSwitch = NonNullable<
            Parameters<typeof handleConnectedServiceRuntimeAuthFailureForSession>[0]['continueAfterRuntimeAuthSwitch']
        >;
        const continueAfterRuntimeAuthSwitch = vi.fn<ContinueAfterRuntimeAuthSwitch>(
            async () => undefined,
        );
        const restartSession = vi.fn();

        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [tracked],
            switchCoordinator: { switchAfterClassifiedFailure } as never,
            emitSessionEvent: async () => undefined,
            restartSession,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_external_switch',
            switchesThisTurn: 0,
            classification: externalClassification,
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: EXTERNAL_SERVICE_KEY,
                groupId: 'acme-gateway',
                profileId: 'gateway-primary',
                generation: 3,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
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

        if (!shouldContinue) {
            expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
            return;
        }
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        const continuation = continueAfterRuntimeAuthSwitch.mock.calls[0]?.[0];
        expect(continuation).toMatchObject({
            sessionId: 'sess_external_switch',
            action: 'hot_applied',
            switchReason: 'automatic_runtime_failure',
        });
        expect(continuation.normalizedBindings).toEqual({
            v: 2,
            bindingsByServiceId: {
                [EXTERNAL_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'acme-gateway',
                },
            },
        });
        expect(continuation.attemptId).toBe(
            `connected-service-auth-switch|hot_applied|${EXTERNAL_SERVICE_KEY}:group:acme-gateway:${activeProfileId}:${generation}`
            + (resetStatus ? `|quota-recovery:${JSON.stringify(resetStatus === 'no_receipt' ? `quota-snapshot:${capturedAtMs}` : resetKey)}` : ''),
        );
    });
});
