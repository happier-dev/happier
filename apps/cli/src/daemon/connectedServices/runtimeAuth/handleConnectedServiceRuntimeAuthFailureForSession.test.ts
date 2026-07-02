import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { handleConnectedServiceRuntimeAuthFailureForSession } from './handleConnectedServiceRuntimeAuthFailureForSession';
import type { RuntimeAuthRecoveryIntent } from './RuntimeAuthRecoveryScheduler';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';

describe('handleConnectedServiceRuntimeAuthFailureForSession', () => {
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
            restartRequested: true,
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).toHaveBeenCalledWith({
            serviceId: 'claude-subscription',
            profileId: 'primary',
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
                        profileId: 'primary',
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

    it.each([
        ['resumed_awaiting_proof', 'auth_expired'],
        ['checking', 'recovery_unproven_awaiting_provider_outcome'],
    ] as const)(
        'returns reconnect action instead of repeatedly force-refreshing while provider proof is pending (%s)',
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

        await expect(handleConnectedServiceRuntimeAuthFailureForSession(input)).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'reconnect_profile',
                serviceId: 'claude-subscription',
                profileId: 'primary',
                groupId: 'claude',
                reason: 'auth_expired',
            },
        });

        expect(refreshConnectedServiceCredentialForRuntimeAuthFailure).not.toHaveBeenCalled();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('routes tracked group session failures into the switch coordinator with structured recovery context', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
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
            result: { status: 'switched', activeProfileId: 'backup', generation: 2, mode: 'hot_apply' },
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
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_auth_group_switch',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'usage_limit',
            mode: 'hot_apply',
            toGeneration: 2,
            resultStatus: 'switched',
            success: true,
        }));
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
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            fromProfileId: 'primary',
            toProfileId: 'backup-2',
        }));
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
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error' as const,
            },
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

  it('resolves group selection from tracked spawn options and records successful switch attempts', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));
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
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        const second = await handleConnectedServiceRuntimeAuthFailureForSession({
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
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        });

        expect(first).toMatchObject({ status: 'switch_attempted' });
        expect(second).toMatchObject({ status: 'switch_attempted' });
        expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(2, expect.objectContaining({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            switchesThisTurn: 1,
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
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_auth_group_switch',
            serviceId: 'gemini',
            groupId: 'group-1',
            fromProfileId: 'backup',
            toProfileId: 'secondary',
            reason: 'usage_limit',
            toGeneration: 3,
            resultStatus: 'switched',
            success: true,
        }));
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
        }));
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_auth_group_switch',
            serviceId: 'openai-codex',
            groupId: 'group-1',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            reason: 'usage_limit',
            resultStatus: 'observed_generation',
            success: true,
            toGeneration: 2,
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
        expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
            type: 'connected_service_auth_group_switch',
            fromProfileId: 'primary',
            toProfileId: 'backup',
            resultStatus: 'observed_generation',
            success: true,
        }));
    });

    it('does not re-continue a stale-profile replay when the pending proof target re-appears at a churned generation', async () => {
        // Sibling sessions bump the shared group generation between replays (incident
        // 2026-06-12, gen 81→87): the pending proof target is the PROFILE, deliberately
        // NOT the group generation — a fresher generation for the same target profile is
        // the same logical switch and must stay coalesced.
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
            runtimeAuthRecovery: {
                readForSession: () => [pendingIntent],
            },
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

        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    });

    it('does not re-continue a stale-profile replay when the same target is already pending provider proof', async () => {
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
            runtimeAuthRecovery: {
                readForSession: () => [pendingIntent],
            },
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

        expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
    });
});
