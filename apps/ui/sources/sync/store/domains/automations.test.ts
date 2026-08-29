import { describe, expect, it } from 'vitest';
import {
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListItemSchema,
    AutomationV3RunListItemSchema,
} from '@happier-dev/protocol';

import {
    createAutomationDefinitionFromDetail,
    createAutomationDefinitionSummary,
    markAutomationDefinitionContentUnavailable,
} from '@/sync/domains/automations/automationDefinitionProjection';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from '@/sync/domains/automations/automationTypes';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import { createAutomationsDomain } from './automations';

type State = ReturnType<typeof createAutomationsDomain>;

type PaginatedRunsState = State & {
    automationRunNextCursorByAutomationId: Record<string, string | null>;
    setAutomationRuns: (automationId: string, runs: AutomationDefinitionRun[], nextCursor: string | null) => void;
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    refreshAutomationRunsWindow: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
};

const eventDefinitionSummary = AutomationDefinitionListItemSchema.parse({
    id: 'event-1',
    name: 'Repository updates',
    description: null,
    enabled: true,
    triggers: [{
        id: 'event-trigger-1',
        revision: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 2,
        kind: 'pluginEvent',
        eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
        sourceSelectorId: '11111111-1111-4111-8111-111111111111',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull',
            watcher: {
                machineId: 'machine-1',
                machineInstallationId: 'installation-1',
                pluginId: 'happier.scm.github',
                materializationId: 'materialization-1',
            },
        },
        sourceStatus: null,
        sourceCatalogStatus: null,
    }],
    targetType: 'existingSession',
    existingSessionId: 'session-1',
    templateVersion: 3,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 2,
    assignments: [],
});

const eventDefinitionDetail = AutomationDefinitionDetailSchema.parse({
    ...eventDefinitionSummary,
    triggers: eventDefinitionSummary.triggers.map((trigger) => ({
        ...trigger,
        triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
    })),
    executionRecipe: {
        v: 1 as const,
        templateVersion: 3,
        template: { t: 'plain' as const, v: { v: 1, prompt: 'Review {{input}}' } },
        triggerEvidence: null,
        target: { kind: 'existingSession' as const, sessionId: 'session-1' },
    },
});

function createHarness(): {
    state: State;
    get: () => State;
    set: (updater: (state: State) => State) => void;
} {
    let state = {} as State;
    const get = () => state;
    const set = (updater: (draft: State) => State) => {
        state = updater(state);
    };
    state = createAutomationsDomain({ get, set } as any);
    return { state, get, set };
}

function automation(input: Readonly<{
    id: string;
    name?: string;
    enabled?: boolean;
    updatedAt?: number;
}>): AutomationDefinition {
    return createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
        ...eventDefinitionSummary,
        id: input.id,
        name: input.name ?? input.id,
        enabled: input.enabled ?? true,
        updatedAt: input.updatedAt ?? 1,
    }));
}

function run(input: Readonly<{
    id: string;
    automationId: string;
    state?: AutomationDefinitionRun['state'];
    dueAt?: number;
    updatedAt?: number;
}>): AutomationDefinitionRun {
    const occurredAt = input.dueAt ?? 1;
    return AutomationV3RunListItemSchema.parse({
        id: input.id,
        automationId: input.automationId,
        revision: 1,
        triggerId: null,
        triggerRetired: false,
        state: input.state ?? 'queued',
        cause: { kind: 'manual', invokedAt: occurredAt },
        dueAt: occurredAt,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        claimedByMachineId: null,
        leaseExpiresAt: null,
        attempt: 0,
        errorCode: null,
        producedSessionId: null,
        executionDispatchState: null,
        executionAttempt: 0,
        replyHandoffState: 'none',
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        createdAt: occurredAt,
        updatedAt: input.updatedAt ?? 1,
    });
}

function pluginEventRun(input: Readonly<{
    id: string;
    occurredAt: number;
    updatedAt: number;
}>): AutomationDefinitionRun {
    return AutomationV3RunListItemSchema.parse({
        ...run({
            id: input.id,
            automationId: 'event-1',
            dueAt: input.occurredAt,
            updatedAt: input.updatedAt,
        }),
        triggerId: 'event-trigger-1',
        cause: {
            kind: 'trigger',
            triggerId: 'event-trigger-1',
            triggerRevision: 1,
            triggerKind: 'pluginEvent',
            occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            occurredAt: input.occurredAt,
            evidence: {
                eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
                sourceSelectorId: '11111111-1111-4111-8111-111111111111',
            },
        },
    });
}

describe('createAutomationsDomain', () => {
    it('initializes with empty automation state', () => {
        const harness = createHarness();
        expect(harness.get().automations).toEqual({});
        expect(harness.get().automationDefinitionNextCursor).toBeNull();
        expect(harness.get().automationRunsByAutomationId).toEqual({});
    });

    it('replaces automations map when applying a snapshot', () => {
        const harness = createHarness();
        harness.get().applyAutomations([automation({ id: 'a1' }), automation({ id: 'a2' })]);
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a1', 'a2']);

        harness.get().applyAutomations([automation({ id: 'a3' })]);
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a3']);
    });

    it('preserves an extended Automation window while restarting its fresh continuation on refresh', () => {
        const harness = createHarness();
        harness.get().applyAutomations([automation({ id: 'a2', updatedAt: 2 })], 'cursor-1');

        harness.get().appendAutomations('stale-cursor', [automation({ id: 'a1' })], null);
        expect(Object.keys(harness.get().automations)).toEqual(['a2']);
        expect(harness.get().automationDefinitionNextCursor).toBe('cursor-1');

        harness.get().appendAutomations('cursor-1', [automation({ id: 'a1' })], null);
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a1', 'a2']);
        expect(harness.get().automationDefinitionNextCursor).toBeNull();

        harness.get().applyAutomations([automation({ id: 'a2', name: 'refreshed', updatedAt: 3 })], 'cursor-new');
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a1', 'a2']);
        expect(harness.get().automations.a2?.name).toBe('refreshed');
        expect(harness.get().automationDefinitionNextCursor).toBe('cursor-new');

        // The fresh cursor may replay an already-retained row before it
        // reaches definitions inserted while this client was offline. The
        // identity-keyed merge keeps the old tail without duplicating it.
        harness.get().appendAutomations('cursor-new', [
            automation({ id: 'a1', updatedAt: 2 }),
            automation({ id: 'a-new', updatedAt: 2.5 }),
        ], null);
        expect(Object.keys(harness.get().automations).sort()).toEqual(['a-new', 'a1', 'a2']);
        expect(harness.get().automationDefinitionNextCursor).toBeNull();

        // A complete refreshed first page is the whole current catalog and
        // may therefore retire predecessor tail rows authoritatively.
        harness.get().applyAutomations([automation({ id: 'a2', updatedAt: 4 })], null);
        expect(Object.keys(harness.get().automations)).toEqual(['a2']);
        expect(harness.get().automationDefinitionWindowExtended).toBe(false);
    });

    it('retains current private definition content across a same-version summary refresh and drops it on a revision change', () => {
        const harness = createHarness();
        const current = createAutomationDefinitionFromDetail(eventDefinitionDetail);
        harness.get().applyAutomations([current]);
        harness.get().applyAutomations([createAutomationDefinitionSummary({
            ...eventDefinitionSummary,
            name: 'Repository updates (renamed)',
        })]);

        expect(harness.get().automations['event-1']?.detail).toMatchObject({
            kind: 'available',
            value: {
                name: 'Repository updates (renamed)',
                triggers: [expect.objectContaining({
                    triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
                })],
                executionRecipe: current.detail.kind === 'available'
                    ? current.detail.value.executionRecipe
                    : undefined,
            },
        });

        harness.get().applyAutomations([createAutomationDefinitionSummary({
            ...eventDefinitionSummary,
            name: 'Repository updates (changed)',
            templateVersion: 4,
        })]);

        expect(harness.get().automations['event-1']?.detail).toEqual({
            kind: 'unloaded',
            templateVersion: 4,
        });
    });

    it('refreshes the list-safe Event catalog status without creating a second detail cache', () => {
        const harness = createHarness();
        const currentCatalogStatus = {
            observedRevision: '7',
            adoptedRevision: '7',
            state: 'current' as const,
            scanStartedAt: 100,
            nextRetryAt: null,
        };
        const reconcilingCatalogStatus = {
            observedRevision: '8',
            adoptedRevision: '7',
            state: 'reconciling' as const,
            scanStartedAt: 200,
            nextRetryAt: 300,
        };
        harness.get().applyAutomations([createAutomationDefinitionFromDetail({
            ...eventDefinitionDetail,
            triggers: eventDefinitionDetail.triggers.map((trigger) => ({ ...trigger, sourceCatalogStatus: currentCatalogStatus })),
        })]);
        harness.get().applyAutomations([createAutomationDefinitionSummary({
            ...eventDefinitionSummary,
            triggers: eventDefinitionSummary.triggers.map((trigger) => ({ ...trigger, sourceCatalogStatus: reconcilingCatalogStatus })),
        })]);

        expect(harness.get().automations['event-1']).toMatchObject({
            triggers: [expect.objectContaining({ sourceCatalogStatus: reconcilingCatalogStatus })],
            detail: {
                kind: 'available',
                value: {
                    triggers: [expect.objectContaining({
                        sourceCatalogStatus: reconcilingCatalogStatus,
                        triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
                    })],
                },
            },
        });
    });

    it('drops a retained direct detail when a same-revision list snapshot changes its Event source identity', () => {
        const harness = createHarness();
        harness.get().applyAutomations([createAutomationDefinitionFromDetail(eventDefinitionDetail)]);
        harness.get().applyAutomations([createAutomationDefinitionSummary({
            ...eventDefinitionSummary,
            existingSessionId: null,
            triggers: eventDefinitionSummary.triggers.map((trigger) => ({
                ...trigger,
                sourceSelectorId: '22222222-2222-4222-8222-222222222222',
            })),
        })]);

        expect(harness.get().automations['event-1']?.detail).toEqual({
            kind: 'unloaded',
            templateVersion: 3,
        });
        expect(harness.get().automations['event-1']?.linkedExistingSessionId).toBeNull();
    });

    it('does not keep a fail-closed content marker when a same-revision list snapshot changes its Event source identity', () => {
        const harness = createHarness();
        harness.get().applyAutomations([
            markAutomationDefinitionContentUnavailable(
                createAutomationDefinitionSummary(eventDefinitionSummary),
            ),
        ]);
        harness.get().applyAutomations([createAutomationDefinitionSummary({
            ...eventDefinitionSummary,
            triggers: eventDefinitionSummary.triggers.map((trigger) => ({
                ...trigger,
                sourceSelectorId: '22222222-2222-4222-8222-222222222222',
            })),
        })]);

        expect(harness.get().automations['event-1']?.detail).toEqual({
            kind: 'unloaded',
            templateVersion: 3,
        });
    });

    it('upserts and removes automations', () => {
        const harness = createHarness();
        harness.get().upsertAutomation(automation({ id: 'a1', name: 'Nightly' }));
        expect(harness.get().automations.a1?.name).toBe('Nightly');

        harness.get().upsertAutomation(automation({ id: 'a1', name: 'Hourly', updatedAt: 2 }));
        expect(harness.get().automations.a1?.name).toBe('Hourly');

        harness.get().removeAutomation('a1');
        expect(harness.get().automations.a1).toBeUndefined();
    });

    it('tracks runs per automation and keeps newest first', () => {
        const harness = createHarness();
        harness.get().setAutomationRuns('a1', [
            run({ id: 'r1', automationId: 'a1', dueAt: 10 }),
            run({ id: 'r2', automationId: 'a1', dueAt: 20 }),
        ], null);

        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r2', 'r1']);

        harness.get().upsertAutomationRun(
            run({ id: 'r3', automationId: 'a1', dueAt: 30, state: 'running' }),
        );
        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r3', 'r2', 'r1']);

        harness.get().upsertAutomationRun(
            run({ id: 'r2', automationId: 'a1', dueAt: 40, state: 'succeeded' }),
        );
        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r2', 'r3', 'r1']);
        expect(harness.get().automationRunsByAutomationId.a1?.[0]?.state).toBe('succeeded');
    });

    it('orders Event runs by their safe occurrence time instead of incidental update churn', () => {
        const harness = createHarness();
        harness.get().setAutomationRuns('event-1', [
            pluginEventRun({ id: 'older-occurrence', occurredAt: 100, updatedAt: 10_000 }),
            pluginEventRun({ id: 'newer-occurrence', occurredAt: 200, updatedAt: 1 }),
        ], null);

        expect(harness.get().automationRunsByAutomationId['event-1']?.map((entry) => entry.id)).toEqual([
            'newer-occurrence',
            'older-occurrence',
        ]);
    });

    it('continues only the current opaque run-history cursor and deduplicates an overlapping page', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;
        domain.setAutomationRuns('a1', [
            run({ id: 'r3', automationId: 'a1', dueAt: 30, state: 'running' }),
            run({ id: 'r2', automationId: 'a1', dueAt: 20 }),
        ], 'cursor-1');

        domain.appendAutomationRuns('a1', 'stale-cursor', [
            run({ id: 'r1', automationId: 'a1', dueAt: 10 }),
        ], 'cursor-2');
        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r3', 'r2']);
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1).toBe('cursor-1');

        domain.appendAutomationRuns('a1', 'cursor-1', [
            run({ id: 'r2', automationId: 'a1', dueAt: 20, state: 'succeeded', updatedAt: 2 }),
            run({ id: 'r1', automationId: 'a1', dueAt: 10 }),
        ], null);

        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id)).toEqual(['r3', 'r2', 'r1']);
        expect(harness.get().automationRunsByAutomationId.a1?.[1]?.state).toBe('succeeded');
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1).toBeNull();
    });

    it('removes run cache when automation is removed', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;
        harness.get().upsertAutomation(automation({ id: 'a1' }));
        domain.setAutomationRuns('a1', [run({ id: 'r1', automationId: 'a1' })], 'cursor-1');

        harness.get().removeAutomation('a1');
        expect(harness.get().automationRunsByAutomationId.a1).toBeUndefined();
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1).toBeUndefined();
    });

    it('keeps traversing past the passive window and reports the server continuation verbatim', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;
        const max = loadSyncTuning().automationRunsMaxEntriesPerAutomation;

        domain.setAutomationRuns(
            'a1',
            Array.from({ length: max }, (_, index) =>
                run({ id: `r${index + 1}`, automationId: 'a1', dueAt: max - index }),
            ),
            'cursor-1',
        );
        // The page the reader explicitly asked for is older than everything
        // already retained. The passive newest-first ceiling must not decide
        // that the server ran out of history.
        domain.appendAutomationRuns(
            'a1',
            'cursor-1',
            [run({ id: 'older-1', automationId: 'a1', dueAt: 0 })],
            'cursor-2',
        );

        expect(harness.get().automationRunsByAutomationId.a1?.some((entry) => entry.id === 'older-1'))
            .toBe(true);
        expect(harness.get().automationRunsByAutomationId.a1?.at(-1)?.id).toBe('older-1');
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1)
            .toBe('cursor-2');
        // A server that really is exhausted still terminates the traversal.
        domain.appendAutomationRuns(
            'a1',
            'cursor-2',
            [run({ id: 'older-2', automationId: 'a1', dueAt: 0 })],
            null,
        );
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1).toBeNull();
    });

    it('does not let a single run update evict an explicitly traversed run window', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;
        const max = loadSyncTuning().automationRunsMaxEntriesPerAutomation;

        domain.setAutomationRuns(
            'a1',
            Array.from({ length: max }, (_, index) =>
                run({ id: `r${index + 1}`, automationId: 'a1', dueAt: max - index }),
            ),
            'cursor-1',
        );
        domain.appendAutomationRuns(
            'a1',
            'cursor-1',
            [run({ id: 'older-1', automationId: 'a1', dueAt: 0 })],
            'cursor-2',
        );
        expect(harness.get().automationRunsByAutomationId.a1).toHaveLength(max + 1);

        harness.get().upsertAutomationRun(
            run({ id: 'r1', automationId: 'a1', dueAt: max, state: 'succeeded', updatedAt: 99 }),
        );

        expect(harness.get().automationRunsByAutomationId.a1).toHaveLength(max + 1);
        expect(harness.get().automationRunsByAutomationId.a1?.some((entry) => entry.id === 'older-1'))
            .toBe(true);
        expect(harness.get().automationRunsByAutomationId.a1?.[0]?.state).toBe('succeeded');
    });

    it('keeps advancing the run cursor while fetched older pages stay inside the bounded window', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;

        domain.setAutomationRuns(
            'a1',
            [run({ id: 'r1', automationId: 'a1', dueAt: 10 })],
            'cursor-1',
        );
        domain.appendAutomationRuns(
            'a1',
            'cursor-1',
            [run({ id: 'older-1', automationId: 'a1', dueAt: 5 })],
            'cursor-2',
        );

        expect(harness.get().automationRunsByAutomationId.a1?.map((entry) => entry.id))
            .toEqual(['r1', 'older-1']);
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1)
            .toBe('cursor-2');
    });

    it('does not rewind an explicitly traversed run window when a background list refresh restates the newest page', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;

        // The reader opened the Automation (one server page) and then paged.
        domain.setAutomationRuns(
            'a1',
            Array.from({ length: 20 }, (_unused, index) =>
                run({ id: `r${index + 1}`, automationId: 'a1', dueAt: 1000 - index }),
            ),
            'cursor-page-1',
        );
        domain.appendAutomationRuns(
            'a1',
            'cursor-page-1',
            Array.from({ length: 20 }, (_unused, index) =>
                run({ id: `r${index + 21}`, automationId: 'a1', dueAt: 980 - index }),
            ),
            'cursor-page-2',
        );
        expect(harness.get().automationRunsByAutomationId.a1).toHaveLength(40);

        // Any Automation socket update refreshes every cached run list with the
        // newest page and that page's continuation.
        domain.refreshAutomationRunsWindow(
            'a1',
            [
                run({ id: 'r-new', automationId: 'a1', dueAt: 1001 }),
                ...Array.from({ length: 19 }, (_unused, index) =>
                    run({ id: `r${index + 1}`, automationId: 'a1', dueAt: 1000 - index }),
                ),
            ],
            'cursor-page-1-refreshed',
        );

        const traversed = harness.get().automationRunsByAutomationId.a1 ?? [];
        expect(traversed).toHaveLength(41);
        expect(traversed[0]?.id).toBe('r-new');
        expect(traversed.at(-1)?.id).toBe('r40');
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1)
            .toBe('cursor-page-2');
    });

    it('re-seeds a run window the reader never paged so a background refresh still delivers new Runs and the current continuation', () => {
        const harness = createHarness();
        const domain = harness.get() as PaginatedRunsState;

        domain.setAutomationRuns(
            'a1',
            Array.from({ length: 20 }, (_unused, index) =>
                run({ id: `r${index + 1}`, automationId: 'a1', dueAt: 1000 - index }),
            ),
            'cursor-page-1',
        );

        domain.refreshAutomationRunsWindow(
            'a1',
            [
                run({ id: 'r-new', automationId: 'a1', dueAt: 1001 }),
                ...Array.from({ length: 19 }, (_unused, index) =>
                    run({ id: `r${index + 1}`, automationId: 'a1', dueAt: 1000 - index }),
                ),
            ],
            'cursor-page-1-refreshed',
        );

        const seeded = harness.get().automationRunsByAutomationId.a1 ?? [];
        expect(seeded).toHaveLength(20);
        expect(seeded[0]?.id).toBe('r-new');
        expect(seeded.at(-1)?.id).toBe('r19');
        expect((harness.get() as PaginatedRunsState).automationRunNextCursorByAutomationId.a1)
            .toBe('cursor-page-1-refreshed');
    });

    it('retains only bounded newest runs per automation', () => {
        const harness = createHarness();
        const max = loadSyncTuning().automationRunsMaxEntriesPerAutomation;

        harness.get().setAutomationRuns(
            'a1',
            Array.from({ length: max + 5 }, (_, index) =>
                run({ id: `r${index + 1}`, automationId: 'a1', dueAt: index + 1 }),
            ),
            null,
        );

        expect(harness.get().automationRunsByAutomationId.a1).toHaveLength(max);
        expect(harness.get().automationRunsByAutomationId.a1?.[0]?.id).toBe(`r${max + 5}`);
        expect(harness.get().automationRunsByAutomationId.a1?.at(-1)?.id).toBe('r6');
    });
});
