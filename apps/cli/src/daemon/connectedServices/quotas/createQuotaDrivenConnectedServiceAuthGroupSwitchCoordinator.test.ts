import { describe, expect, it, vi } from 'vitest';
import type {
    ConnectedServiceAuthGroupV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator } from './createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator';

function quotaSnapshot(profileId: string, remainingPct: number): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        profileId,
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
            utilizationPct: 100 - remainingPct,
            remainingPct,
            resetsAt: null,
            status: 'ok',
            details: {},
        }],
    };
}

function group(activeProfileId: string, generation: number): ConnectedServiceAuthGroupV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        policy: {
            ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
            autoSwitch: true,
            softSwitchRemainingPercent: 15,
            preTurnProbeMode: 'when_stale',
            preTurnProbeOrder: 'current_first_then_candidates',
        },
        activeProfileId,
        generation,
        runtimeStateRevision: 0,
        state: { v: 1 },
        members: [
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'primary',
                enabled: true,
                priority: 1,
                state: { v: 1 },
                createdAt: 1,
                updatedAt: 1,
            },
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'backup',
                enabled: true,
                priority: 2,
                state: { v: 1 },
                createdAt: 2,
                updatedAt: 2,
            },
        ],
        createdAt: 1,
        updatedAt: 1,
    };
}

describe('createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator', () => {
    it('preserves exact provider-adoption evidence for immutable generation recipients', async () => {
        const exactVerification = {
            status: 'verified' as const,
            proofStrength: 'exact' as const,
            source: 'codex_app_server',
            providerAccountId: 'acct-backup',
        };
        const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
            api: {
                getConnectedServiceAuthGroup: vi.fn(async () => group('backup', 7)),
                updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
            },
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession: vi.fn(async () => ({
                ok: true as const,
                action: 'hot_applied' as const,
                providerApplication: 'applied' as const,
                verificationByServiceId: { 'openai-codex': exactVerification },
            })),
        });

        await expect(coordinator.applyCommittedGeneration({
            sessionId: 'session-1',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            generation: 7,
            reason: 'manual',
        })).resolves.toMatchObject({
            status: 'observed_generation',
            activeProfileId: 'backup',
            generation: 7,
            providerApplication: 'applied',
            verificationByServiceId: { 'openai-codex': exactVerification },
        });
    });

    it('probes stale group quota snapshots before quota-driven soft-threshold switching', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        runtimeQuotaSnapshots.recordSnapshot({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            snapshot: quotaSnapshot('primary', 5),
        });

        const probeGroupQuotaSnapshots = vi.fn(async () => {
            runtimeQuotaSnapshots.recordSnapshot({
                serviceId: 'openai-codex',
                groupId: 'main',
                profileId: 'backup',
                snapshot: quotaSnapshot('backup', 80),
            });
        });
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const, mode: 'hot_apply' as const }));

        const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots,
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession,
            quotaCoordinator: {
                probeGroupQuotaSnapshots,
            },
        });

        await expect(coordinator.switchBeforeTurn({
            sessionId: 'session-1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'soft_threshold',
        })).resolves.toMatchObject({
            status: 'switched',
            activeProfileId: 'backup',
            generation: 2,
        });
        expect(probeGroupQuotaSnapshots).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileIds: ['backup'],
            reason: 'soft_threshold',
        });
        expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
        }));
    });

    it('keeps the current profile when probing produces no fresh candidate quota snapshot', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        runtimeQuotaSnapshots.recordSnapshot({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            snapshot: quotaSnapshot('primary', 5),
        });
        const probeGroupQuotaSnapshots = vi.fn(async () => {});
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const, mode: 'hot_apply' as const }));

        const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots,
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession,
            quotaCoordinator: {
                probeGroupQuotaSnapshots,
            },
        });

        await expect(coordinator.switchBeforeTurn({
            sessionId: 'session-1',
            serviceId: 'openai-codex',
            groupId: 'main',
            reason: 'soft_threshold',
        })).resolves.toMatchObject({
            status: 'observed_generation',
            activeProfileId: 'primary',
            generation: 1,
        });
        expect(probeGroupQuotaSnapshots).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileIds: ['backup'],
            reason: 'soft_threshold',
        });
        expect(restartSession).not.toHaveBeenCalled();
    });
});
