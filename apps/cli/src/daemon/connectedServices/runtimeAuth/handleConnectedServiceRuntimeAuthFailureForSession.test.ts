import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import {
    authorizeConnectedServiceRuntimeAuthFailureSource,
    handleConnectedServiceRuntimeAuthFailureForSession,
} from './handleConnectedServiceRuntimeAuthFailureForSession';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '@/agent/catalog/types';
import type { RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';

describe('handleConnectedServiceRuntimeAuthFailureForSession', () => {
    it('authorizes a provider-qualified shared-auth failure from the live group member instead of stale launch metadata', async () => {
        const tracked = {
            startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_provider_qualified_shared_auth',
            spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
        };
        const resolveProviderQualifiedRuntimeAuthFailureSource = vi.fn(async ({ classification }) => ({
            ...classification,
            profileId: 'live-profile',
            groupGeneration: null,
            expectedCredentialRevision: null,
        }));

        await expect(authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            runtimeAuthApplyCapability: runtimeAuthCapability(false),
            classification: {
                kind: 'usage_limit',
                serviceId: 'claude-subscription',
                profileId: 'launch-profile',
                groupId: 'claude',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                sourceProviderAccountId: 'acct-live',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            resolveProviderQualifiedRuntimeAuthFailureSource,
        })).resolves.toMatchObject({
            status: 'authorized',
            sourceBinding: {
                serviceId: 'claude-subscription',
                groupId: 'claude',
                profileId: 'live-profile',
                generation: null,
                credentialRevision: null,
            },
        });
        expect(resolveProviderQualifiedRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    const runtimeAuthCapability = (requiresExactRuntimeIdentity: boolean): ConnectedServiceRuntimeAuthApplyCapability => ({
        directLiveHotAuth: {
            supportsInTurnApply: true,
            requiresExactRuntimeIdentity,
            refreshSelectionResync: 'not_applicable',
            authMode: { kind: 'managed_provider_session' },
        },
    });

    it.each([
        ['openai-codex', false, 'authorized'],
        ['claude-subscription', true, 'recovery_superseded'],
    ] as const)('uses the typed provider capability, not service id, for %s source authorization', async (
        serviceId,
        requiresExactRuntimeIdentity,
        expectedStatus,
    ) => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_capability',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_capability',
            runtimeAuthApplyCapability: runtimeAuthCapability(requiresExactRuntimeIdentity),
            classification: {
                kind: 'usage_limit',
                serviceId,
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
        });

        expect(result.status).toBe(expectedStatus);
    });

    it('authorizes an exact quota report from a reattached live runtime when spawn selections are absent', async () => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_reattached_exact_runtime',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_reattached_exact_runtime',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
        });

        expect(result).toMatchObject({ status: 'authorized' });
    });

    it('authorizes a hot-applied tracked quota report from the registered exact binding when the auxiliary probe is unavailable', async () => {
        const tracked = {
            startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_hot_applied_exact_runtime',
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'main',
                        activeProfileId: 'spawn-profile',
                        fallbackProfileId: 'spawn-profile',
                        generation: 7,
                        policy: null,
                        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                    }]),
                },
            },
        };
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'live-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw' as const,
        }));
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => {
            throw new Error('auxiliary runtime probe unavailable');
        });

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'live-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource,
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'live-profile',
                generation: 8,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            },
        });
        expect(resolveRegisteredRuntimeAuthFailureSource).toHaveBeenCalledOnce();
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('terminally supersedes a modern report that mismatches the registered exact binding', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'registered-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }));
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_registered_mismatch',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_registered_mismatch',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'reported-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'registered-profile',
                generation: 8,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
        });
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('terminally supersedes report A when exact current B disproves a matching stale registry A', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'current-profile',
            generation: 7,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_exact_current_disproves_registry',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_exact_current_disproves_registry',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'reported-profile',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'reported-profile',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
        });
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('keeps the settled binding authoritative when a newer attempted generation was not acknowledged', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'live-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_stale_bootstrap',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_stale_bootstrap',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'live-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'bootstrap-profile',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                profileId: 'bootstrap-profile',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
        });
        expect(resolveCurrentRuntimeAuthFailureSource).not.toHaveBeenCalled();
    });

    it('propagates unavailable registered runtime truth so the existing report outbox retains custody', async () => {
        await expect(authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_registry_unavailable',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_registry_unavailable',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'auth_expired',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => null,
            resolveCurrentRuntimeAuthFailureSource: vi.fn(),
        })).rejects.toThrow('registered runtime binding unavailable');
    });

    it('authorizes a complete hot-applied credential failure from the exact live binding', async () => {
        const tracked = {
            startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_hot_applied_auth_expired',
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'main',
                        activeProfileId: 'spawn-profile',
                        fallbackProfileId: 'spawn-profile',
                        generation: 7,
                        policy: null,
                        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                    }]),
                },
            },
        };
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'live-profile',
            generation: 8,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw' as const,
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [tracked],
            sessionId: tracked.happySessionId,
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'auth_expired',
                serviceId: 'openai-codex',
                profileId: 'live-profile',
                groupId: 'main',
                groupGeneration: 8,
                expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            resolveRegisteredRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                profileId: 'live-profile',
                generation: 8,
                credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
            },
        });
        expect(resolveRegisteredRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('keeps an actionful exact-identity credential failure passive without current-source authorization', async () => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_reattached_auth_expired',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_reattached_auth_expired',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'auth_expired',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: null,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_unavailable',
        });
    });

    it('authorizes a predecessor quota report without a revision when the live resolver proves the exact current tuple', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_reattached_predecessor',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_reattached_predecessor',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: null,
                sourceProviderAccountId: 'acct_primary',
                failingAccessTokenFingerprint: 'sha256:deadbeef',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource,
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({ status: 'authorized' });
        expect(resolveCurrentRuntimeAuthFailureSource).toHaveBeenCalledOnce();
    });

    it('adopts the current generation for a predecessor report after exact same-identity proof', async () => {
        const resolveCurrentRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 8,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));

        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_predecessor_generation',
                reattachedFromDiskMarker: true,
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_predecessor_generation',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: null,
                sourceProviderAccountId: 'acct_primary',
                failingAccessTokenFingerprint: 'sha256:deadbeef',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 8,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            resolveCurrentRuntimeAuthFailureSource,
        });

        expect(result).toMatchObject({
            status: 'authorized',
            sourceBinding: {
                generation: 8,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
        });
    });

    it('uses the exact live binding throughout scheduler recovery instead of falling back to stale launch metadata', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 7,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const resolveRegisteredRuntimeAuthFailureSource = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            groupId: 'main',
            profileId: 'primary',
            generation: 7,
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }));

        await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_scheduler_reattached_predecessor',
                reattachedFromDiskMarker: true,
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'main',
                            activeProfileId: 'stale-predecessor',
                            fallbackProfileId: 'primary',
                            generation: 6,
                            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
                        }]),
                    },
                },
            }],
            resolveRegisteredRuntimeAuthFailureSource,
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_scheduler_reattached_predecessor',
            switchesThisTurn: 0,
            recoveryInvocationSource: 'scheduler_retry',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                sourceProviderAccountId: 'acct_primary',
                failingAccessTokenFingerprint: 'sha256:deadbeef',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
        });

        expect(resolveRegisteredRuntimeAuthFailureSource).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'openai-codex',
            groupId: 'main',
            observedProfileId: 'primary',
        }));
    });

    it.each([
        ['the same profile and opaque revision', {
            profileId: 'primary',
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }, 'authorized'],
        ['a different profile', {
            profileId: 'backup',
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }, 'recovery_superseded'],
        ['a different opaque revision', {
            profileId: 'primary',
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
        }, 'recovery_superseded'],
    ] as const)('classifies an older-generation exact report against a newer registered binding with %s', async (
        _label,
        registeredTarget,
        expectedStatus,
    ) => {
        const result = await authorizeConnectedServiceRuntimeAuthFailureSource({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_newer_registered_generation',
                spawnOptions: { directory: '/tmp/project', environmentVariables: {} },
            }],
            sessionId: 'sess_newer_registered_generation',
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 6,
                expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'quota_recovery_required' },
            },
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                generation: 7,
                ...registeredTarget,
            }),
        });

        if (expectedStatus === 'authorized') {
            expect(result).toMatchObject({
                status: 'authorized',
                sourceBinding: {
                    serviceId: 'openai-codex',
                    groupId: 'main',
                    profileId: 'primary',
                    generation: 7,
                    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                },
            });
            return;
        }
        expect(result).toMatchObject({
            status: 'recovery_superseded',
            reason: 'source_tuple_mismatch',
        });
    });

    it.each([
        ['missing revision', { expectedCredentialRevision: undefined }],
        ['revision mismatch', { expectedCredentialRevision: 'csr_bcdefghijklmnopqrstuvw' }],
        ['profile mismatch', { expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv', profileId: 'other' }],
        ['group mismatch', { expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv', groupId: 'other' }],
    ] as const)('passively supersedes Codex quota recovery when the source tuple has %s', async (_label, overrides) => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 7,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn();
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_exact_tuple',
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'main',
                            activeProfileId: 'primary',
                            fallbackProfileId: 'primary',
                            generation: 7,
                            policy: null,
                            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                        }]),
                    },
                },
            }],
            resolveRegisteredRuntimeAuthFailureSource: async () => ({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'primary',
                generation: 7,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }),
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_exact_tuple',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                groupGeneration: 7,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
                recoveryAction: { kind: 'quota_recovery_required' as const },
                ...overrides,
            },
            runtimeAuthApplyCapability: runtimeAuthCapability(true),
        });

        expect(result).toMatchObject({ status: 'recovery_superseded' });
        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });
    it('force-refreshes the active group profile after auth-expired and replays the turn awaiting provider proof', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 1,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshDiagnostic = {
            serviceId: 'claude-subscription' as const,
            profileId: 'primary',
            reason: 'runtime_auth_failure' as const,
            status: 'refreshed' as const,
            expiresAt: null,
            expiryAgeMs: null,
            refreshWindowMs: 0,
        };
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            diagnostic: refreshDiagnostic,
        }));
        const continueAfterRuntimeAuthSwitch = vi.fn(async (_input: { serviceIds: ReadonlySet<string> }) => {});
        const trackedSession = {
            startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_claude_group',
            spawnOptions: {
                directory: '/tmp/project',
                connectedServices: {
                    v: 1 as const,
                    bindingsByServiceId: {
                        'claude-subscription': {
                            source: 'connected' as const,
                            selection: 'group' as const,
                            groupId: 'claude',
                            profileId: 'primary',
                        },
                    },
                },
            },
        };
        const input = {
            getChildren: () => [trackedSession],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_claude_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toEqual({
            status: 'credential_refreshed',
            serviceId: 'claude-subscription',
            profileId: 'primary',
            groupId: 'claude',
            refresh: {
                status: 'refreshed',
                credential: null,
                diagnostic: refreshDiagnostic,
            },
            restartRequested: false,
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
            serviceId: 'claude-subscription',
            profileId: 'primary',
            sessionId: 'sess_claude_group',
        });
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            tracked: trackedSession,
            sessionId: 'sess_claude_group',
            attemptId: 'connected-service-auth-switch|hot_applied|claude-subscription:group:claude:primary:',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'claude',
                    },
                },
            },
            action: 'hot_applied',
            switchReason: 'automatic_runtime_failure',
        }));
        const continuationCall = continueAfterRuntimeAuthSwitch.mock.calls[0]?.[0];
        expect(continuationCall).toBeDefined();
        expect([...continuationCall!.serviceIds]).toEqual(['claude-subscription']);
    });

    it('switches to another group member when the active credential cannot be refreshed', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'hot_apply' as const,
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refresh_failed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'openai-codex' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refresh_failed' as const,
                category: 'provider_401' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_codex_group',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'main',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_codex_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'switched',
                activeProfileId: 'backup',
                generation: 2,
                mode: 'hot_apply',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    });

    it('adopts current group truth when the refreshed failing member was already superseded', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            runtimeAuthDisposition: 'superseded_by_current_group' as const,
            diagnostic: {
                serviceId: 'claude-subscription' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refreshed' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));
        const continueAfterRuntimeAuthSwitch = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_claude_group',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'claude-subscription': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_claude_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'observed_generation',
                activeProfileId: 'backup',
                generation: 2,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_claude_group',
            action: 'hot_applied',
            attemptId: 'connected-service-auth-switch|hot_applied|claude-subscription:group:claude:backup:2',
        }));
    });

    it('requires reconnect when an expired credential cannot refresh and the group has no replacement', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 1,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refresh_failed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'openai-codex' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refresh_failed' as const,
                category: 'provider_401' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_codex_exhausted',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'main',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_codex_exhausted',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'reconnect_profile',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'main',
                reason: 'auth_expired',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    });

    it.each([
        ['resumed_awaiting_proof', 'auth_expired'],
        ['checking', 'recovery_unproven_awaiting_provider_outcome'],
    ] as const)(
        'refreshes the exact active binding even while stale provider-proof metadata is pending (%s)',
        async (status, lastError) => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'no_eligible_member' as const,
            generation: 1,
            groupExhausted: true as const,
            retryAtMs: null,
            excluded: [],
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'claude-subscription' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refreshed' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));
        const pendingIntent: RuntimeAuthRecoveryIntent = {
            v: 1,
            sessionId: 'sess_claude_group',
            serviceId: 'claude-subscription',
            profileId: 'primary',
            groupId: 'claude',
            status,
            armedAtMs: 1_000,
            nextRetryAtMs: 6_000,
            attemptCount: 1,
            maxAttempts: 5,
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired',
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            failurePhase: 'handler',
            failureReason: 'classified_failure_reported',
            lastError,
            lastErrorClassification: { kind: 'auth_failed', retryable: true },
            pendingTargetProfileId: 'primary',
            pendingTargetGeneration: null,
            terminalAtMs: null,
            terminalReason: null,
        };
        const input = {
            getChildren: () => [{
                startedBy: 'daemon' as const,
                pid: 111,
                happySessionId: 'sess_claude_group',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1 as const,
                        bindingsByServiceId: {
                            'claude-subscription': {
                                source: 'connected' as const,
                                selection: 'group' as const,
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            runtimeAuthRecovery: {
                readForSession: () => [pendingIntent],
            },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_claude_group',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired' as const,
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toMatchObject({
            status: 'credential_refreshed',
            serviceId: 'claude-subscription',
            profileId: 'primary',
            groupId: 'claude',
            restartRequested: false,
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('routes account-changed group failures to profile reconnect without refreshing or switching the pool', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'hot_apply' as const,
        }));
        const refreshConnectedServiceCredentialForRuntimeAuthFailure = vi.fn(async () => ({
            status: 'refreshed' as const,
            credential: null,
            diagnostic: {
                serviceId: 'claude-subscription' as const,
                profileId: 'primary',
                reason: 'runtime_auth_failure' as const,
                status: 'refreshed' as const,
                expiresAt: null,
                expiryAgeMs: null,
                refreshWindowMs: 0,
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_changed_account',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'claude-subscription': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            refreshConnectedServiceCredentialForRuntimeAuthFailure,
            sessionId: 'sess_changed_account',
            switchesThisTurn: 0,
            classification: {
                kind: 'account_changed',
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'reconnect_profile',
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                reason: 'account_changed',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('surfaces a failed tracked runtime group apply as a switch-attempt transcript event', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'generation_apply_failed' as const,
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'hot_apply_restart_required',
        }));
        const emitSessionEvent = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'generation_apply_failed',
                activeProfileId: 'backup',
                generation: 2,
                errorCode: 'hot_apply_restart_required',
            },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            retryAfterMs: 30_000,
            resetsAtMs: null,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            providerLimitId: 'weekly',
            action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
            planType: null,
            switchesThisTurn: 0,
        }));
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', {
            type: 'connected_service_account_switch_attempt',
            ok: false,
            action: 'hot_applied',
            reason: 'usage_limit',
            attemptedContinuityMode: 'hot_apply',
            outcome: 'failed',
            outcomeAction: 'none',
            errorCode: 'hot_apply_restart_required',
            groupGeneration: 2,
            partialState: null,
        });
    });

    it('resolves canonical group context without replacing the provider-reported failed profile', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup-2',
            generation: 3,
            mode: 'hot_apply' as const,
        }));
        const emitSessionEvent = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'active-now',
                            fallbackProfileId: 'primary',
                            generation: 2,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup-2', generation: 3, mode: 'hot_apply' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            observedProfileId: 'primary',
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('uses the tracked auth group to rotate after a provider-state-sharing usage-limit hint', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                recoveryAction: { kind: 'provider_state_sharing_required' },
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            switchesThisTurn: 0,
        }));
    });

    it('requests a session restart when runtime recovery switches a group account for the next turn', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'spawn_next_turn' as const,
        }));
        const restartSession = vi.fn(async () => {});
        const trackedSession = {
            startedBy: 'daemon' as const,
            pid: 111,
            happySessionId: 'sess_1',
            spawnOptions: {
                directory: '/tmp/project',
                connectedServices: {
                    v: 1 as const,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected' as const,
                            selection: 'group' as const,
                            groupId: 'group-1',
                            profileId: 'primary',
                        },
                    },
                },
            },
        };
        const input = {
            getChildren: () => [trackedSession],
            switchCoordinator: { switchAfterClassifiedFailure },
            restartSession,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            } satisfies ConnectedServiceRuntimeFailureClassification,
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'switched',
                activeProfileId: 'backup',
                generation: 2,
                mode: 'spawn_next_turn',
            },
        });

        expect(restartSession).toHaveBeenCalledWith(trackedSession);
    });

    it('does not restart or re-continue a live session when the failing profile is not the profile it runs on', async () => {
        // Incident 2026-06-12 (cmq8y3nlx): a stale recovery intent for a profile the session
        // was NO LONGER running restarted the healthy mid-work session on every replay. The
        // committed switch (group bookkeeping) is preserved, but the live session must keep
        // running — the new profile applies on the next natural spawn.
        const restartSession = vi.fn(async () => {});
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 8,
            mode: 'spawn_next_turn' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'current',
                            fallbackProfileId: 'current',
                            generation: 7,
                            policy: null,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            restartSession,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'openai-codex',
                profileId: 'stale_member',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
        expect(restartSession).not.toHaveBeenCalled();
        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    });

    it('supersedes a scheduler replay whose failing profile is not the profile the live session runs on', async () => {
        // Incident 2026-06-12 (cmq8y3nlx): a persisted recovery intent for a profile the
        // session was NO LONGER running kept replaying through the scheduler. Even with the
        // live restart suppressed, each replay re-ran the full switch pipeline — burning the
        // per-session switch budget and thrashing the shared group generation. A scheduler
        // replay for an inactive profile must be superseded WITHOUT running the switch
        // pipeline at all: the group already moved off the failing profile.
        const restartSession = vi.fn(async () => {});
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const emitSessionEvent = vi.fn();
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 8,
            mode: 'spawn_next_turn' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'current',
                            fallbackProfileId: 'current',
                            generation: 7,
                            policy: null,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            restartSession,
            continueAfterRuntimeAuthSwitch,
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            recoveryInvocationSource: 'scheduler_retry',
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'openai-codex',
                profileId: 'stale_member',
                groupId: 'group-1',
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toMatchObject({
            status: 'recovery_superseded',
            reason: 'failing_profile_inactive',
            failingProfileId: 'stale_member',
            activeProfileId: 'current',
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
        expect(restartSession).not.toHaveBeenCalled();
        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('still runs the switch pipeline for a scheduler replay when the failing profile IS the live profile', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 8,
            mode: 'spawn_next_turn' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'current',
                            fallbackProfileId: 'current',
                            generation: 7,
                            policy: null,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            recoveryInvocationSource: 'scheduler_retry',
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'openai-codex',
                profileId: 'current',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledOnce();
    });

    it('still restarts the live session when the failing profile IS the profile it runs on', async () => {
        const restartSession = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 8,
            mode: 'spawn_next_turn' as const,
        }));
        const trackedSession = {
            startedBy: 'daemon' as const,
            happySessionId: 'sess_1',
            pid: 123,
            spawnOptions: {
                directory: '/tmp/project',
                environmentVariables: {
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'group-1',
                        activeProfileId: 'current',
                        fallbackProfileId: 'current',
                        generation: 7,
                        policy: null,
                    }]),
                },
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [trackedSession],
            switchCoordinator: { switchAfterClassifiedFailure },
            restartSession,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit' as const,
                serviceId: 'openai-codex',
                profileId: 'current',
                groupId: 'group-1',
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup' },
        });

        expect(restartSession).toHaveBeenCalledWith(trackedSession);
    });

  it('bounds retries per failing member edge while retaining the session-hour switch count', async () => {
        const switchAfterClassifiedFailure = vi.fn(async ({ switchesThisTurn }: { switchesThisTurn?: number }) => (
            switchesThisTurn === 0
                ? {
                    status: 'switched' as const,
                    activeProfileId: 'backup',
                    generation: 2,
                }
                : {
                    status: 'switch_limit_reached' as const,
                    generation: 2,
                }
        ));
        const switchAttemptTracker = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
            nowMs: () => 1_000,
            windowMs: 60_000,
        });

        const first = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            switchAttemptTracker,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });
        expect(switchAttemptTracker.resolveSwitchesThisTurn({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            profileId: 'primary',
            credentialRevision: null,
            reportedSwitchesThisTurn: 0,
        })).toBe(1);

        const repeatedPrimary = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            switchAttemptTracker,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const secondMember = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            switchAttemptTracker,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'backup',
                groupId: null,
                resetsAtMs: null,
                quotaScope: 'account',
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        expect(first).toMatchObject({ status: 'switch_attempted' });
        expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(2, expect.objectContaining({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            switchesThisTurn: 1,
            sessionSwitchesThisHour: 1,
        }));
        expect(repeatedPrimary).toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switch_limit_reached' },
        });
        expect(secondMember).toMatchObject({
            status: 'switch_attempted',
            result: { status: 'switched' },
        });
        expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(3, expect.objectContaining({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            switchesThisTurn: 0,
            sessionSwitchesThisHour: 1,
        }));
    });

    it('prefers the canonical active group selection from tracked child env over the spawn fallback profile', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'secondary',
            generation: 3,
        }));
        const emitSessionEvent = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            gemini: {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'gemini',
                            groupId: 'group-1',
                            activeProfileId: 'backup',
                            fallbackProfileId: 'primary',
                            generation: 2,
                            policy: null,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                serviceId: 'gemini',
                profileId: null,
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 45_000,
                limitCategory: 'usage_limit',
                quotaScope: 'account',
                providerLimitId: 'daily',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'secondary', generation: 3 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'gemini',
            groupId: 'group-1',
            observedProfileId: 'backup',
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('uses inactive session bindings when the tracked child has already exited', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));
        const resolveInactiveSession = vi.fn(async () => ({
            connectedServices: {
                v: 1 as const,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected' as const,
                        selection: 'group' as const,
                        groupId: 'group-1',
                        profileId: 'fallback',
                    },
                },
            },
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [],
            resolveInactiveSession,
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(resolveInactiveSession).toHaveBeenCalledWith({ sessionId: 'sess_1' });
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            observedProfileId: 'primary',
            reason: 'usage_limit',
        }));
    });

    it('uses durable tracked session metadata bindings when active spawn options lost connected services', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                happySessionMetadataFromLocalWebhook: {
                    path: '/tmp/project',
                    homeDir: '/tmp/home',
                    happyHomeDir: '/tmp/home/.happier',
                    happyLibDir: '/tmp/home/.happier/lib',
                    happyToolsDir: '/tmp/home/.happier/tools',
                    host: 'test-host',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
                spawnOptions: {
                    directory: '/tmp/project',
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
        }));
    });

    it('prefers durable metadata group bindings over profile-only spawn and child-env fallbacks', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                happySessionMetadataFromLocalWebhook: {
                    path: '/tmp/project',
                    homeDir: '/tmp/home',
                    happyHomeDir: '/tmp/home/.happier',
                    happyLibDir: '/tmp/home/.happier/lib',
                    happyToolsDir: '/tmp/home/.happier/tools',
                    host: 'test-host',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'primary',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'profile',
                            serviceId: 'openai-codex',
                            profileId: 'primary',
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: null,
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
        }));
    });

    it('continues the interrupted turn when runtime recovery observes an already-applied generation', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const emitSessionEvent = vi.fn();
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 2 },
        });

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            tracked: expect.objectContaining({ happySessionId: 'sess_1' }),
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:group-1:backup:2',
            action: 'hot_applied',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'group-1',
                    },
                },
            },
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('does not continue when an observed generation still names the failed account', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'primary',
            generation: 2,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_same_failed_account',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'claude-subscription': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'claude',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_same_failed_account',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                resetsAtMs: null,
                retryAfterMs: null,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'observed_generation',
                activeProfileId: 'primary',
                generation: 2,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });

        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    });

    it('settles a superseding generation before continuing the interrupted turn', async () => {
        const order: string[] = [];
        const settleSupersedingRuntimeGroupGeneration = vi.fn(async () => {
            order.push('settled');
        });
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {
            order.push('continued');
        });
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'superseded_after_apply' as const,
            activeProfileId: 'current',
            generation: 3,
            credentialRevision: 'csr_cccccccccccccccccccccc',
            adoptedProfileId: 'backup',
            adoptedGeneration: 2,
            adoptedCredentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            reconciliationDisposition: 'superseded_after_apply' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'primary',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            settleSupersedingRuntimeGroupGeneration,
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'auth_expired',
                limitCategory: 'auth_invalid',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: null,
                quotaScope: 'account',
                providerLimitId: null,
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toMatchObject({
            status: 'switch_attempted',
            result: { status: 'superseded_after_apply', activeProfileId: 'current', generation: 3 },
        });

        expect(settleSupersedingRuntimeGroupGeneration).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            fromProfileId: 'primary',
            result: expect.objectContaining({ status: 'superseded_after_apply', activeProfileId: 'current', generation: 3 }),
        });
        expect(order).toEqual(['settled', 'continued']);
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            action: 'hot_applied',
            attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:group-1:current:3',
        }));
    });

    it('keeps the provider-reported failed profile when the tracked group selection already advanced', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const emitSessionEvent = vi.fn();
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
            mode: 'hot_apply' as const,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'backup',
                            },
                        },
                    },
                    environmentVariables: {
                        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                            kind: 'group',
                            serviceId: 'openai-codex',
                            groupId: 'group-1',
                            activeProfileId: 'backup',
                            fallbackProfileId: 'primary',
                            generation: 2,
                        }]),
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            emitSessionEvent,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 2, mode: 'hot_apply' },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            observedProfileId: 'primary',
            switchesThisTurn: 0,
        }));
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:group-1:backup:2',
            action: 'hot_applied',
        }));
        expect(emitSessionEvent).not.toHaveBeenCalled();
    });

    it('does not let stale provider-proof metadata veto a newer observed generation', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 5,
        }));
        const pendingIntent: RuntimeAuthRecoveryIntent = {
            v: 1,
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            profileId: null,
            groupId: 'group-1',
            status: 'resumed_awaiting_proof',
            armedAtMs: 1_000,
            nextRetryAtMs: 6_000,
            attemptCount: 1,
            maxAttempts: 5,
            switchesThisTurn: 1,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            failurePhase: 'handler',
            failureReason: 'classified_failure_reported',
            lastError: 'usage_limit',
            lastErrorClassification: { kind: 'rate_limited', retryable: true },
            pendingTargetProfileId: 'backup',
            pendingTargetGeneration: 2,
            terminalAtMs: null,
            terminalReason: null,
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                profileId: 'primary',
                                groupId: 'group-1',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 5 },
        });

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:group-1:backup:5',
            action: 'hot_applied',
        }));
    });

    it('re-enqueues the deterministic continuation when stale provider-proof metadata still exists', async () => {
        const continueAfterRuntimeAuthSwitch = vi.fn(async () => {});
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'observed_generation' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));
        const pendingIntent: RuntimeAuthRecoveryIntent = {
            v: 1,
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            profileId: null,
            groupId: 'group-1',
            status: 'resumed_awaiting_proof',
            armedAtMs: 1_000,
            nextRetryAtMs: 6_000,
            attemptCount: 1,
            maxAttempts: 5,
            switchesThisTurn: 1,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            failurePhase: 'handler',
            failureReason: 'classified_failure_reported',
            lastError: 'usage_limit',
            lastErrorClassification: { kind: 'rate_limited', retryable: true },
            pendingTargetProfileId: 'backup',
            pendingTargetGeneration: 2,
            terminalAtMs: null,
            terminalReason: null,
        };

        const legacyRecoveryMetadata = {
            runtimeAuthRecovery: {
                readForSession: () => [pendingIntent],
            },
        };

        await expect(handleConnectedServiceRuntimeAuthFailureForSession({
            ...legacyRecoveryMetadata,
            getChildren: () => [{
                startedBy: 'daemon',
                happySessionId: 'sess_1',
                pid: 123,
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                profileId: 'primary',
                                groupId: 'group-1',
                            },
                        },
                    },
                },
            }],
            switchCoordinator: { switchAfterClassifiedFailure },
            continueAfterRuntimeAuthSwitch,
            sessionId: 'sess_1',
            switchesThisTurn: 0,
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group-1',
                resetsAtMs: null,
                retryAfterMs: 30_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'observed_generation', activeProfileId: 'backup', generation: 2 },
        });

        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledOnce();
        expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            attemptId: 'connected-service-auth-switch|hot_applied|openai-codex:group:group-1:backup:2',
            action: 'hot_applied',
        }));
    });
});
