import { describe, expect, it, vi } from 'vitest';

import {
    buildProviderAccountUsageRecordId,
    type ConnectedServiceAuthGroupV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

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
        runtimeStateRevision: 0,
        state: {},
        members: [
            { v: 1, serviceId: 'openai-codex', groupId: 'main', profileId: 'primary', priority: 10, enabled: true, state: {}, createdAt: 1, updatedAt: 1 },
            { v: 1, serviceId: 'openai-codex', groupId: 'main', profileId: 'backup', priority: 20, enabled: true, state: {}, createdAt: 2, updatedAt: 2 },
        ],
        createdAt: 1,
        updatedAt: 1,
    };
}

function providerAccountUsageSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'openai-codex',
        accountSubjectId: `acct-${profileId}`,
        subjectKind: 'subscription',
        quotaScope: 'account',
    };
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'openai-codex',
        accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        meters: [{
            meterId: 'weekly',
            label: 'Weekly',
            used: 100 - remainingPct,
            limit: 100,
            remaining: remainingPct,
            remainingPct,
            usedPct: 100 - remainingPct,
            utilizationPct: 100 - remainingPct,
            resetsAt: null,
            resetAtMs: null,
            unit: 'credits',
            status: 'ok',
            limitScope: 'account',
            confidence: 'exact',
            details: { limitCategory: 'usage_limit' },
        }],
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
            resolveCredentialRevision: () => 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            restartSession,
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
            switchesThisTurn: 0,
        })).resolves.toMatchObject({
            status: 'switched',
            activeProfileId: 'backup',
            generation: 2,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            mode: 'restart_resume',
            diagnostics: {
                decisionTrace: expect.objectContaining({
                    activeProfileId: 'primary',
                    reason: 'selected',
                    candidates: expect.arrayContaining([
                        expect.objectContaining({
                            profileId: 'backup',
                            decision: 'selected',
                        }),
                    ]),
                }),
            },
        });
        expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            expectedGeneration: 1,
            overrideRuntimeCooldown: true,
        });
        expect(restartSession).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            generation: 2,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            reason: 'usage_limit',
        });
    });

    it('threads and post-fences the exact credential revision for an observed generation apply', async () => {
        const adoptedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        let currentRevision = adoptedRevision;
        const restartSession = vi.fn(async () => {
            currentRevision = authoritativeRevision;
            return { ok: true as const };
        });
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api: {
                getConnectedServiceAuthGroup: vi.fn(async () => group('backup', 2)),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
            },
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            resolveCredentialRevision: () => currentRevision,
            restartSession,
        });

        await expect(coordinator.applyCommittedGeneration({
            sessionId: 'revision-recipient',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            generation: 2,
            credentialRevision: adoptedRevision,
            reason: 'credential_revision_changed',
        })).resolves.toMatchObject({
            status: 'superseded_after_apply',
            credentialRevision: authoritativeRevision,
            adoptedCredentialRevision: adoptedRevision,
        });
        expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({
            credentialRevision: adoptedRevision,
        }));
    });

    it('loads switch state from source-backed provider account usage before runtime quota snapshots', async () => {
        const accountUsageStore = {
            resolveBySource: vi.fn((source: { serviceId: string; profileId: string; groupId?: string | null; groupGeneration?: number | null }) => {
                if (
                    source.serviceId !== 'openai-codex'
                    || source.groupId !== 'main'
                    || source.groupGeneration !== 1
                ) {
                    return null;
                }
                if (source.profileId === 'primary') return providerAccountUsageSnapshot('primary', 0);
                if (source.profileId === 'backup') return providerAccountUsageSnapshot('backup', 80);
                return null;
            }),
        };
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const }));
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            accountUsageStore,
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
        })).resolves.toMatchObject({
            status: 'switched',
            activeProfileId: 'backup',
            generation: 2,
            mode: 'restart_resume',
        });
        expect(accountUsageStore.resolveBySource).toHaveBeenCalled();
    });

    it('preflights predictive session generation apply before committing the auth group', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        runtimeQuotaSnapshots.recordProfileSnapshot({
            serviceId: 'openai-codex',
            profileId: 'primary',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'primary',
                fetchedAt: 1_000,
                staleAfterMs: 60_000,
                planLabel: null,
                accountLabel: null,
                meters: [{
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: 100,
                    remainingPct: 0,
                    resetsAt: null,
                    status: 'estimated',
                    details: {},
                }],
            },
        });
        runtimeQuotaSnapshots.recordProfileSnapshot({
            serviceId: 'openai-codex',
            profileId: 'backup',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'backup',
                fetchedAt: 1_000,
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
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const, mode: 'hot_apply' as const }));
        const preflightConnectedServiceAuthGeneration = vi.fn(async () => ({ ok: true as const, mode: 'restart_resume' as const }));
        const deps = {
            api,
            runtimeQuotaSnapshots,
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession,
            preflightConnectedServiceAuthGeneration,
        };
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator(deps);

        await expect(coordinator.switchBeforeTurn({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'same_provider_account_exhausted',
            observedProfileId: 'primary',
        })).resolves.toMatchObject({
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'hot_apply_restart_required',
            diagnostics: {
                attemptedMode: 'restart_resume',
                policyReason: 'predictive_soft_switch_hot_apply_required',
            },
        });
        expect(preflightConnectedServiceAuthGeneration).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            generation: 2,
            reason: 'same_provider_account_exhausted',
        });
        expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
        expect(restartSession).not.toHaveBeenCalled();
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

        // The fourth read is the authoritative post-apply epoch fence.
        expect(getConnectedServiceAuthGroup).toHaveBeenCalledTimes(4);
        expect(sleepMs).toHaveBeenCalledWith(250);
    });

    it('does not detach a timed-out quota probe and commit while it can still refresh the candidate', async () => {
        vi.useFakeTimers();
        try {
            const api = {
                getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
            };
            let releaseProbe!: () => void;
            const probePending = new Promise<void>((resolve) => {
                releaseProbe = resolve;
            });
            const restartSession = vi.fn(async () => ({ ok: true as const }));
            const probeQuotaSnapshotsForGroup = vi.fn(async () => {
                await probePending;
            });
            const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
                api,
                runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
                quotaFreshnessMs: 60_000,
                nowMs: () => 1_000,
                restartSession,
                probeQuotaSnapshotsForGroup,
            });

            const result = coordinator.switchAfterClassifiedFailure({
                sessionId: 'sess_1',
                serviceId: 'openai-codex',
                groupId: 'main',
                reason: 'usage_limit',
                switchesThisTurn: 0,
            });

            await vi.advanceTimersByTimeAsync(25);

            expect(api.updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
            releaseProbe();
            await expect(result).resolves.toMatchObject({
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
        })).resolves.toMatchObject({
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

    it('selects a fallback after classified failure without preloading legacy quota snapshots', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
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
        });

        await expect(coordinator.switchAfterClassifiedFailure({
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'usage_limit',
        })).resolves.toMatchObject({ status: 'switched', activeProfileId: 'backup' });

        expect(api.updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            activeProfileId: 'backup',
            expectedGeneration: 1,
            overrideRuntimeCooldown: true,
        }));
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
            expectedRuntimeStateRevision: 0,
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
            expectedRuntimeStateRevision: 0,
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
                groupLabel: 'Main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                success: true,
            }),
        ]);
    });

    it('falls back to the group id when emitting switch events for unlabeled groups', async () => {
        const events: unknown[] = [];
        const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api: {
                getConnectedServiceAuthGroup: vi.fn(async () => ({ ...group('primary', 1), displayName: null })),
                updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => ({ ...group('primary', 1), displayName: null })),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => ({ ...group('backup', 2), displayName: null })),
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
                groupLabel: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                success: true,
            }),
        ]);
    });
});
