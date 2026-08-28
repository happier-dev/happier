import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationDefinitionDetailSchema,
    AutomationTriggerIdSchema,
    AutomationTriggerListItemSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventSourceCatalogStatus,
    type AutomationEventSourceStatusV1,
    type AutomationTriggerListItem,
} from '@happier-dev/protocol';
import {
    createCapturingLegendListMock,
    findTestInstanceByTypeContainingText,
    pressTestInstance,
    renderScreen,
} from '@/dev/testkit';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

type AutomationScreenFixture = {
    id: string;
    name: string;
    enabled: boolean;
    description: string | null;
    triggers: AutomationTriggerListItem[];
    retiredTriggers: Array<{
        id: string;
        kind: 'schedule' | 'pluginEvent' | 'sessionLifecycle';
        revision: number;
        retiredAt: number;
    }>;
    targetType: 'newSession' | 'existingSession' | 'executionRun';
    existingSessionId: string | null;
    templateVersion: number;
    detail:
        | { kind: 'unloaded'; templateVersion: number }
        | { kind: 'available'; templateVersion: number; value: unknown }
        | { kind: 'unavailable'; templateVersion: number; code: string };
    linkedExistingSessionId: string | null;
    assignments: Array<{ machineId: string; enabled: boolean; priority: number }>;
};

type FetchAutomationRuns = (
    automationId: string,
    limit?: number,
    cursor?: string,
) => Promise<{ nextCursor: string | null }>;

type EventTriggerFixture = Extract<AutomationTriggerListItem, Readonly<{ kind: 'pluginEvent' }>>;

function eventTriggerFixture(
    overrides: Partial<EventTriggerFixture> = {},
): EventTriggerFixture {
    return AutomationTriggerListItemSchema.parse({
        id: AutomationTriggerIdSchema.parse('event-trigger-1'),
        revision: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'pluginEvent',
        eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
        sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111'),
        sourceContractVersion: 1,
        observation: { kind: 'checkpointedPull', watcher: null },
        sourceStatus: null,
        sourceCatalogStatus: null,
        ...overrides,
    });
}

function eventSourceStatusFixture(
    overrides: Partial<AutomationEventSourceStatusV1> = {},
): AutomationEventSourceStatusV1 {
    return {
        automationId: 'a1',
        triggerId: AutomationTriggerIdSchema.parse('event-trigger-1'),
        triggerRevision: 1,
        eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
        sourceSelectorId: '11111111-1111-4111-8111-111111111111',
        reporterMaterializationRef: {
            pluginId: 'happier.scm.github',
            machineId: 'watcher-machine',
            materializationId: 'github-materialization',
        },
        reporterImmutableGenerationId: 'github-generation-1',
        state: 'observing',
        code: null,
        lastObservedAt: 1,
        lastDispositionAt: 2,
        nextRetryAt: null,
        observedCount: 4,
        admittedCount: 5,
        skippedCount: 6,
        revision: 7,
        ...overrides,
    };
}

function eventSourceCatalogStatusFixture(
    overrides: Partial<AutomationEventSourceCatalogStatus> = {},
): AutomationEventSourceCatalogStatus {
    return {
        reporterImmutableGenerationId: 'github-generation-1',
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: null,
        nextRetryAt: null,
        ...overrides,
    };
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runHistoryListMock = createCapturingLegendListMock({ renderItems: true });

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const routeParamsState = vi.hoisted(() => ({ id: 'a1' }));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));
const eventRuntimeProjectionState = vi.hoisted(() => ({
    immutableGenerationId: 'github-generation-1',
}));
const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    refreshAutomationDefinitionDetail: vi.fn(async () => {}),
    fetchAutomationRuns: vi.fn<FetchAutomationRuns>(async () => ({ nextCursor: null })),
    runAutomationNow: vi.fn(async () => {}),
    pauseAutomation: vi.fn(async () => {}),
    resumeAutomation: vi.fn(async () => {}),
    deleteAutomation: vi.fn(async () => {}),
    clearAutomationRunHistory: vi.fn(async () => ({ clearedRuns: 0 })),
    replaceAutomationAssignments: vi.fn(async () => {}),
}));
const automationState = vi.hoisted(() => ({
    automation: {
        id: 'a1',
        name: 'Nightly',
        enabled: true,
        description: null as string | null,
        triggers: [{
            id: 'schedule-trigger-1', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
            kind: 'schedule' as const,
            schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null, timezone: null as string | null },
            nextRunAt: null,
        }],
        retiredTriggers: [] as AutomationScreenFixture['retiredTriggers'],
        targetType: 'newSession' as const,
        existingSessionId: null as string | null,
        templateVersion: 1,
        detail: { kind: 'unloaded' as const, templateVersion: 1 },
        linkedExistingSessionId: null as string | null,
        assignments: [] as Array<{ machineId: string; enabled: boolean; priority: number }>,
    },
    missing: false,
}));
const machinesState = vi.hoisted(() => ({
    list: [] as Array<{
        id: string;
        active?: boolean;
        activeAt?: number;
        revokedAt?: number | null;
        installationId?: string | null;
        metadata?: { displayName?: string; host?: string; platform?: string };
    }>,
}));
const automationRunCursorState = vi.hoisted(() => ({
    nextCursor: null as string | null,
}));
const automationRunsState = vi.hoisted(() => ({
    list: [] as any[],
}));

installAutomationScreensCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushSpy, back: routerBackSpy, replace: routerReplaceSpy },
            params: () => ({ id: routeParamsState.id }),
        });
        return expoRouterMock.module;
    },
    text: {
        translate: (key: string, params?: Record<string, unknown>) => {
            const labels: Record<string, string> = {
                'automations.detail.runNowTitle': 'Run now',
                'automations.detail.loadMoreRuns': 'Load more runs',
                'automations.detail.editAutomation': 'Edit automation',
                'automations.detail.deleteAutomation': 'Delete automation',
                'automations.detail.machineAssignmentsTitle': 'Machine assignments',
                'automations.detail.event.watcherTitle': 'Observation watcher',
                'automations.detail.event.watcherUnwatched': 'Unwatched',
                'automations.detail.event.watcherMachineUnknown': 'This machine is no longer in your account, so this watcher cannot observe events.',
                'automations.detail.event.watcherMachineRevoked': 'This machine was revoked, so this watcher cannot observe events.',
                'automations.detail.event.watcherMachineReplaced': 'This machine was replaced, so this watcher cannot observe events.',
                'automations.detail.event.watcherInstallationReplaced': 'This machine was reinstalled, so this watcher cannot observe events until it is set up again.',
                'automations.detail.event.watcherMachineOffline': 'This machine is offline, so this watcher is not observing events right now.',
                'settingsPlugins.eventAutomationComposer.sourceStatusTitle': 'Observation source',
                'settingsPlugins.eventAutomationComposer.sourceCatalogStatusTitle': 'Catalog reconciliation',
                'automations.detail.event.endpointTitle': 'Webhook endpoint',
                'automations.detail.event.sourceStatusUnreported': 'Waiting for the first report',
                'automations.detail.event.sourceCatalogStatusUnavailable': 'Source currentness unavailable',
                'automations.detail.runDetail.sourceInstance': 'Source instance',
                'automations.detail.runDetail.filter': 'Filter',
                'automations.detail.runDetail.target': 'Frozen target',
                'automations.detail.runDetail.outputCeiling': 'Output limit',
                'automations.detail.runDetail.executionRun': `Execution run · ${String(params?.permissionMode ?? '')}`,
                'automations.detail.event.sourceStatusUnavailable': 'Source status unavailable',
                'settingsPlugins.eventAutomationComposer.sourceStatusState.observing': 'Observing',
                'settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.current': 'Current',
                'settingsPlugins.eventAutomationComposer.sourceStatusState.backingOff': 'Waiting to retry',
                'settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.reconciliationLate': 'Reconciliation delayed',
                'settingsPlugins.eventAutomationComposer.sourceStatusCode.rateLimited': 'Rate limited',
                'automations.detail.runMeta.cause.pluginEvent': 'Event',
                'automations.detail.runMeta.triggerRetired': 'Trigger retired',
                'automations.detail.trigger.status.running': 'Running from this turn',
                'automations.detail.trigger.run': 'Matching run',
                'automations.detail.trigger.sourceSession': 'Source session',
                'automations.detail.trigger.sourceTurn': 'Exact source turn',
                'automations.detail.runMeta.state.queued': 'Queued',
                'automations.detail.runMeta.state.claimed': 'Claimed',
                'automations.detail.runMeta.state.running': 'Running',
                'automations.detail.runMeta.state.succeeded': 'Succeeded',
                'automations.detail.runMeta.state.failed': 'Failed',
                'automations.detail.runMeta.state.cancelled': 'Cancelled',
                'automations.detail.runMeta.state.expired': 'Expired',
                'automations.detail.runMeta.state.dispatch_failed': 'Dispatch failed',
                'automations.detail.runMeta.state.skipped': 'Skipped',
                'automations.detail.runMeta.state.missed': 'Missed',
                'automations.detail.runMeta.state.outcome_uncertain': 'Outcome uncertain',
                'automations.list.event': 'Event: pull-request-opened-v1',
                'status.online': 'online',
                'status.offline': 'offline',
            };
            if (key === 'automations.detail.event.endpointObservingSince') {
                return `Receiving deliveries since ${String(params?.time ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceStatusNextRetry') {
                return `Next retry: ${String(params?.time ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceStatusObservedCount') {
                return `Events observed: ${String(params?.count ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceStatusAdmittedCount') {
                return `Events admitted: ${String(params?.count ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceStatusSkippedCount') {
                return `Events skipped: ${String(params?.count ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceStatusLastObserved') {
                return `Last observed: ${String(params?.time ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceCatalogStatusObservedRevision') {
                return `Observed revision: ${String(params?.revision ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceCatalogStatusAdoptedRevision') {
                return `Adopted revision: ${String(params?.revision ?? '')}`;
            }
            if (key === 'settingsPlugins.eventAutomationComposer.sourceCatalogStatusScanStarted') {
                return `Scan started: ${String(params?.time ?? '')}`;
            }
            if (key === 'automations.detail.runMeta.triggerIdentity') {
                return `${String(params?.id ?? '')} · revision ${String(params?.revision ?? '')}`;
            }
            return labels[key] ?? key;
        },
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storage: async () => {
        const { createLiveStorageStoreMock, createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: createLiveStorageStoreMock(() => ({
                automationRunsByAutomationId: { a1: automationRunsState.list },
            })),
            useAutomation: () => (automationState.missing ? null : automationState.automation),
            useAutomationRuns: () => automationRunsState.list,
            useAutomationRunNextCursor: () => automationRunCursorState.nextCursor,
            useAllMachines: () => machinesState.list,
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#777',
                    text: '#111',
                    accent: { blue: '#0a84ff' },
                },
            },
        });
    },
});

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: 'ready',
        inputs: {
            automationEligibleEvents: [],
            pluginProjectionV2: {
                v: 2,
                generation: 1,
                installedPackagesById: {
                    'happier.scm.github': {
                        id: 'happier.scm.github',
                        displayName: 'GitHub',
                        version: '1.0.0',
                        enabled: true,
                        source: { kind: 'bundled', locator: '@happier-dev/plugins-scm-github' },
                        immutableGenerationId: eventRuntimeProjectionState.immutableGenerationId,
                    },
                },
                contributionIntrospection: { version: 1, generation: 1, contributions: [], diagnostics: [] },
            },
        },
    }),
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: '', generation: 1 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', props),
    // AutomationHistoryGapRecoveryAction reaches the shared Action/List row
    // path, which reads this real public sizing contract during module load.
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

// The detail surface owns one scroll container. Its history must go through
// the same canonical virtualized-list boundary as the Automation index rather
// than nesting a recycler inside the old ItemList scroll owner.
vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: any) => React.createElement(
        React.Fragment,
        null,
        props.ListHeaderComponent ?? null,
        React.createElement(runHistoryListMock.module.LegendList, {
            ...props,
            // The real list renders its header outside individual rows. Keep
            // it out of the host mock props too, so renderer JSON inspection
            // remains acyclic while the captured list data stays observable.
            ListHeaderComponent: null,
        }),
    ),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) =>
        React.createElement(
            'Pressable',
            {
                testID: props.testID,
                onPress: props.onPress,
                accessibilityRole: props.accessibilityRole,
                accessibilityLiveRegion: props.accessibilityLiveRegion,
                accessibilityLabel: props.title,
                subtitle: props.subtitle,
                detail: props.detail,
                disabled: props.disabled,
                loading: props.loading,
            },
            React.createElement('Text', null, props.title),
            props.rightElement ?? null,
        ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

describe('AutomationDetailScreen', () => {
    beforeEach(() => {
        eventRuntimeProjectionState.immutableGenerationId = 'github-generation-1';
        runHistoryListMock.state.reset();
        routeParamsState.id = 'a1';
        automationState.missing = false;
        automationState.automation = {
            id: 'a1',
            name: 'Nightly',
            enabled: true,
            description: null,
            triggers: [{
                id: 'schedule-trigger-1', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                kind: 'schedule',
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
                nextRunAt: null,
            }],
            retiredTriggers: [],
            targetType: 'newSession',
            existingSessionId: null,
            templateVersion: 1,
            detail: { kind: 'unloaded', templateVersion: 1 },
            linkedExistingSessionId: null,
            assignments: [],
        };
        machinesState.list = [];
        automationRunsState.list = [];
        automationRunCursorState.nextCursor = null;
        routerPushSpy.mockReset();
        routerBackSpy.mockReset();
        routerReplaceSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        modalAlertSpy.mockReset();
        syncSpies.deleteAutomation.mockReset();
        syncSpies.deleteAutomation.mockResolvedValue(undefined);
        syncSpies.clearAutomationRunHistory.mockReset();
        syncSpies.clearAutomationRunHistory.mockResolvedValue({ clearedRuns: 0 });
        syncSpies.refreshAutomations.mockReset();
        syncSpies.refreshAutomations.mockResolvedValue(undefined);
        syncSpies.refreshAutomationDefinitionDetail.mockReset();
        syncSpies.refreshAutomationDefinitionDetail.mockResolvedValue(undefined);
        syncSpies.fetchAutomationRuns.mockReset();
        syncSpies.fetchAutomationRuns.mockResolvedValue({ nextCursor: null });
        syncSpies.runAutomationNow.mockReset();
        syncSpies.runAutomationNow.mockResolvedValue(undefined);
        syncSpies.pauseAutomation.mockReset();
        syncSpies.pauseAutomation.mockResolvedValue(undefined);
        syncSpies.resumeAutomation.mockReset();
        syncSpies.resumeAutomation.mockResolvedValue(undefined);
        syncSpies.replaceAutomationAssignments.mockReset();
        syncSpies.replaceAutomationAssignments.mockResolvedValue(undefined);
    });

    function createDeferred<T = void>() {
        let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
        let reject: ((reason?: unknown) => void) | null = null;
        const promise = new Promise<T>((nextResolve, nextReject) => {
            resolve = nextResolve;
            reject = nextReject;
        });
        return {
            promise,
            resolve: (value?: T) => resolve?.(value as T),
            reject: (reason?: unknown) => reject?.(reason),
        };
    }

    function currentEventDefinitionForEditor(
        targetType: 'existingSession' | 'executionRun',
    ): AutomationScreenFixture {
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
            '11111111-1111-4111-8111-111111111111',
        );
        const target = targetType === 'existingSession'
            ? { kind: 'existingSession' as const, sessionId: 'session-existing' }
            : {
                kind: 'executionRun' as const,
                request: {
                    intent: 'task' as const,
                    backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
                    permissionMode: 'read_only' as const,
                    retentionPolicy: 'ephemeral' as const,
                    runClass: 'bounded' as const,
                    ioMode: 'request_response' as const,
                },
            };
        const detail = AutomationDefinitionDetailSchema.parse({
            id: 'a1',
            name: 'Nightly',
            description: null,
            enabled: true,
            triggers: [{
                id: 'event-trigger-1',
                revision: 1,
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
                kind: 'pluginEvent',
                eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
                sourceSelectorId,
                sourceContractVersion: 1,
                observation: {
                    kind: 'checkpointedPull',
                    watcher: {
                        machineId: 'watcher-machine',
                        machineInstallationId: 'watcher-installation',
                        pluginId: 'happier.scm.github',
                        materializationId: 'github-materialization',
                    },
                },
                sourceStatus: null,
                sourceCatalogStatus: null,
                triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: 'plain',
                    binding: {
                        v: 1,
                        automationId: 'a1',
                        triggerId: 'event-trigger-1',
                        triggerRevision: 1,
                        triggerKind: 'pluginEvent',
                        eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
                        sourceSelectorId,
                    },
                    definition: {
                        v: 1,
                        sourceInstanceId: 'repository:123',
                        sourceConfig: { repository: 'happier-dev/happier' },
                        displayLabel: 'happier-dev/happier',
                        filter: { v: 1, all: [{ op: 'eq', field: '/action', value: 'opened' }] },
                        maximumObservationAgeMs: null,
                    },
                })),
            }],
            targetType,
            existingSessionId: targetType === 'existingSession' ? 'session-existing' : null,
            templateVersion: 3,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
            retiredTriggers: [],
            executionRecipe: {
                v: 1,
                templateVersion: 3,
                template: { t: 'plain', v: { v: 1, prompt: 'Review {{input}}' } },
                triggerEvidence: null,
                target,
            },
        });
        return {
            id: 'a1',
            name: 'Nightly',
            enabled: true,
            description: null,
            triggers: detail.triggers,
            targetType,
            existingSessionId: targetType === 'existingSession' ? 'session-existing' : null,
            templateVersion: 3,
            detail: { kind: 'available', templateVersion: 3, value: detail },
            linkedExistingSessionId: targetType === 'existingSession' ? 'session-existing' : null,
            assignments: [],
        };
    }

    it('renders retired trigger tombstones as read-only history outside the live editor set', async () => {
        automationState.automation.retiredTriggers = [{
            id: 'retired-event-1',
            kind: 'pluginEvent',
            revision: 4,
            retiredAt: 9,
        }];
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');
        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        const retired = screen.findByProps({ testID: 'automation-retired-trigger-retired-event-1' });
        expect(retired.props.title).toBe('Event');
        expect(retired.props.subtitle).toContain('retired-event-1 · revision 4');
        expect(retired.props.onPress).toBeUndefined();
    });

    it('blurs the active element before navigating to edit automation', async () => {
        // The retained editor is available only for a direct V2-compatible schedule detail.
        automationState.automation = {
            ...automationState.automation,
            detail: {
                kind: 'available',
                templateVersion: 1,
                value: {
                    ...automationState.automation,
                    templateCiphertext: 'template',
                },
            },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const editButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation');
        await act(async () => {
            pressTestInstance(editButton, 'Edit automation');
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/edit',
            params: { id: 'a1' },
        });
    });

    it('loads direct Event detail through the incumbent owner and offers the shared plural editor', async () => {
        automationState.automation = {
            ...automationState.automation,
            triggers: [eventTriggerFixture()],
            templateVersion: 3,
            detail: { kind: 'unloaded', templateVersion: 3 },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledWith('a1');
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation')).toBeDefined();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Event: pull-request-opened-v1');
        const watcher = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation watcher',
        );
        expect(watcher?.props.detail).toBe('Unwatched');
    });

    it.each([
        {
            name: 'a machine that is no longer in the account',
            machines: [] as typeof machinesState.list,
            expected: 'This machine is no longer in your account, so this watcher cannot observe events.',
        },
        {
            name: 'a revoked machine',
            machines: [{
                id: 'watcher-machine',
                active: true,
                activeAt: Date.now(),
                revokedAt: 10,
                installationId: 'watcher-installation',
                metadata: { displayName: 'Build box' },
            }],
            expected: 'This machine was revoked, so this watcher cannot observe events.',
        },
        {
            name: 'a machine whose installation was replaced',
            machines: [{
                id: 'watcher-machine',
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                installationId: 'reinstalled-installation',
                metadata: { displayName: 'Build box' },
            }],
            expected: 'This machine was reinstalled, so this watcher cannot observe events until it is set up again.',
        },
        {
            name: 'an offline machine',
            machines: [{
                id: 'watcher-machine',
                active: false,
                activeAt: 1,
                revokedAt: null,
                installationId: 'watcher-installation',
                metadata: { displayName: 'Build box' },
            }],
            expected: 'This machine is offline, so this watcher is not observing events right now.',
        },
    ])('explains why a watcher on $name cannot observe', async ({ machines, expected }) => {
        machinesState.list = machines as typeof machinesState.list;
        automationState.automation = currentEventDefinitionForEditor('executionRun');
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        const watcher = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation watcher',
        );
        expect(watcher?.props.subtitle).toBe(expected);
    });

    it('leaves a current, online watcher unqualified', async () => {
        machinesState.list = [{
            id: 'watcher-machine',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            installationId: 'watcher-installation',
            metadata: { displayName: 'Build box' },
        }] as typeof machinesState.list;
        automationState.automation = currentEventDefinitionForEditor('executionRun');
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        const watcher = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation watcher',
        );
        expect(watcher?.props.detail).toBe('Build box');
        expect(watcher?.props.subtitle).toBeUndefined();
    });

    it.each([
        {
            name: 'an offline machine',
            machines: [{
                id: 'watcher-machine',
                active: false,
                activeAt: 1,
                revokedAt: null,
                installationId: 'watcher-installation',
                metadata: { displayName: 'Build box' },
            }],
            impediment: 'This machine is offline, so this watcher is not observing events right now.',
        },
        {
            name: 'a revoked machine',
            machines: [{
                id: 'watcher-machine',
                active: true,
                activeAt: Date.now(),
                revokedAt: 10,
                installationId: 'watcher-installation',
                metadata: { displayName: 'Build box' },
            }],
            impediment: 'This machine was revoked, so this watcher cannot observe events.',
        },
    ])('refuses to present a retained observing/current provider summary while the watcher on $name cannot observe', async ({ machines, impediment }) => {
        // The provider summaries describe the last report, not whether the
        // reporter is still running. Rendering them verbatim next to a watcher
        // that cannot observe tells the user a stopped source is healthy.
        machinesState.list = machines as typeof machinesState.list;
        const current = currentEventDefinitionForEditor('executionRun');
        automationState.automation = {
            ...current,
            triggers: current.triggers.map((trigger) => trigger.kind === 'pluginEvent'
                ? {
                    ...trigger,
                    sourceStatus: eventSourceStatusFixture(),
                    sourceCatalogStatus: eventSourceCatalogStatusFixture(),
                }
                : trigger),
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        const status = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation source',
        );
        const catalogStatus = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Catalog reconciliation',
        );
        expect(status?.props.detail).toBe('Source status unavailable');
        expect(status?.props.subtitle).toBe(impediment);
        expect(catalogStatus?.props.detail).toBe('Source currentness unavailable');
        expect(catalogStatus?.props.subtitle).toBe(impediment);
    });

    it('still presents the provider summaries verbatim while the watcher can observe', async () => {
        machinesState.list = [{
            id: 'watcher-machine',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            installationId: 'watcher-installation',
            metadata: { displayName: 'Build box' },
        }] as typeof machinesState.list;
        const current = currentEventDefinitionForEditor('executionRun');
        automationState.automation = {
            ...current,
            triggers: current.triggers.map((trigger) => trigger.kind === 'pluginEvent'
                ? {
                    ...trigger,
                    sourceStatus: eventSourceStatusFixture(),
                    sourceCatalogStatus: eventSourceCatalogStatusFixture(),
                }
                : trigger),
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        const status = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation source',
        );
        const catalogStatus = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Catalog reconciliation',
        );
        expect(status?.props.detail).toBe('Observing');
        expect(catalogStatus?.props.detail).toBe('Current');
    });

    it('does not present retained source health after the plugin generation is replaced', async () => {
        eventRuntimeProjectionState.immutableGenerationId = 'github-generation-2';
        machinesState.list = [{
            id: 'watcher-machine',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            installationId: 'watcher-installation',
            metadata: { displayName: 'Build box' },
        }] as typeof machinesState.list;
        const current = currentEventDefinitionForEditor('executionRun');
        automationState.automation = {
            ...current,
            triggers: current.triggers.map((trigger) => trigger.kind === 'pluginEvent'
                ? {
                    ...trigger,
                    sourceStatus: eventSourceStatusFixture(),
                    sourceCatalogStatus: eventSourceCatalogStatusFixture(),
                }
                : trigger),
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const status = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation source',
        );
        const catalogStatus = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Catalog reconciliation',
        );
        expect(status?.props.detail).toBe('Source status unavailable');
        expect(catalogStatus?.props.detail).toBe('Source currentness unavailable');
    });

    it('renders missing Event source and catalog status as explicit states rather than omitting the rows', async () => {
        automationState.automation = {
            ...automationState.automation,
            triggers: [eventTriggerFixture({ sourceStatus: null, sourceCatalogStatus: null })],
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const status = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation source',
        );
        const catalogStatus = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Catalog reconciliation',
        );
        expect(status?.props.detail).toBe('Waiting for the first report');
        expect(catalogStatus?.props.detail).toBe('Source currentness unavailable');
    });

    it('renders exact-turn lifecycle truth and its matching Run from the trigger projection', async () => {
        automationState.automation = {
            ...automationState.automation,
            triggers: [{
                id: 'turn-trigger-1',
                revision: 5,
                enabled: true,
                createdAt: 1,
                updatedAt: 2,
                kind: 'sessionLifecycle',
                event: 'parentTurnCompleted',
                scope: {
                    kind: 'exactTurn',
                    sourceSessionId: 'session-source',
                    sourceTurnId: 'turn-exact',
                },
                consumption: 'once',
                status: { state: 'running', runId: 'run-from-turn' },
            }],
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        expect(screen.getTextContent()).toContain('Running from this turn');
        expect(screen.getTextContent()).toContain('run-from-turn');
        expect(screen.getTextContent()).toContain('session-source');
        expect(screen.getTextContent()).toContain('turn-exact');
    });

    it('shows the durable-push endpoint a webhook Automation actually observes', async () => {
        automationState.automation = {
            ...automationState.automation,
            assignments: [{ machineId: 'execution-machine', enabled: true, priority: 0 }],
            triggers: [eventTriggerFixture({
                sourceStatus: eventSourceStatusFixture({
                    reporterMaterializationRef: {
                        machineId: 'last-status-reporter',
                        materializationId: 'last-status-materialization',
                        pluginId: 'happier.scm.github',
                    },
                }),
                observation: {
                    kind: 'durablePush',
                    webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ',
                    endpointMaterializationRef: {
                        machineId: 'observation-machine',
                        materializationId: 'observation-materialization',
                        pluginId: 'happier.scm.github',
                    },
                    observationStartsAt: 1_700_000_000_000,
                },
            })],
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const endpoint = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.testID === 'automation-detail-event-endpoint',
        );
        const placement = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.testID === 'automation-detail-event-observation-placement',
        );
        expect(endpoint?.props.detail).toBe('wh_ep_AAAAAAAAAAAAAAAAAAAAAQ');
        expect(placement?.props.detail).toBe('observation-machine');
        expect(placement?.props.subtitle).toBe('observation-materialization');
    });

    it('does not substitute an execution assignment or stale status reporter for webhook observation placement', async () => {
        automationState.automation = {
            ...automationState.automation,
            assignments: [{ machineId: 'execution-machine', enabled: true, priority: 0 }],
            triggers: [eventTriggerFixture({
                sourceStatus: eventSourceStatusFixture({
                    reporterMaterializationRef: {
                        machineId: 'last-status-reporter',
                        materializationId: 'last-status-materialization',
                        pluginId: 'happier.scm.github',
                    },
                }),
                observation: {
                    kind: 'durablePush',
                    webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ',
                    endpointMaterializationRef: null,
                    observationStartsAt: 1_700_000_000_000,
                },
            })],
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const placement = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.testID === 'automation-detail-event-observation-placement',
        );
        expect(placement?.props.detail).toBe('Source status unavailable');
        expect(placement?.props.detail).not.toBe('execution-machine');
        expect(placement?.props.detail).not.toBe('last-status-reporter');
    });

    it('renders the bounded Event source status from the canonical projection', async () => {
        const sourceStatus = {
            automationId: 'a1',
            triggerId: 'event-trigger-1',
            triggerRevision: 1,
            eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
            sourceSelectorId: 'selector-1',
            reporterMaterializationRef: {
                pluginId: 'happier.scm.github',
                machineId: 'watcher-1',
                materializationId: 'materialization-1',
            },
            reporterImmutableGenerationId: 'github-generation-1',
            state: 'backingOff' as const,
            code: 'rateLimited' as const,
            lastObservedAt: 1,
            lastDispositionAt: 2,
            nextRetryAt: 3,
            observedCount: 4,
            admittedCount: 5,
            skippedCount: 6,
            revision: 7,
        };
        const sourceCatalogStatus = {
            reporterImmutableGenerationId: 'github-generation-1',
            observedRevision: '9',
            adoptedRevision: '7',
            state: 'reconciliationLate' as const,
            scanStartedAt: 1,
            nextRetryAt: 3,
        };
        automationState.automation = {
            ...automationState.automation,
            triggers: [eventTriggerFixture({
                eventRef: sourceStatus.eventRef,
                sourceSelectorId: sourceStatus.sourceSelectorId,
                sourceStatus,
                sourceCatalogStatus,
            })],
            templateVersion: 3,
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const status = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation source',
        );
        expect(status?.props.detail).toBe('Waiting to retry');
        expect(status?.props.subtitle).toContain('Rate limited');
        expect(status?.props.subtitle).toContain('Next retry:');
        // The admission tallies and the last observation are the only facts
        // that say whether this source is still seeing anything, so a status
        // row that drops them reads as healthy while the source is starving.
        expect(status?.props.subtitle).toContain('Events observed: 4');
        expect(status?.props.subtitle).toContain('Events admitted: 5');
        expect(status?.props.subtitle).toContain('Events skipped: 6');
        expect(status?.props.subtitle).toContain('Last observed:');
        const catalogStatus = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Catalog reconciliation',
        );
        expect(catalogStatus?.props.detail).toBe('Reconciliation delayed');
        expect(catalogStatus?.props.subtitle).toContain('Observed revision: 9');
        expect(catalogStatus?.props.subtitle).toContain('Adopted revision: 7');
        expect(catalogStatus?.props.subtitle).toContain('Scan started:');
        expect(catalogStatus?.props.subtitle).toContain('Next retry:');
    });

    it('offers the shared editor for an existing-Session Event edit seed', async () => {
        automationState.automation = currentEventDefinitionForEditor('existingSession');
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const editButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation');
        await act(async () => {
            pressTestInstance(editButton, 'Edit automation');
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/edit',
            params: { id: 'a1' },
        });
    });

    it('offers the shared editor for an execution-run Event edit seed', async () => {
        automationState.automation = currentEventDefinitionForEditor('executionRun');
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const editButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation');
        await act(async () => {
            pressTestInstance(editButton, 'Edit automation');
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/edit',
            params: { id: 'a1' },
        });
    });

    it('labels an Event Run in the paginated history from its immutable cause', async () => {
        automationRunsState.list = [{
            id: 'event-run-1',
            automationId: 'a1',
            revision: 1,
            triggerId: 'event-trigger-1',
            triggerRetired: true,
            state: 'queued',
            cause: {
                kind: 'trigger',
                triggerId: 'event-trigger-1',
                triggerRevision: 4,
                triggerKind: 'pluginEvent',
                occurrenceKey: 'occurrence-1',
                occurredAt: 10,
                evidence: {
                    eventRef: { pluginId: 'happier.scm.github', localId: 'pull-request-opened-v1' },
                    sourceSelectorId: 'selector-1',
                },
            },
            dueAt: 10,
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
            createdAt: 10,
            updatedAt: 11,
        }];
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const runRow = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Queued');

        expect(runRow?.props.subtitle).toContain('Event');
        expect(runRow?.props.subtitle).toContain('event-trigger-1 · revision 4');
        expect(runRow?.props.subtitle).toContain('Trigger retired');
    });

    it('offers the shared plural editor for a current schedule recipe', async () => {
        const strictScheduleDetail = {
            id: 'a1',
            name: 'Nightly',
            description: null,
            enabled: true,
            triggers: [{
                id: 'schedule-trigger-1',
                revision: 1,
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
                kind: 'schedule',
                schedule: {
                    kind: 'interval',
                    everyMs: 60_000,
                    scheduleExpr: null,
                    timezone: null,
                },
                nextRunAt: null,
                triggerDefinitionEnvelope: null,
            }],
            targetType: 'executionRun',
            existingSessionId: null,
            executionRecipe: {
                v: 1,
                templateVersion: 3,
                template: {
                    t: 'plain',
                    v: { v: 1, prompt: 'Run the current task.' },
                },
                triggerEvidence: null,
                target: {
                    kind: 'executionRun',
                    request: {
                        intent: 'task',
                        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                        permissionMode: 'read_only',
                        retentionPolicy: 'ephemeral',
                        runClass: 'bounded',
                        ioMode: 'request_response',
                    },
                },
            },
            templateVersion: 3,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
        };
        expect(AutomationDefinitionDetailSchema.safeParse(strictScheduleDetail).success).toBe(true);
        automationState.automation = {
            ...automationState.automation,
            targetType: 'executionRun',
            existingSessionId: null,
            templateVersion: 3,
            detail: {
                kind: 'available',
                templateVersion: 3,
                value: strictScheduleDetail,
            },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        const editButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation');
        await act(async () => {
            pressTestInstance(editButton, 'Edit automation');
        });
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/edit',
            params: { id: 'a1' },
        });
    });

    it('updates machine assignments without forcing a full automations refresh', async () => {
        machinesState.list = [
            {
                id: 'm1',
                metadata: { displayName: 'Primary machine', host: 'primary.local', platform: 'macOS' },
            },
        ];

        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const refreshCallsBeforeToggle = syncSpies.refreshAutomations.mock.calls.length;

        const toggle = screen.findByType('Switch');
        expect(toggle.props.accessibilityLabel).toContain('Nightly');
        expect(toggle.props.accessibilityLabel).toContain('Primary machine');
        expect(toggle.props.accessibilityLabel).toContain('Machine assignments');
        await act(async () => {
            toggle.props.onValueChange(true);
        });

        expect(syncSpies.replaceAutomationAssignments).toHaveBeenCalledWith('a1', [
            { machineId: 'm1', enabled: true, priority: 0 },
        ]);
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(refreshCallsBeforeToggle);
    });

    it('queues a run-now action without immediately refetching automation runs', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const fetchRunsCallsBeforeRunNow = syncSpies.fetchAutomationRuns.mock.calls.length;

        const runNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        await act(async () => {
            await pressTestInstance(runNowButton, 'Run now');
        });

        expect(syncSpies.runAutomationNow).toHaveBeenCalledWith('a1');
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledTimes(fetchRunsCallsBeforeRunNow);
    });

    it('submits Run now once and exposes the detail row as pending until it settles', async () => {
        const deferredRunNow = createDeferred();
        syncSpies.runAutomationNow.mockImplementationOnce(() => deferredRunNow.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const runNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        await act(async () => {
            pressTestInstance(runNowButton, 'Run now');
            pressTestInstance(runNowButton, 'Run now');
            await Promise.resolve();
        });

        expect(syncSpies.runAutomationNow).toHaveBeenCalledTimes(1);
        const pendingRunNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        expect(pendingRunNowButton?.props.disabled).toBe(true);
        expect(pendingRunNowButton?.props.loading).toBe(true);

        await act(async () => {
            deferredRunNow.resolve();
            await deferredRunNow.promise;
        });
    });

    it('does not surface a completed run-now state after the detail route is reused', async () => {
        const deferredRunNow = createDeferred();
        syncSpies.runAutomationNow.mockImplementationOnce(() => deferredRunNow.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const runNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        await act(async () => {
            pressTestInstance(runNowButton, 'Run now');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        expect(screen.findAllByType('ActivitySpinner' as any)).toHaveLength(0);

        await act(async () => {
            deferredRunNow.resolve();
            await deferredRunNow.promise;
        });

        const secondRunNow = screen.findAllByType('Item' as any)
            .find((item: any) => item.props.title === 'Run now');
        expect(secondRunNow?.props.rightElement).toBeUndefined();
    });

    it('keeps a revisited detail Run now control pending until its original request settles', async () => {
        const deferredRunNow = createDeferred();
        syncSpies.runAutomationNow.mockImplementationOnce(() => deferredRunNow.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const firstRunNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        await act(async () => {
            pressTestInstance(firstRunNowButton, 'Run now');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        routeParamsState.id = 'a1';
        automationState.automation = {
            ...automationState.automation,
            id: 'a1',
            name: 'Nightly',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        const revisitedRunNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        expect(revisitedRunNowButton?.props.disabled).toBe(true);
        expect(revisitedRunNowButton?.props.loading).toBe(true);
        await act(async () => {
            pressTestInstance(revisitedRunNowButton, 'Run now');
            await Promise.resolve();
        });
        expect(syncSpies.runAutomationNow).toHaveBeenCalledTimes(1);

        await act(async () => {
            deferredRunNow.resolve();
            await deferredRunNow.promise;
        });

        const settledRunNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        expect(settledRunNowButton?.props.disabled).toBe(false);
        expect(settledRunNowButton?.props.loading).toBe(false);
    });

    it('does not alert for a run-now failure after the detail route is reused', async () => {
        const deferredRunNow = createDeferred();
        syncSpies.runAutomationNow.mockImplementationOnce(() => deferredRunNow.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const runNowButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now');
        await act(async () => {
            pressTestInstance(runNowButton, 'Run now');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        await act(async () => {
            deferredRunNow.reject(new Error('first route failed'));
            await Promise.resolve();
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not alert for a pause failure after the detail route is reused', async () => {
        const deferredPause = createDeferred();
        syncSpies.pauseAutomation.mockImplementationOnce(() => deferredPause.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const pauseButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'automations.detail.pauseAutomation');
        await act(async () => {
            pressTestInstance(pauseButton, 'automations.detail.pauseAutomation');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        await act(async () => {
            deferredPause.reject(new Error('first route pause failed'));
            await Promise.resolve();
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not alert for a machine assignment failure after the detail route is reused', async () => {
        const deferredAssignment = createDeferred();
        machinesState.list = [{
            id: 'm1',
            metadata: { displayName: 'Primary machine', host: 'primary.local', platform: 'macOS' },
        }];
        syncSpies.replaceAutomationAssignments.mockImplementationOnce(() => deferredAssignment.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const assignmentToggle = screen.findByType('Switch');
        await act(async () => {
            assignmentToggle.props.onValueChange(true);
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        await act(async () => {
            deferredAssignment.reject(new Error('first route assignment failed'));
            await Promise.resolve();
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not delete after a delete confirmation resolves for an earlier reused route', async () => {
        const deferredConfirmation = createDeferred<boolean>();
        modalConfirmSpy.mockImplementationOnce(() => deferredConfirmation.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const deleteButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Delete automation');
        await act(async () => {
            pressTestInstance(deleteButton, 'Delete automation');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        await act(async () => {
            deferredConfirmation.resolve(true);
            await deferredConfirmation.promise;
        });

        expect(syncSpies.deleteAutomation).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('confirms clear-history and delegates the retained-run refresh to the canonical Sync owner', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const clearHistoryButton = screen.findByProps({ testID: 'automation-detail-clear-history' });
        const fetchCallsBeforeClear = syncSpies.fetchAutomationRuns.mock.calls.length;
        await act(async () => {
            await pressTestInstance(clearHistoryButton, 'Clear run history');
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'automations.detail.clearHistoryConfirmTitle',
            'automations.detail.clearHistoryConfirmMessage',
            { destructive: true, confirmText: 'automations.detail.clearHistoryConfirmButton' },
        );
        expect(syncSpies.clearAutomationRunHistory).toHaveBeenCalledWith('a1');
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledTimes(fetchCallsBeforeClear);
    });

    it('does not navigate after a deletion from an earlier reused route settles', async () => {
        const deferredDelete = createDeferred();
        syncSpies.deleteAutomation.mockImplementationOnce(() => deferredDelete.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const deleteButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Delete automation');
        await act(async () => {
            pressTestInstance(deleteButton, 'Delete automation');
        });
        expect(syncSpies.deleteAutomation).toHaveBeenCalledWith('a1');

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        await act(async () => {
            deferredDelete.resolve();
            await deferredDelete.promise;
        });

        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('does not alert for a deletion failure after the detail route is reused', async () => {
        const deferredDelete = createDeferred();
        syncSpies.deleteAutomation.mockImplementationOnce(() => deferredDelete.promise);
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const deleteButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Delete automation');
        await act(async () => {
            pressTestInstance(deleteButton, 'Delete automation');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        await screen.update(React.createElement(AutomationDetailScreen));

        await act(async () => {
            deferredDelete.reject(new Error('first route delete failed'));
            await Promise.resolve();
        });

        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not carry a load-more spinner across reused detail routes', async () => {
        const deferredLoadMore = createDeferred<{ nextCursor: string | null }>();
        automationRunCursorState.nextCursor = 'a1-next';
        syncSpies.fetchAutomationRuns.mockImplementation((automationId: string, _limit?: number, cursor?: string) => {
            if (automationId === 'a1' && cursor === 'a1-next') {
                return deferredLoadMore.promise;
            }
            return Promise.resolve({ nextCursor: null });
        });
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const loadMoreButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Load more runs');
        await act(async () => {
            pressTestInstance(loadMoreButton, 'Load more runs');
        });

        routeParamsState.id = 'a2';
        automationState.automation = {
            ...automationState.automation,
            id: 'a2',
            name: 'Second automation',
        };
        automationRunCursorState.nextCursor = 'a2-next';
        await screen.update(React.createElement(AutomationDetailScreen));

        const secondRouteLoadMore = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Load more runs');
        expect(secondRouteLoadMore?.props.loading).toBe(false);

        await act(async () => {
            deferredLoadMore.resolve({ nextCursor: null });
            await deferredLoadMore.promise;
        });
    });

    it('keeps the current detail route loading while an earlier route refresh settles', async () => {
        const firstRouteRefresh = createDeferred<{ nextCursor: string | null }>();
        const secondRouteRefresh = createDeferred<{ nextCursor: string | null }>();
        syncSpies.fetchAutomationRuns.mockImplementation((automationId: string) => (
            automationId === 'a1' ? firstRouteRefresh.promise : secondRouteRefresh.promise
        ));
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledWith('a1');

        routeParamsState.id = 'a2';
        automationState.missing = true;
        await screen.update(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledWith('a2');

        await act(async () => {
            firstRouteRefresh.resolve({ nextCursor: null });
            await firstRouteRefresh.promise;
        });

        expect(screen.findAllByType('ActivitySpinner' as any)).toHaveLength(1);

        await act(async () => {
            secondRouteRefresh.resolve({ nextCursor: null });
            await secondRouteRefresh.promise;
        });
    });

    it('renders loading instead of not found for an uncached reused route before its refresh starts', async () => {
        const originalUseEffect = React.useEffect;
        const useEffectSpy = vi.spyOn(React, 'useEffect').mockImplementation(((_effect, dependencies) => (
            originalUseEffect(() => undefined, dependencies)
        )) as typeof React.useEffect);
        try {
            const { AutomationDetailScreen } = await import('./AutomationDetailScreen');
            const screen = await renderScreen(React.createElement(AutomationDetailScreen));

            routeParamsState.id = 'a2';
            automationState.missing = true;
            await screen.update(React.createElement(AutomationDetailScreen));

            expect(screen.findAllByType('ActivitySpinner' as any)).toHaveLength(1);
            expect(findTestInstanceByTypeContainingText(screen, 'Text', 'automations.detail.notFound')).toBeUndefined();
        } finally {
            useEffectSpy.mockRestore();
        }
    });

    it('shows an announced retryable error instead of not found when the initial detail refresh fails', async () => {
        automationState.missing = true;
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const errorState = screen.findAllByProps({ testID: 'automation-detail-refresh-error' })
            .find((instance) => instance.props.role === 'alert');
        expect(errorState?.props.role).toBe('alert');
        expect(errorState?.props['aria-live']).toBe('assertive');
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'automations.detail.notFound')).toBeUndefined();

        const retry = screen.findAllByProps({ testID: 'automation-detail-refresh-error-action' })
            .find((instance) => typeof instance.props.onPress === 'function');
        if (!retry) throw new Error('Retry action was not found');
        await act(async () => {
            retry.props.onPress();
            await Promise.resolve();
        });
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('keeps cached detail visible with an announced retry and disables stale mutations after refresh failure', async () => {
        machinesState.list = [{
            id: 'm1',
            metadata: { displayName: 'Primary machine', host: 'primary.local', platform: 'macOS' },
        }];
        syncSpies.refreshAutomations.mockRejectedValueOnce(new Error('network unavailable'));
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const errorState = screen.findByProps({ testID: 'automation-detail-stale-refresh-error' });
        expect(errorState.props.accessibilityRole).toBe('alert');
        expect(errorState.props.accessibilityLiveRegion).toBe('assertive');
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'Run now')?.props.disabled).toBe(true);
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'automations.detail.pauseAutomation')?.props.disabled).toBe(true);
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'Delete automation')?.props.disabled).toBe(true);
        expect(screen.findByType('Switch').props.disabled).toBe(true);

        await act(async () => {
            pressTestInstance(screen.findByProps({ testID: 'automation-detail-stale-refresh-retry' }), 'Retry');
            await Promise.resolve();
        });
        expect(syncSpies.refreshAutomations).toHaveBeenCalledTimes(2);
    });

    it('continues run history from the server-provided cursor instead of stopping at the first page', async () => {
        syncSpies.fetchAutomationRuns
            .mockImplementationOnce(async () => {
                automationRunCursorState.nextCursor = 'opaque-next-page';
                return { nextCursor: 'opaque-next-page' };
            })
            .mockImplementationOnce(async () => {
                automationRunCursorState.nextCursor = null;
                return { nextCursor: null };
            });
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await screen.update(React.createElement(AutomationDetailScreen));
        const loadMoreButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Load more runs');

        await act(async () => {
            await pressTestInstance(loadMoreButton, 'Load more runs');
        });

        expect(syncSpies.fetchAutomationRuns).toHaveBeenNthCalledWith(1, 'a1');
        expect(syncSpies.fetchAutomationRuns).toHaveBeenNthCalledWith(2, 'a1', 20, 'opaque-next-page');
    });

    it('renders a retained high-cardinality history one canonical page at a time', async () => {
        // A fully traversed history can retain a partial final page even after
        // the server cursor is exhausted; that page must remain reachable
        // without remounting every earlier row or issuing a made-up request.
        automationRunCursorState.nextCursor = null;
        automationRunsState.list = Array.from({ length: 25 }, (_unused, index) => ({
            id: `run-${index}`,
            automationId: 'a1',
            revision: 1,
            triggerId: null,
            triggerRetired: false,
            state: 'succeeded',
            cause: { kind: 'manual', invokedAt: index },
            dueAt: index,
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
            createdAt: index,
            updatedAt: index,
        }));
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const historyListProps = runHistoryListMock.state.props;
        expect(historyListProps, 'Expected history to use the canonical virtualized scroll owner.').not.toBeNull();
        expect(screen.findAllByType('ItemList' as any)).toHaveLength(0);
        const firstPageRows = (historyListProps?.data as ReadonlyArray<{ kind: string }>).filter(
            (row) => row.kind === 'run',
        );
        expect(firstPageRows).toHaveLength(20);
        const renderedRunRows = screen.findAllByType('Pressable' as any).filter(
            (row: any) => row.props.accessibilityLabel === 'Succeeded',
        );
        expect(renderedRunRows).toHaveLength(20);
        const loadMoreButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Load more runs');
        expect(loadMoreButton).toBeTruthy();
        const fetchesBeforeShowingRetainedPage = syncSpies.fetchAutomationRuns.mock.calls.length;

        await act(async () => {
            pressTestInstance(loadMoreButton, 'Load more runs');
        });

        const laterPageRows = screen.findAllByType('Pressable' as any).filter(
            (row: any) => row.props.accessibilityLabel === 'Succeeded',
        );
        expect(laterPageRows).toHaveLength(5);
        expect((runHistoryListMock.state.props?.data as ReadonlyArray<{
            kind: string;
            run?: { id: string };
        }>).flatMap((row) => row.kind === 'run' && row.run ? [row.run.id] : []))
            .toEqual(['run-20', 'run-21', 'run-22', 'run-23', 'run-24']);
        expect(syncSpies.fetchAutomationRuns).toHaveBeenCalledTimes(fetchesBeforeShowingRetainedPage);

        // A live insertion sorts into the first page, but the older page keeps
        // its existing Run-identity anchor instead of shifting by one row.
        automationRunsState.list = [{
            ...automationRunsState.list[0]!,
            id: 'run-new',
            createdAt: 100,
            updatedAt: 100,
        }, ...automationRunsState.list];
        await screen.update(React.createElement(AutomationDetailScreen));
        expect((runHistoryListMock.state.props?.data as ReadonlyArray<{
            kind: string;
            run?: { id: string };
        }>).flatMap((row) => row.kind === 'run' && row.run ? [row.run.id] : []))
            .toEqual(['run-20', 'run-21', 'run-22', 'run-23', 'run-24']);

        const newerPageButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.previous');
        expect(newerPageButton).toBeTruthy();
        await act(async () => {
            pressTestInstance(newerPageButton, 'common.previous');
        });

        const restoredNewerPageRows = screen.findAllByType('Pressable' as any).filter(
            (row: any) => row.props.accessibilityLabel === 'Succeeded',
        );
        expect(restoredNewerPageRows).toHaveLength(20);
    });

    it('opens an individual run through the Automation run-detail route', async () => {
        automationRunsState.list = [{
            id: 'run-1',
            automationId: 'a1',
            revision: 1,
            triggerId: null,
            triggerRetired: false,
            state: 'running',
            cause: { kind: 'manual', invokedAt: 10 },
            dueAt: 10,
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
            createdAt: 10,
            updatedAt: 11,
        }];
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const runRow = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Running');
        await act(async () => {
            pressTestInstance(runRow, 'Running');
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/automations/[id]/runs/[runId]',
            params: { id: 'a1', runId: 'run-1' },
        });
    });

    it('hides the machine-assignment warning once at least one machine is enabled', async () => {
        automationState.automation.assignments = [
            { machineId: 'm1', enabled: true, priority: 1 },
        ];
        machinesState.list = [
            {
                id: 'm1',
                metadata: { displayName: 'Primary machine', host: 'primary.local', platform: 'macOS' },
            },
        ];

        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const machineAssignmentsGroup = screen.findByProps({ title: 'Machine assignments' });

        expect(machineAssignmentsGroup.props.footer).toBeUndefined();
    });

    it('disambiguates duplicate machine rows with online state in the subtitle', async () => {
        const now = Date.now();
        machinesState.list = [
            {
                id: 'm1',
                active: true,
                activeAt: now,
                revokedAt: null,
                metadata: { displayName: 'Leeroys-MacBook-Pro', host: 'Leeroys-MacBook-Pro', platform: 'darwin' },
            },
            {
                id: 'm2',
                active: false,
                activeAt: now - 10 * 60_000,
                revokedAt: null,
                metadata: { displayName: 'Leeroys-MacBook-Pro', host: 'Leeroys-MacBook-Pro', platform: 'darwin' },
            },
        ];

        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const machineRows = screen.findAllByProps({ accessibilityLabel: 'Leeroys-MacBook-Pro' });

        expect(machineRows.map((node) => node.props.subtitle)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('online'),
                expect.stringContaining('offline'),
            ]),
        );
    });

    it('navigates to the automations list after deleting instead of relying on history back', async () => {
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        const deleteButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Delete automation');
        await act(async () => {
            await pressTestInstance(deleteButton, 'Delete automation');
        });

        expect(syncSpies.deleteAutomation).toHaveBeenCalledWith('a1');
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/automations');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });
});
