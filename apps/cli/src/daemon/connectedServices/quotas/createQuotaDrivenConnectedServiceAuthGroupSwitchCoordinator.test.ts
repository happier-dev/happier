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
        const restartSession = vi.fn(async () => ({ ok: true as const }));

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

    it('hydrates persisted group quota snapshots before probing for quota-driven switching', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        runtimeQuotaSnapshots.recordSnapshot({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            snapshot: quotaSnapshot('primary', 5),
        });
        const hydratePersistedQuotaSnapshotsForGroup = vi.fn(async () => {
            runtimeQuotaSnapshots.recordProfileSnapshot({
                serviceId: 'openai-codex',
                profileId: 'backup',
                snapshot: quotaSnapshot('backup', 80),
            });
        });
        const probeGroupQuotaSnapshots = vi.fn(async () => {});
        const api = {
            getConnectedServiceAuthGroup: vi.fn(async () => group('primary', 1)),
            updateConnectedServiceAuthGroupActiveProfile: vi.fn(async () => group('backup', 2)),
        };
        const restartSession = vi.fn(async () => ({ ok: true as const }));

        const coordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
            api,
            runtimeQuotaSnapshots,
            quotaFreshnessMs: 60_000,
            nowMs: () => 1_000,
            restartSession,
            quotaCoordinator: {
                hydratePersistedQuotaSnapshotsForGroup,
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
        expect(hydratePersistedQuotaSnapshotsForGroup).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileIds: ['primary', 'backup'],
        });
        expect(probeGroupQuotaSnapshots).not.toHaveBeenCalled();
    });
});
