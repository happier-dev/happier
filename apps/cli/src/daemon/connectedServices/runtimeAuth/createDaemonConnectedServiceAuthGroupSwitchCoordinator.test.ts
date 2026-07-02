import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './createDaemonConnectedServiceAuthGroupSwitchCoordinator';

function group(activeProfileId: string, generation: number): ConnectedServiceAuthGroupV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: 'Main',
        policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
        activeProfileId,
        generation,
        state: {},
        members: [
            { v: 1, serviceId: 'openai-codex', groupId: 'main', profileId: 'primary', priority: 10, enabled: true, state: {}, createdAt: 1, updatedAt: 1 },
            { v: 1, serviceId: 'openai-codex', groupId: 'main', profileId: 'backup', priority: 20, enabled: true, state: {}, createdAt: 2, updatedAt: 2 },
        ],
        createdAt: 1,
        updatedAt: 1,
    };
}

describe('createDaemonConnectedServiceAuthGroupSwitchCoordinator', () => {
    it('loads, commits, and applies a daemon auth-group switch', async () => {
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const }));
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession,
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            switchesThisTurn: 0,
        })).resolves.toEqual({
            status: 'switched',
            activeProfileId: 'backup',
            generation: 2,
            mode: 'restart_resume',
        });
        expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            expectedGeneration: 1,
        });
        expect(restartSession).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            generation: 2,
        });
    });

    it('retries a transient auth-group load failure with backoff before switching', async () => {
        const getConnectedServiceAuthGroup = vi.fn<() => Promise<ConnectedServiceAuthGroupV1 | null>>()
            .mockRejectedValueOnce(new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'))
            .mockResolvedValue(group('primary', 1));
        const api = {
            getConnectedServiceAuthGroup,
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const }));
        const sleepMs = vi.fn(async () => {});
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession,
            sleepMs,
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            switchesThisTurn: 0,
        })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup', generation: 2 });

        expect(getConnectedServiceAuthGroup).toHaveBeenCalledTimes(3);
        expect(sleepMs).toHaveBeenCalledWith(250);
    });

    it('does not let a slow quota probe block reactive recovery indefinitely', async () => {
        vi.useFakeTimers();
        try {
            const api = {
                getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
            };
            const restartSession = vi.fn(async () => ({ ok: true as const }));
            const probeQuotaSnapshotsForGroup = vi.fn(async () => {
                await new Promise<void>(() => {});
            });
            const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
                api,
                runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                restartSession,
                probeQuotaSnapshotsForGroup,
                quotaProbeTimeoutMs: 25,
            });

            const result = coordinator.switchAfterClassifiedFailure({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                groupId: 'main',
                reason: 'usage_limit',
                switchesThisTurn: 0,
            });

            await vi.advanceTimersByTimeAsync(25);

            await expect(result).resolves.toEqual({
                status: 'switched',
                activeProfileId: 'backup',
                generation: 2,
                mode: 'restart_resume',
            });
            expect(probeQuotaSnapshotsForGroup).toHaveBeenCalledWith({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileIds: ['backup'],
                reason: 'usage_limit',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns typed apply failure state when the live session cannot apply the committed group generation', async () => {
        const applyResult = {
            ok: false,
            errorCode: 'partial_applied_pending_reconciliation',
            diagnostics: {
                failurePhase: 'reconciliation',
                application: {
                    status: 'partial_applied_pending_reconciliation',
                    phase: 'hot_apply',
                    actor: 'runtime',
                    reason: 'automatic_runtime_failure',
                },
            },
        } as const;
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => applyResult,
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            switchesThisTurn: 0,
        })).resolves.toEqual({
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'partial_applied_pending_reconciliation',
            diagnostics: {
                failurePhase: 'reconciliation',
                application: {
                    status: 'partial_applied_pending_reconciliation',
                    phase: 'hot_apply',
                    actor: 'runtime',
                    reason: 'automatic_runtime_failure',
                },
            },
        });
        expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledOnce();
    });

    it('uses persisted member runtime state from the auth-group API before selecting a candidate', async () => {
        const initial = group('primary', 1);
        const groupWithPersistedCooldown: ConnectedServiceAuthGroupV1 = {
            ...initial,
            members: [
                initial.members[0]!,
                {
                    ...initial.members[1]!,
                    state: { v: 1, cooldownUntilMs: 5_000 },
                },
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    groupId: 'main',
                    profileId: 'tertiary',
                    priority: 30,
                    enabled: true,
                    state: { v: 1 },
                    createdAt: 3,
                    updatedAt: 3,
                },
            ],
        };
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => groupWithPersistedCooldown),
            updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => groupWithPersistedCooldown),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
                ...groupWithPersistedCooldown,
                activeProfileId,
                generation: 2,
            })),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
        })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary' });
    });

    it('hydrates persisted quota snapshots for group members before selection', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        const hydratePersistedQuotaSnapshotsForGroup = vi.fn(async () => {
            runtimeQuotaSnapshots.recordProfileSnapshot({
                serviceId: 'openai-codex',
                profileId: 'backup',
                snapshot: {
                    v: 1,
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    fetchedAt: 900,
                    staleAfterMs: 60_000,
                    planLabel: null,
                    accountLabel: null,
                    meters: [{
                        meterId: 'weekly',
                        label: 'Weekly',
                        used: null,
                        limit: null,
                        unit: 'unknown',
                        utilizationPct: 20,
                        remainingPct: 80,
                        resetsAt: null,
                        status: 'ok',
                        details: {},
                    }],
                },
            });
        });
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots,
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
            hydratePersistedQuotaSnapshotsForGroup,
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
        })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });

        expect(hydratePersistedQuotaSnapshotsForGroup).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileIds: ['primary', 'backup'],
        });
    });

    it('excludes server-known reconnect-required profiles before selecting an automatic fallback', async () => {
        const initial = group('primary', 1);
        const groupWithTertiary: ConnectedServiceAuthGroupV1 = {
            ...initial,
            members: [
                initial.members[0]!,
                initial.members[1]!,
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    groupId: 'main',
                    profileId: 'tertiary',
                    priority: 30,
                    enabled: true,
                    state: { v: 1 },
                    createdAt: 3,
                    updatedAt: 3,
                },
            ],
        };
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => groupWithTertiary),
            listConnectedServiceProfiles: vi.fn(async () => ({
                serviceId: 'openai-codex' as const,
                profiles: [
                    { profileId: 'backup', status: 'needs_reauth' as const },
                    { profileId: 'tertiary', status: 'connected' as const },
                ],
            })),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async ({ activeProfileId }: { activeProfileId: string }) => ({
                ...groupWithTertiary,
                activeProfileId,
                generation: 2,
            })),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
        })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'tertiary' });

        expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            activeProfileId: 'tertiary',
        }));
    });

    it('persists observed quota failure state before relying on selector state', async () => {
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
        });

        await coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            retryAfterMs: 5_000,
            planType: 'team',
        });

        expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            expectedGeneration: 1,
            memberStates: [{
                profileId: 'primary',
                state: expect.objectContaining({
                    quotaExhaustedUntilMs: 6_000,
                    lastFailureKind: 'usage_limit',
                    lastObservedPlanType: 'team',
                    lastObservedAtMs: 1_000,
                }),
            }],
        });
    });

    it('uses the group cooldown as a usage-limit exhaustion fallback when provider timing is missing', async () => {
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => ({
                ...group('primary', 1),
                policy: {
                    ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
                    autoSwitch: true,
                    cooldownMs: 45_000,
                },
            })),
            updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
        });

        await coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            planType: null,
        });

        expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
            memberStates: [{
                profileId: 'primary',
                state: expect.objectContaining({
                    quotaExhaustedUntilMs: 46_000,
                    lastFailureKind: 'usage_limit',
                    lastObservedAtMs: 1_000,
                }),
            }],
        }));
    });

    it('uses the group cooldown as rate-limit and capacity fallback timing when provider timing is missing', async () => {
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => ({
                ...group('primary', 1),
                policy: {
                    ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
                    autoSwitch: true,
                    cooldownMs: 45_000,
                },
            })),
            updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
        });

        await coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'rate_limit',
            observedProfileId: 'primary',
            planType: null,
        });
        await coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'capacity',
            observedProfileId: 'primary',
            planType: null,
        });

        expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(1, expect.objectContaining({
            memberStates: [{
                profileId: 'primary',
                state: expect.objectContaining({
                    rateLimitedUntilMs: 46_000,
                    lastFailureKind: 'rate_limit',
                    lastObservedAtMs: 1_000,
                }),
            }],
        }));
        expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
            memberStates: [{
                profileId: 'primary',
                state: expect.objectContaining({
                    capacityLimitedUntilMs: 46_000,
                    lastFailureKind: 'capacity',
                    lastObservedAtMs: 1_000,
                }),
            }],
        }));
    });

    it('switches and persists auth blocker state for disabled account classifications', async () => {
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'account_disabled',
            observedProfileId: 'primary',
            retryAfterMs: 5_000,
        })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });

        expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            expectedGeneration: 1,
            memberStates: [{
                profileId: 'primary',
                state: expect.objectContaining({
                    authInvalidUntilMs: 6_000,
                    lastFailureKind: 'account_disabled',
                }),
            }],
        });
    });

    it('forwards structured switch events from the daemon factory', async () => {
        const events: unknown[] = [];
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api: {
                getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
                updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => group('primary', 1)),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
            },
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: async () => ({ ok: true as const }),
            emitEvent: (event) => events.push(event),
        });

        await coordinator.switchAfterClassifiedFailure({
            sessionId: 'session-1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            observedProfileId: 'primary',
        });

        expect(events).toEqual([
            expect.objectContaining({
                type: 'connected_service_auth_group_switch',
                serviceId: 'openai-codex',
                groupId: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                success: true,
            }),
        ]);
    });
});
