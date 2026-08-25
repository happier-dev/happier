import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations } from './syncAutomations';

const listAutomationDefinitionsMock = vi.hoisted(() => vi.fn());
const listAutomationDefinitionRunsMock = vi.hoisted(() => vi.fn());
const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'server-1' })));

vi.mock('@/sync/api/automations/apiAutomations', () => ({
    listAutomationDefinitions: listAutomationDefinitionsMock,
}));

vi.mock('@/sync/api/automations/apiAutomationRuns', () => ({
    listAutomationDefinitionRuns: listAutomationDefinitionRunsMock,
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
    existingSessionId: 'session-1',
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
    contentRemovedAt: null,
    createdAt: 10,
    updatedAt: 12,
};

describe('fetchAndApplyAutomations', () => {
    beforeEach(() => {
        listAutomationDefinitionsMock.mockReset();
        listAutomationDefinitionRunsMock.mockReset();
        isRuntimeFeatureEnabledMock.mockReset();
        getActiveServerSnapshotMock.mockClear();

        isRuntimeFeatureEnabledMock.mockResolvedValue(true);
        listAutomationDefinitionsMock.mockResolvedValue([eventSummary]);
        listAutomationDefinitionRunsMock.mockResolvedValue({
            runs: [eventRun],
            nextCursor: null,
        });
    });

    it('applies content-free summaries and refreshes already-loaded Event runs through the current API', async () => {
        const applyAutomations = vi.fn();
        const refreshAutomationRunsWindow = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds: ['event-1'],
            refreshAutomationRunsWindow,
        });

        expect(applyAutomations).toHaveBeenCalledWith([expect.objectContaining({
            id: 'event-1',
            trigger: eventSummary.trigger,
            detail: { kind: 'unloaded', templateVersion: 3 },
            // The bounded list carries the owner-projected association, so a
            // session-scoped consumer never reads private detail to find it.
            linkedExistingSessionId: 'session-1',
        })]);
        const appliedSummary = applyAutomations.mock.calls[0]?.[0]?.[0];
        expect(appliedSummary).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(appliedSummary).not.toHaveProperty('templateCiphertext');
        expect(appliedSummary).not.toHaveProperty('executionRecipe');
        expect(listAutomationDefinitionRunsMock).toHaveBeenCalledWith({
            credentials: { accessToken: 'token' },
            automationId: 'event-1',
            limit: 20,
        });
        expect(refreshAutomationRunsWindow).toHaveBeenCalledWith('event-1', [eventRun], null);
    });

    it('does not turn a list refresh into a private direct-detail fanout', async () => {
        const applyAutomations = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
        });

        expect(listAutomationDefinitionsMock).toHaveBeenCalledTimes(1);
        expect(applyAutomations.mock.calls[0]?.[0]?.[0]).toMatchObject({
            detail: { kind: 'unloaded', templateVersion: 3 },
        });
    });

    it('refreshes already-loaded run lists through the shared request-concurrency owner', async () => {
        const applyAutomations = vi.fn();
        const refreshAutomationRunsWindow = vi.fn();
        const loadedAutomationRunIds = Array.from({ length: 20 }, (_unused, index) => `event-${index + 1}`);
        listAutomationDefinitionsMock.mockResolvedValue(loadedAutomationRunIds.map((id) => ({
            ...eventSummary,
            id,
        })));
        let inFlight = 0;
        let peakInFlight = 0;
        listAutomationDefinitionRunsMock.mockImplementation(async () => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return { runs: [eventRun], nextCursor: null };
        });

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds,
            refreshAutomationRunsWindow,
        });

        // The Account ceiling allows thousands of definitions, so one socket
        // invalidation must never open one request per cached run list at once.
        expect(listAutomationDefinitionRunsMock).toHaveBeenCalledTimes(20);
        expect(peakInFlight).toBeLessThanOrEqual(
            loadSyncTuning().automationDefinitionDetailHydrationConcurrencyLimit,
        );
    });

    it('drops fetched automations when the captured sync scope is stale before apply', async () => {
        const applyAutomations = vi.fn();
        const refreshAutomationRunsWindow = vi.fn();

        await fetchAndApplyAutomations({
            credentials: { accessToken: 'token' } as any,
            applyAutomations,
            loadedAutomationRunIds: ['event-1'],
            refreshAutomationRunsWindow,
            shouldContinue: () => false,
        });

        expect(applyAutomations).not.toHaveBeenCalled();
        expect(listAutomationDefinitionRunsMock).not.toHaveBeenCalled();
        expect(refreshAutomationRunsWindow).not.toHaveBeenCalled();
    });
});

describe('fetchAndApplyAutomationRuns', () => {
    it('passes an opaque continuation cursor to the current API and applies the result only through the continuation owner', async () => {
        listAutomationDefinitionRunsMock.mockResolvedValue({
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

        expect(listAutomationDefinitionRunsMock).toHaveBeenCalledWith({
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
