import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations } from './syncAutomations';

const listAutomationDefinitionsV3Mock = vi.hoisted(() => vi.fn());
const listAutomationDefinitionRunsV3Mock = vi.hoisted(() => vi.fn());
const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'server-1' })));

vi.mock('@/sync/api/automations/apiAutomations', () => ({
    listAutomationDefinitionsV3: listAutomationDefinitionsV3Mock,
}));

vi.mock('@/sync/api/automations/apiAutomationRuns', () => ({
    listAutomationDefinitionRunsV3: listAutomationDefinitionRunsV3Mock,
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: isRuntimeFeatureEnabledMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: getActiveServerSnapshotMock,
}));

const eventSummary = {
    id: 'event-1',
    name: 'Repository updates',
    description: null,
    enabled: true,
    trigger: {
        kind: 'pluginEvent' as const,
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'repository-event-v1',
        },
        sourceSelectorId: 'selector-1',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull' as const,
            watcher: null,
        },
    },
    targetType: 'existingSession' as const,
    templateVersion: 3,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    assignments: [],
};

const eventRun = {
    id: 'run-event-1',
    automationId: 'event-1',
    state: 'succeeded' as const,
    origin: {
        kind: 'pluginEvent' as const,
        occurrenceKey: 'occurrence-1',
        sourceSelectorId: 'selector-1',
        occurredAt: 10,
    },
    dueAt: 10,
    claimedAt: null,
    startedAt: 11,
    finishedAt: 12,
    claimedByMachineId: 'machine-1',
    leaseExpiresAt: null,
    attempt: 1,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: 'settled' as const,
    executionAttempt: 1,
    replyHandoffState: 'none' as const,
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
    createdAt: 10,
    updatedAt: 12,
};

describe('fetchAndApplyAutomations', () => {
    beforeEach(() => {
        listAutomationDefinitionsV3Mock.mockReset();
        listAutomationDefinitionRunsV3Mock.mockReset();
        isRuntimeFeatureEnabledMock.mockReset();
        getActiveServerSnapshotMock.mockClear();

        isRuntimeFeatureEnabledMock.mockResolvedValue(true);
        listAutomationDefinitionsV3Mock.mockResolvedValue([eventSummary]);
        listAutomationDefinitionRunsV3Mock.mockResolvedValue({
            runs: [eventRun],
            nextCursor: null,
        });
    });

    it('applies content-free V3 summaries and refreshes already-loaded Event runs through V3', async () => {
        const applyAutomations = vi.fn();
        const setAutomationRuns = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds: ['event-1'],
            setAutomationRuns,
        });

        expect(applyAutomations).toHaveBeenCalledWith([expect.objectContaining({
            id: 'event-1',
            trigger: eventSummary.trigger,
            detail: { kind: 'unloaded', templateVersion: 3 },
            linkedExistingSessionId: null,
        })]);
        const appliedSummary = applyAutomations.mock.calls[0]?.[0]?.[0];
        expect(appliedSummary).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(listAutomationDefinitionRunsV3Mock).toHaveBeenCalledWith({
            credentials: { accessToken: 'token' },
            automationId: 'event-1',
            limit: 20,
        });
        expect(setAutomationRuns).toHaveBeenCalledWith('event-1', [eventRun], null);
    });

    it('does not turn a list refresh into a private direct-detail fanout', async () => {
        const applyAutomations = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
        });

        expect(listAutomationDefinitionsV3Mock).toHaveBeenCalledTimes(1);
        expect(applyAutomations.mock.calls[0]?.[0]?.[0]).toMatchObject({
            detail: { kind: 'unloaded', templateVersion: 3 },
        });
    });

    it('drops fetched automations when the captured sync scope is stale before apply', async () => {
        const applyAutomations = vi.fn();
        const setAutomationRuns = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds: ['event-1'],
            setAutomationRuns,
            shouldContinue: () => false,
        });

        expect(applyAutomations).not.toHaveBeenCalled();
        expect(listAutomationDefinitionRunsV3Mock).not.toHaveBeenCalled();
        expect(setAutomationRuns).not.toHaveBeenCalled();
    });
});

describe('fetchAndApplyAutomationRuns', () => {
    it('passes an opaque continuation cursor to the V3 API and applies the result only through the continuation owner', async () => {
        listAutomationDefinitionRunsV3Mock.mockResolvedValue({
            runs: [eventRun],
            nextCursor: null,
        });
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);
        const setAutomationRuns = vi.fn();
        const appendAutomationRuns = vi.fn();

        const result = await fetchAndApplyAutomationRuns({
            credentials: { accessToken: 'token' } as any,
            automationId: 'event-1',
            limit: 20,
            cursor: 'opaque-root-page',
            setAutomationRuns,
            appendAutomationRuns,
        });

        expect(listAutomationDefinitionRunsV3Mock).toHaveBeenCalledWith({
            credentials: { accessToken: 'token' },
            automationId: 'event-1',
            limit: 20,
            cursor: 'opaque-root-page',
        });
        expect(setAutomationRuns).not.toHaveBeenCalled();
        expect(appendAutomationRuns).toHaveBeenCalledWith('event-1', 'opaque-root-page', [eventRun], null);
        expect(result).toEqual({ nextCursor: null });
    });
});
