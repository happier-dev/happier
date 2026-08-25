import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    AutomationDefinitionDetailSchema,
    AutomationPluginEventDefinitionCreateRequestSchema,
    AutomationPluginEventDefinitionPatchRequestSchema,
    AutomationV3RunListItemSchema,
    AutomationV3RunDetailSchema,
    type AutomationDefinitionDetail,
    type AutomationPluginEventDefinitionCreateRequest,
    type AutomationPluginEventDefinitionPatchRequest,
    type AutomationV3Settings,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import {
    useAutomation,
    useAutomationRunNextCursor,
    useAutomationRuns,
    useAutomations,
} from '@/sync/domains/state/storage';

// Sync imports persistence, which instantiates MMKV. Keep this owner test
// deterministic without creating a second Account-lifetime fixture.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const retireLifetime = vi.hoisted(() => vi.fn());
const createPluginEventAutomationDefinition = vi.hoisted(() => vi.fn());
const updatePluginEventAutomationDefinition = vi.hoisted(() => vi.fn());
const getAutomationRunDetail = vi.hoisted(() => vi.fn());
const fetchAccountEncryptionCurrentness = vi.hoisted(() => vi.fn());
const cancelAutomationRun = vi.hoisted(() => vi.fn());
const deleteAutomationDefinition = vi.hoisted(() => vi.fn());
const runAutomationDefinitionNow = vi.hoisted(() => vi.fn());
const getAutomationSettings = vi.hoisted(() => vi.fn());
const updateAutomationSettings = vi.hoisted(() => vi.fn());
const clearAutomationRunHistory = vi.hoisted(() => vi.fn());
vi.mock('./domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => null,
    captureActiveServerAccountScopeLifetime: () => null,
    retireActiveServerAccountScopeLifetime: retireLifetime,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>();
    return {
        ...actual,
        fetchAccountEncryptionCurrentness,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
        emitWithAck: vi.fn(),
        send: vi.fn(),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

vi.mock('./api/automations/apiAutomations', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./api/automations/apiAutomations')>();
    return {
        ...actual,
        createPluginEventAutomationDefinition,
        updatePluginEventAutomationDefinition,
        getAutomationRunDetail,
        cancelAutomationRun,
        deleteAutomationDefinition,
        runAutomationDefinitionNow,
        getAutomationSettings,
        updateAutomationSettings,
        clearAutomationRunHistory,
    };
});

import { sync } from './sync';
import { storage } from './domains/state/storage';

/** Test-only view of the incumbent owner; production code never exposes this seam. */
type SyncResetOwnerTestSeam = {
    serverScopeGeneration: number;
    resetServerScopedRuntimeState(): void;
    projectAndUpsertAutomationDefinition(
        detail: AutomationDefinitionDetail,
        shouldContinue: () => boolean,
    ): Promise<unknown>;
} & {
    credentials: AuthCredentials | undefined;
    createPluginEventAutomationDefinition(
        input: AutomationPluginEventDefinitionCreateRequest,
    ): Promise<unknown>;
    updatePluginEventAutomationDefinition(
        automationId: string,
        input: AutomationPluginEventDefinitionPatchRequest,
    ): Promise<unknown>;
    getAutomationRunDetailInspection(automationId: string, runId: string): Promise<unknown>;
    cancelAutomationRun(runId: string): Promise<unknown>;
    deleteAutomation(automationId: string): Promise<void>;
    runAutomationNow(automationId: string): Promise<unknown>;
    getAutomationSettings(): Promise<AutomationV3Settings>;
    updateAutomationSettings(input: AutomationV3Settings): Promise<AutomationV3Settings>;
    clearAutomationRunHistory(automationId: string): Promise<unknown>;
    fetchAutomationRuns(automationId: string, limit?: number, cursor?: string): Promise<unknown>;
};

const eventCreateRequest = AutomationPluginEventDefinitionCreateRequestSchema.parse({
    name: 'Repository updates',
    description: 'Review incoming repository activity',
    enabled: true,
    trigger: {
        kind: 'pluginEvent',
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'repository-event-v1',
        },
        sourceInstanceId: 'github:repository:1234',
        sourceContractVersion: 1,
        sourceConfig: {
            repository: 'happier-dev/happier',
        },
        displayLabel: 'happier-dev/happier',
        observationTransport: {
            kind: 'checkpointedPull',
            watcherMaterializationRef: {
                machineId: 'machine-1',
                pluginId: 'happier.scm.github',
                materializationId: 'materialization-1',
            },
        },
        filter: null,
        maximumObservationAgeMs: 60_000,
    },
    executionRecipe: {
        v: 1,
        templateVersion: 3,
        template: {
            t: 'plain',
            v: {
                v: 1,
                prompt: 'Review {{input}}',
            },
        },
        triggerEvidence: null,
        target: {
            kind: 'existingSession',
            sessionId: 'session-event-1',
        },
    },
    assignments: [{ machineId: 'machine-1' }],
});

function eventDetail(templateVersion: number): AutomationDefinitionDetail {
    return AutomationDefinitionDetailSchema.parse({
        id: 'automation-event-owner',
        name: 'Repository updates',
        description: 'Review incoming repository activity',
        enabled: true,
        trigger: {
            kind: 'pluginEvent',
            eventRef: {
                pluginId: 'happier.scm.github',
                localId: 'repository-event-v1',
            },
            sourceSelectorId: 'selector-event-1',
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
        },
        targetType: 'existingSession',
        existingSessionId: 'session-event-1',
        templateVersion,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: templateVersion,
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: null }],
        triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
        executionRecipe: {
            ...eventCreateRequest.executionRecipe,
            templateVersion,
        },
    });
}

const eventRunDetail = AutomationV3RunDetailSchema.parse({
    id: 'automation-event-run-owner',
    automationId: 'automation-event-owner',
    state: 'queued',
    origin: {
        kind: 'pluginEvent',
        occurrenceKey: 'occurrence-event-owner',
        sourceSelectorId: 'selector-event-1',
        occurredAt: 1,
    },
    dueAt: 1,
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
    contentRemovedAt: null,
    createdAt: 1,
    updatedAt: 1,
    triggerEvidenceEnvelope: null,
    executionInputEnvelope: null,
    resultEnvelope: null,
    legacySummaryCiphertext: null,
    executionNativeRunId: null,
    executionNativeCallId: null,
    executionNativeSidechainId: null,
    events: [],
});

describe('Sync Server/Account lifetime reset boundary', () => {
    it('retires synchronously before advancing generation and never waits for consumer cleanup', () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const generationBeforeReset = owner.serverScopeGeneration;
        const unresolvedCleanup = new Promise<void>(() => {});
        retireLifetime.mockImplementation(() => {
            expect(owner.serverScopeGeneration).toBe(generationBeforeReset);
            // A losing implementation that awaits this thenable leaves the
            // generation unchanged at the assertion below.
            return unresolvedCleanup;
        });

        owner.resetServerScopedRuntimeState();

        expect(retireLifetime).toHaveBeenCalledTimes(1);
        expect(owner.serverScopeGeneration).toBe(generationBeforeReset + 1);
    });

    it('removes Automation definition, run history, and cursor from a retained route when its Server/Account scope retires', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        // The preceding synchronous-retirement discriminator deliberately
        // leaves its never-settling cleanup mock installed. This route-level
        // projection check needs the normal, synchronous lifecycle boundary.
        retireLifetime.mockReset();
        const previousState = storage.getState();
        const definition = createAutomationDefinitionFromDetail(eventDetail(3));
        const routeAutomationId = definition.id;
        const run = AutomationV3RunListItemSchema.parse({
            id: eventRunDetail.id,
            automationId: eventRunDetail.automationId,
            state: eventRunDetail.state,
            origin: eventRunDetail.origin,
            dueAt: eventRunDetail.dueAt,
            claimedAt: eventRunDetail.claimedAt,
            startedAt: eventRunDetail.startedAt,
            finishedAt: eventRunDetail.finishedAt,
            claimedByMachineId: eventRunDetail.claimedByMachineId,
            leaseExpiresAt: eventRunDetail.leaseExpiresAt,
            attempt: eventRunDetail.attempt,
            errorCode: eventRunDetail.errorCode,
            producedSessionId: eventRunDetail.producedSessionId,
            executionDispatchState: eventRunDetail.executionDispatchState,
            executionAttempt: eventRunDetail.executionAttempt,
            replyHandoffState: eventRunDetail.replyHandoffState,
            replyHandoffAttempt: eventRunDetail.replyHandoffAttempt,
            replyHandoffDueAt: eventRunDetail.replyHandoffDueAt,
            contentRemovedAt: eventRunDetail.contentRemovedAt,
            createdAt: eventRunDetail.createdAt,
            updatedAt: eventRunDetail.updatedAt,
        });

        try {
            storage.setState({
                ...previousState,
                isDataReady: true,
                automations: { [definition.id]: definition },
                automationRunsByAutomationId: { [definition.id]: [run] },
                automationRunNextCursorByAutomationId: { [definition.id]: 'older-runs' },
            });

            const hook = await renderHook(() => ({
                all: useAutomations().map((automation) => automation.id),
                definition: useAutomation(routeAutomationId)?.id ?? null,
                runs: useAutomationRuns(routeAutomationId).map((automationRun) => automationRun.id),
                nextCursor: useAutomationRunNextCursor(routeAutomationId),
            }));
            try {
                expect(hook.getCurrent()).toEqual({
                    all: [definition.id],
                    definition: definition.id,
                    runs: [run.id],
                    nextCursor: 'older-runs',
                });

                await act(async () => {
                    owner.resetServerScopedRuntimeState();
                });

                expect(hook.getCurrent()).toEqual({
                    all: [],
                    definition: null,
                    runs: [],
                    nextCursor: null,
                });
                expect(storage.getState().automations).toEqual({});
                expect(storage.getState().automationRunsByAutomationId).toEqual({});
                expect(storage.getState().automationRunNextCursorByAutomationId).toEqual({});
            } finally {
                await hook.unmount();
            }
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not return a direct Automation definition after its server-account scope expires', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        let scopeCurrent = true;
        const detail = {
            id: 'automation-stale-scope',
            name: 'Stale scope',
            description: null,
            enabled: true,
            trigger: {
                kind: 'schedule',
                schedule: {
                    kind: 'interval',
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                },
            },
            targetType: 'newSession',
            existingSessionId: null,
            templateVersion: 1,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
            triggerDefinitionEnvelope: null,
            templateCiphertext: '{"t":"plain","v":{"directory":"/repo"}}',
        } satisfies AutomationDefinitionDetail;

        const operation = owner.projectAndUpsertAutomationDefinition(detail, () => scopeCurrent);
        scopeCurrent = false;

        await expect(operation).rejects.toThrow('Automation server-account scope changed');
    });

    it('projects strict Event create and versioned patch results through the incumbent Automation store owner', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-event-owner', secret: 'secret-event-owner' };
        const previousCredentials = owner.credentials;
        const createdDetail = eventDetail(3);
        const updatedDetail = eventDetail(4);
        const patchRequest = AutomationPluginEventDefinitionPatchRequestSchema.parse({
            ...eventCreateRequest,
            expectedTemplateVersion: 3,
            executionRecipe: {
                ...eventCreateRequest.executionRecipe,
                templateVersion: 4,
            },
        });
        createPluginEventAutomationDefinition.mockReset();
        updatePluginEventAutomationDefinition.mockReset();
        createPluginEventAutomationDefinition.mockResolvedValue(createdDetail);
        updatePluginEventAutomationDefinition.mockResolvedValue(updatedDetail);
        owner.credentials = credentials;

        try {
            const created = await owner.createPluginEventAutomationDefinition(eventCreateRequest);
            const updated = await owner.updatePluginEventAutomationDefinition(createdDetail.id, patchRequest);

            expect(createPluginEventAutomationDefinition).toHaveBeenCalledWith(credentials, eventCreateRequest);
            expect(updatePluginEventAutomationDefinition).toHaveBeenCalledWith(
                credentials,
                createdDetail.id,
                patchRequest,
            );
            expect(created).toMatchObject({
                id: createdDetail.id,
                detail: {
                    kind: 'available',
                    templateVersion: 3,
                },
                linkedExistingSessionId: 'session-event-1',
            });
            expect(updated).toMatchObject({
                id: updatedDetail.id,
                detail: {
                    kind: 'available',
                    templateVersion: 4,
                },
                linkedExistingSessionId: 'session-event-1',
            });
        } finally {
            owner.credentials = previousCredentials;
        }
    });

    it('fences a direct Run-detail inspection when its server-account scope changes', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-event-run', secret: 'secret-event-run' };
        const previousCredentials = owner.credentials;
        const previousGeneration = owner.serverScopeGeneration;
        let resolveRead: (value: typeof eventRunDetail) => void = () => {
            throw new Error('Direct Run detail test promise did not initialize');
        };
        const pendingRead = new Promise<typeof eventRunDetail>((resolve) => {
            resolveRead = resolve;
        });
        getAutomationRunDetail.mockReset();
        getAutomationRunDetail.mockReturnValue(pendingRead);
        owner.credentials = credentials;

        try {
            const operation = owner.getAutomationRunDetailInspection(
                eventRunDetail.automationId,
                eventRunDetail.id,
            );
            owner.serverScopeGeneration = previousGeneration + 1;
            resolveRead(eventRunDetail);

            await expect(operation).rejects.toThrow('Automation server-account scope changed');
            expect(getAutomationRunDetail).toHaveBeenCalledWith(
                credentials,
                eventRunDetail.automationId,
                eventRunDetail.id,
            );
        } finally {
            owner.credentials = previousCredentials;
            owner.serverScopeGeneration = previousGeneration;
        }
    });

    it('returns route-local currentness unavailability without writing private Run detail into the cache', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-event-run-inspection', secret: 'secret-event-run-inspection' };
        const previousCredentials = owner.credentials;
        getAutomationRunDetail.mockReset();
        getAutomationRunDetail.mockResolvedValue(eventRunDetail);
        fetchAccountEncryptionCurrentness.mockReset();
        fetchAccountEncryptionCurrentness.mockRejectedValue(new Error('currentness unavailable'));
        owner.credentials = credentials;

        try {
            await expect(owner.getAutomationRunDetailInspection(
                eventRunDetail.automationId,
                eventRunDetail.id,
            )).resolves.toEqual({
                detail: eventRunDetail,
                privateContent: {
                    recipe: { kind: 'unavailable', reason: 'currentnessUnavailable' },
                    result: { kind: 'unavailable', reason: 'currentnessUnavailable' },
                    failureDetail: { kind: 'unavailable', reason: 'currentnessUnavailable' },
                },
            });
            expect(getAutomationRunDetail).toHaveBeenCalledWith(
                credentials,
                eventRunDetail.automationId,
                eventRunDetail.id,
            );
            expect(fetchAccountEncryptionCurrentness).toHaveBeenCalledWith(credentials);
        } finally {
            owner.credentials = previousCredentials;
        }
    });

    it('projects a current cancellation through the incumbent Automation Run cache owner', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-event-run-cancel', secret: 'secret-event-run-cancel' };
        const previousCredentials = owner.credentials;
        const cancelledRun = {
            ...eventRunDetail,
            state: 'cancelled' as const,
            finishedAt: 2,
            updatedAt: 2,
        };
        cancelAutomationRun.mockReset();
        cancelAutomationRun.mockResolvedValue(cancelledRun);
        owner.credentials = credentials;

        try {
            await expect(owner.cancelAutomationRun(eventRunDetail.id)).resolves.toMatchObject({
                id: eventRunDetail.id,
                state: 'cancelled',
            });
            expect(cancelAutomationRun).toHaveBeenCalledWith(credentials, eventRunDetail.id);
        } finally {
            owner.credentials = previousCredentials;
        }
    });

    it('keeps account Automation settings direct and refreshes the canonical Run projection after clearing history', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-automation-settings', secret: 'secret-automation-settings' };
        const previousCredentials = owner.credentials;
        const settings: AutomationV3Settings = {
            maxActiveRunsPerMachine: 4,
            runRetention: 'thirtyDays',
        };
        const fetchRuns = vi.spyOn(owner, 'fetchAutomationRuns').mockResolvedValue({ nextCursor: null });
        getAutomationSettings.mockReset();
        getAutomationSettings.mockResolvedValue(settings);
        updateAutomationSettings.mockReset();
        updateAutomationSettings.mockResolvedValue({
            maxActiveRunsPerMachine: 2,
            runRetention: 'keepForever',
        });
        clearAutomationRunHistory.mockReset();
        clearAutomationRunHistory.mockResolvedValue({ clearedRuns: 3 });
        owner.credentials = credentials;

        try {
            await expect(owner.getAutomationSettings()).resolves.toEqual(settings);
            await expect(owner.updateAutomationSettings(settings)).resolves.toEqual({
                maxActiveRunsPerMachine: 2,
                runRetention: 'keepForever',
            });
            await expect(owner.clearAutomationRunHistory('automation-event-1')).resolves.toEqual({ clearedRuns: 3 });

            expect(getAutomationSettings).toHaveBeenCalledWith(credentials);
            expect(updateAutomationSettings).toHaveBeenCalledWith(credentials, settings);
            expect(clearAutomationRunHistory).toHaveBeenCalledWith(credentials, 'automation-event-1');
            expect(fetchRuns).toHaveBeenCalledWith('automation-event-1');
        } finally {
            owner.credentials = previousCredentials;
            fetchRuns.mockRestore();
        }
    });

    it('does not refresh a different account Run projection after clear-history loses currentness', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-automation-clear-stale', secret: 'secret-automation-clear-stale' };
        const previousCredentials = owner.credentials;
        const previousGeneration = owner.serverScopeGeneration;
        let resolveClear: (result: { clearedRuns: number }) => void = () => {
            throw new Error('Clear-history test promise did not initialize');
        };
        const pendingClear = new Promise<{ clearedRuns: number }>((resolve) => {
            resolveClear = resolve;
        });
        const fetchRuns = vi.spyOn(owner, 'fetchAutomationRuns').mockResolvedValue({ nextCursor: null });
        clearAutomationRunHistory.mockReset();
        clearAutomationRunHistory.mockReturnValue(pendingClear);
        owner.credentials = credentials;

        try {
            const operation = owner.clearAutomationRunHistory('automation-event-1');
            owner.serverScopeGeneration = previousGeneration + 1;
            resolveClear({ clearedRuns: 3 });

            await expect(operation).rejects.toThrow('Automation server-account scope changed');
            expect(fetchRuns).not.toHaveBeenCalled();
        } finally {
            owner.credentials = previousCredentials;
            owner.serverScopeGeneration = previousGeneration;
            fetchRuns.mockRestore();
        }
    });

    it('does not remove an Automation after the delete request Server/Account scope expires', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-event-delete', secret: 'secret-event-delete' };
        const previousCredentials = owner.credentials;
        const previousGeneration = owner.serverScopeGeneration;
        let resolveDelete: () => void = () => {
            throw new Error('Automation delete test promise did not initialize');
        };
        const pendingDelete = new Promise<void>((resolve) => {
            resolveDelete = resolve;
        });
        const removeAutomation = vi.spyOn(storage.getState(), 'removeAutomation');
        deleteAutomationDefinition.mockReset();
        deleteAutomationDefinition.mockReturnValue(pendingDelete);
        owner.credentials = credentials;

        try {
            const operation = owner.deleteAutomation('automation-event-owner');
            owner.serverScopeGeneration = previousGeneration + 1;
            resolveDelete();

            await expect(operation).rejects.toThrow('Automation server-account scope changed');
            expect(removeAutomation).not.toHaveBeenCalled();
        } finally {
            removeAutomation.mockRestore();
            owner.credentials = previousCredentials;
            owner.serverScopeGeneration = previousGeneration;
        }
    });

    it('does not cache a run-now response after its Server/Account scope expires', async () => {
        const owner = sync as unknown as SyncResetOwnerTestSeam;
        const credentials: AuthCredentials = { token: 'token-event-run-now', secret: 'secret-event-run-now' };
        const previousCredentials = owner.credentials;
        const previousGeneration = owner.serverScopeGeneration;
        let resolveRun: (value: typeof eventRunDetail) => void = () => {
            throw new Error('Automation run-now test promise did not initialize');
        };
        const pendingRun = new Promise<typeof eventRunDetail>((resolve) => {
            resolveRun = resolve;
        });
        const upsertAutomationRun = vi.spyOn(storage.getState(), 'upsertAutomationRun');
        runAutomationDefinitionNow.mockReset();
        runAutomationDefinitionNow.mockReturnValue(pendingRun);
        owner.credentials = credentials;

        try {
            const operation = owner.runAutomationNow('automation-event-owner');
            owner.serverScopeGeneration = previousGeneration + 1;
            resolveRun(eventRunDetail);

            await expect(operation).rejects.toThrow('Automation server-account scope changed');
            expect(upsertAutomationRun).not.toHaveBeenCalled();
        } finally {
            upsertAutomationRun.mockRestore();
            owner.credentials = previousCredentials;
            owner.serverScopeGeneration = previousGeneration;
        }
    });
});
