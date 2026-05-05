import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAndApplyAutomations } from './syncAutomations';

const listAutomationsMock = vi.hoisted(() => vi.fn());
const listAutomationRunsMock = vi.hoisted(() => vi.fn());
const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'server-1' })));

vi.mock('@/sync/api/automations/apiAutomations', () => ({
    listAutomations: listAutomationsMock,
}));

vi.mock('@/sync/api/automations/apiAutomationRuns', () => ({
    listAutomationRuns: listAutomationRunsMock,
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: isRuntimeFeatureEnabledMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: getActiveServerSnapshotMock,
}));

describe('fetchAndApplyAutomations', () => {
    beforeEach(() => {
        listAutomationsMock.mockReset();
        listAutomationRunsMock.mockReset();
        isRuntimeFeatureEnabledMock.mockReset();
        getActiveServerSnapshotMock.mockClear();

        isRuntimeFeatureEnabledMock.mockResolvedValue(true);
        listAutomationsMock.mockResolvedValue([
            {
                id: 'a1',
                name: 'Nightly',
                enabled: true,
                description: null,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
                targetType: 'new_session',
                templateCiphertext: 'cipher',
                templateVersion: 1,
                nextRunAt: null,
                lastRunAt: null,
                createdAt: 1,
                updatedAt: 1,
                assignments: [],
            },
        ]);
        listAutomationRunsMock.mockResolvedValue({
            runs: [
                {
                    id: 'r1',
                    automationId: 'a1',
                    state: 'succeeded',
                    scheduledAt: 10,
                    startedAt: 11,
                    finishedAt: 12,
                    updatedAt: 12,
                    claimedByMachineId: 'm1',
                    errorCode: null,
                    errorMessage: null,
                    summaryCiphertext: null,
                    producedSessionId: null,
                },
            ],
            nextCursor: null,
        });
    });

    it('refreshes already-loaded automation runs after applying automations', async () => {
        const applyAutomations = vi.fn();
        const setAutomationRuns = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds: ['a1'],
            setAutomationRuns,
        });

        expect(applyAutomations).toHaveBeenCalledTimes(1);
        expect(listAutomationRunsMock).toHaveBeenCalledWith({
            credentials: { accessToken: 'token' },
            automationId: 'a1',
            limit: 20,
        });
        expect(setAutomationRuns).toHaveBeenCalledWith('a1', expect.arrayContaining([
            expect.objectContaining({ id: 'r1', state: 'succeeded' }),
        ]));
    });

    it('drops fetched automations when the captured sync scope is stale before apply', async () => {
        const applyAutomations = vi.fn();
        const setAutomationRuns = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds: ['a1'],
            setAutomationRuns,
            shouldContinue: () => false,
        } as Parameters<typeof fetchAndApplyAutomations>[0] & { shouldContinue: () => boolean });

        expect(applyAutomations).not.toHaveBeenCalled();
        expect(listAutomationRunsMock).not.toHaveBeenCalled();
        expect(setAutomationRuns).not.toHaveBeenCalled();
    });
});
