import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationV3DefinitionDetailSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationV3DefinitionDetail,
} from '@happier-dev/protocol';
import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

type AutomationScreenFixture = {
    id: string;
    name: string;
    enabled: boolean;
    description: string | null;
    trigger: AutomationV3DefinitionDetail['trigger'];
    targetType: 'newSession' | 'existingSession' | 'executionRun';
    templateVersion: number;
    sourceStatus?: {
        automationId: string;
        eventRef: { pluginId: string; localId: string };
        sourceSelectorId: string;
        templateVersion: number;
        reporterMaterializationRef: {
            pluginId: string;
            machineId: string;
            materializationId: string;
        };
        reporterImmutableGenerationId?: string;
        state: 'uninitialized' | 'baselined' | 'observing' | 'backingOff' | 'attention';
        code: 'credentialMissing' | 'credentialRevoked' | 'rateLimited' | 'historyGap' | 'capacityBlocked' | 'definitionStale' | 'sourceContractIncompatible' | 'admissionUnavailable' | null;
        lastObservedAt: number | null;
        lastDispositionAt: number | null;
        nextRetryAt: number | null;
        observedCount: number;
        admittedCount: number;
        skippedCount: number;
        revision: number;
    };
    sourceCatalogStatus?: {
        observedRevision: string;
        adoptedRevision: string | null;
        state: 'current' | 'reconciling' | 'reconciliationLate';
        scanStartedAt: number | null;
        nextRetryAt: number | null;
    };
    detail:
        | { kind: 'unloaded'; templateVersion: number }
        | { kind: 'available'; templateVersion: number; value: unknown }
        | { kind: 'unavailable'; templateVersion: number; code: string };
    linkedExistingSessionId: string | null;
    nextRunAt: number | null;
    assignments: Array<{ machineId: string; enabled: boolean; priority: number }>;
};

type FetchAutomationRuns = (
    automationId: string,
    limit?: number,
    cursor?: string,
) => Promise<{ nextCursor: string | null }>;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const routeParamsState = vi.hoisted(() => ({ id: 'a1' }));
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));
const syncSpies = vi.hoisted(() => ({
    refreshAutomations: vi.fn(async () => {}),
    refreshAutomationDefinitionDetail: vi.fn(async () => {}),
    fetchAutomationRuns: vi.fn<FetchAutomationRuns>(async () => ({ nextCursor: null })),
    runAutomationNow: vi.fn(async () => {}),
    pauseAutomation: vi.fn(async () => {}),
    resumeAutomation: vi.fn(async () => {}),
    deleteAutomation: vi.fn(async () => {}),
    replaceAutomationAssignments: vi.fn(async () => {}),
}));
const automationState = vi.hoisted((): { automation: AutomationScreenFixture; missing: boolean } => ({
    automation: {
        id: 'a1',
        name: 'Nightly',
        enabled: true,
        description: null as string | null,
        trigger: { kind: 'schedule' as const, schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null, timezone: null as string | null } },
        targetType: 'newSession' as const,
        templateVersion: 1,
        detail: { kind: 'unloaded' as const, templateVersion: 1 },
        linkedExistingSessionId: null as string | null,
        nextRunAt: null as number | null,
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
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                const labels: Record<string, string> = {
                    'automations.detail.runNowTitle': 'Run now',
                    'automations.detail.loadMoreRuns': 'Load more runs',
                    'automations.detail.editAutomation': 'Edit automation',
                    'automations.detail.deleteAutomation': 'Delete automation',
                    'automations.detail.machineAssignmentsTitle': 'Machine assignments',
                    'automations.detail.event.watcherTitle': 'Observation watcher',
                    'automations.detail.event.watcherUnwatched': 'Unwatched',
                    'settingsPlugins.eventAutomationComposer.sourceStatusTitle': 'Observation source',
                    'settingsPlugins.eventAutomationComposer.sourceCatalogStatusTitle': 'Catalog reconciliation',
                    'automations.detail.runDetail.sourceInstance': 'Source instance',
                    'automations.detail.runDetail.filter': 'Filter',
                    'automations.detail.runDetail.target': 'Frozen target',
                    'automations.detail.runDetail.outputCeiling': 'Output limit',
                    'automations.detail.runDetail.executionRun': `Execution run · ${String(params?.permissionMode ?? '')}`,
                    'settingsPlugins.eventAutomationComposer.sourceStatusState.backingOff': 'Waiting to retry',
                    'settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.reconciliationLate': 'Reconciliation delayed',
                    'settingsPlugins.eventAutomationComposer.sourceStatusCode.rateLimited': 'Rate limited',
                    'automations.detail.runMeta.origin.pluginEvent': 'Event',
                    'automations.list.event': 'Event: repository-event-v1',
                    'status.online': 'online',
                    'status.offline': 'offline',
                };
                if (key === 'settingsPlugins.eventAutomationComposer.sourceStatusNextRetry') {
                    return `Next retry: ${String(params?.time ?? '')}`;
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
                return labels[key] ?? key;
            },
        });
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
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', props),
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
        routeParamsState.id = 'a1';
        automationState.missing = false;
        automationState.automation = {
            id: 'a1',
            name: 'Nightly',
            enabled: true,
            description: null,
            trigger: { kind: 'schedule', schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } },
            targetType: 'newSession',
            templateVersion: 1,
            detail: { kind: 'unloaded', templateVersion: 1 },
            linkedExistingSessionId: null,
            nextRunAt: null,
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
        const detail = AutomationV3DefinitionDetailSchema.parse({
            id: 'a1',
            name: 'Nightly',
            description: null,
            enabled: true,
            trigger: {
                kind: 'pluginEvent',
                eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
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
            },
            targetType,
            templateVersion: 3,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
            triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'plain',
                binding: {
                    v: 1,
                    automationId: 'a1',
                    templateVersion: 3,
                    triggerKind: 'pluginEvent',
                    eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
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
            trigger: detail.trigger,
            targetType,
            templateVersion: 3,
            detail: { kind: 'available', templateVersion: 3, value: detail },
            linkedExistingSessionId: targetType === 'existingSession' ? 'session-existing' : null,
            nextRunAt: null,
            assignments: [],
        };
    }

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

    it('loads direct Event detail through the incumbent owner and never offers the blocked schedule editor', async () => {
        automationState.automation = {
            ...automationState.automation,
            trigger: {
                kind: 'pluginEvent',
                eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
                sourceSelectorId: 'selector-1',
                sourceContractVersion: 1,
                observation: { kind: 'checkpointedPull', watcher: null },
            },
            templateVersion: 3,
            detail: { kind: 'unloaded', templateVersion: 3 },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        await act(async () => {
            await Promise.resolve();
        });

        expect(syncSpies.refreshAutomationDefinitionDetail).toHaveBeenCalledWith('a1');
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation')).toBeUndefined();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Event: repository-event-v1');
        const watcher = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation watcher',
        );
        expect(watcher?.props.detail).toBe('Unwatched');
    });

    it('renders the bounded Event source status from the canonical projection', async () => {
        const sourceStatus = {
            automationId: 'a1',
            eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
            sourceSelectorId: 'selector-1',
            templateVersion: 3,
            reporterMaterializationRef: {
                pluginId: 'happier.scm.github',
                machineId: 'watcher-1',
                materializationId: 'materialization-1',
            },
            reporterImmutableGenerationId: 'generation-1',
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
            observedRevision: '9',
            adoptedRevision: '7',
            state: 'reconciliationLate' as const,
            scanStartedAt: 1,
            nextRetryAt: 3,
        };
        automationState.automation = {
            ...automationState.automation,
            trigger: {
                kind: 'pluginEvent',
                eventRef: sourceStatus.eventRef,
                sourceSelectorId: sourceStatus.sourceSelectorId,
                sourceContractVersion: 1,
                observation: { kind: 'checkpointedPull', watcher: null },
            },
            templateVersion: sourceStatus.templateVersion,
            sourceStatus,
            sourceCatalogStatus,
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));
        const status = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Observation source',
        );
        expect(status?.props.detail).toBe('Waiting to retry');
        expect(status?.props.subtitle).toContain('Rate limited');
        expect(status?.props.subtitle).toContain('Next retry:');
        const catalogStatus = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Catalog reconciliation',
        );
        expect(catalogStatus?.props.detail).toBe('Reconciliation delayed');
        expect(catalogStatus?.props.subtitle).toContain('Observed revision: 9');
        expect(catalogStatus?.props.subtitle).toContain('Adopted revision: 7');
        expect(catalogStatus?.props.subtitle).toContain('Scan started:');
        expect(catalogStatus?.props.subtitle).toContain('Next retry:');
    });

    it('renders private Event source, filter, target, permission, and output ceiling only after the canonical detail read succeeds', async () => {
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
            '11111111-1111-4111-8111-111111111111',
        );
        automationState.automation = {
            ...automationState.automation,
            trigger: {
                kind: 'pluginEvent',
                eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
                sourceSelectorId,
                sourceContractVersion: 1,
                observation: { kind: 'checkpointedPull', watcher: null },
            },
            targetType: 'executionRun',
            templateVersion: 3,
            detail: {
                kind: 'available',
                templateVersion: 3,
                value: AutomationV3DefinitionDetailSchema.parse({
                    id: 'a1',
                    name: 'Nightly',
                    description: null,
                    enabled: true,
                    trigger: {
                        kind: 'pluginEvent',
                        eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
                        sourceSelectorId,
                        sourceContractVersion: 1,
                        observation: { kind: 'checkpointedPull', watcher: null },
                    },
                    targetType: 'executionRun',
                    templateVersion: 3,
                    nextRunAt: null,
                    lastRunAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                    assignments: [],
                    triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: 'plain',
                        binding: {
                            v: 1,
                            automationId: 'a1',
                            templateVersion: 3,
                            triggerKind: 'pluginEvent',
                            eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
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
                    executionRecipe: {
                        v: 1,
                        templateVersion: 3,
                        template: { t: 'plain', v: { v: 1, prompt: 'Review {{input}}' } },
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
                }),
            },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        const source = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Source instance' && instance.props.detail === 'happier-dev/happier',
        );
        const filter = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Filter',
        );
        const target = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Frozen target',
        );
        const outputCeiling = screen.findAllByType('Pressable' as any).find(
            (instance: any) => instance.props.accessibilityLabel === 'Output limit',
        );
        expect(source).toBeTruthy();
        expect(filter?.props.subtitle).toContain('/action');
        expect(filter?.props.subtitle).toContain('opened');
        expect(target?.props.detail).toBe('Execution run · read_only');
        expect(outputCeiling?.props.detail).toBe('256 KB');
    });

    it('withholds private Event fields when the canonical direct detail is unavailable', async () => {
        automationState.automation = {
            ...automationState.automation,
            trigger: {
                kind: 'pluginEvent',
                eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
                sourceSelectorId: '11111111-1111-4111-8111-111111111111',
                sourceContractVersion: 1,
                observation: { kind: 'checkpointedPull', watcher: null },
            },
            targetType: 'executionRun',
            templateVersion: 3,
            detail: {
                kind: 'unavailable',
                templateVersion: 3,
                code: 'automation_stored_content_unavailable',
            },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        expect(screen.findAllByProps({ accessibilityLabel: 'Source instance' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: 'Filter' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: 'Frozen target' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: 'Output limit' })).toHaveLength(0);
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

    it('labels an Event Run in the paginated history from its immutable origin', async () => {
        automationRunsState.list = [{
            id: 'event-run-1',
            automationId: 'a1',
            state: 'queued',
            origin: {
                kind: 'pluginEvent',
                occurrenceKey: 'occurrence-1',
                sourceSelectorId: 'selector-1',
                occurredAt: 10,
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
        const runRow = findTestInstanceByTypeContainingText(screen, 'Pressable', 'QUEUED');

        expect(runRow?.props.subtitle).toContain('Event');
    });

    it('does not offer the retained schedule editor for a current V3 schedule recipe', async () => {
        const strictV3ScheduleDetail = {
            id: 'a1',
            name: 'Nightly',
            description: null,
            enabled: true,
            trigger: {
                kind: 'schedule',
                schedule: {
                    kind: 'interval',
                    everyMs: 60_000,
                    scheduleExpr: null,
                    timezone: null,
                },
            },
            targetType: 'executionRun',
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
            triggerDefinitionEnvelope: null,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            assignments: [],
        };
        expect(AutomationV3DefinitionDetailSchema.safeParse(strictV3ScheduleDetail).success).toBe(true);
        automationState.automation = {
            ...automationState.automation,
            targetType: 'executionRun',
            templateVersion: 3,
            detail: {
                kind: 'available',
                templateVersion: 3,
                value: strictV3ScheduleDetail,
            },
        };
        const { AutomationDetailScreen } = await import('./AutomationDetailScreen');

        const screen = await renderScreen(React.createElement(AutomationDetailScreen));

        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'Edit automation')).toBeUndefined();
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

        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'automations.detail.runNowQueuedBadge')).toBeUndefined();
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

    it('does not infer cancellation availability from a run state before the server projects action authority', async () => {
        automationRunsState.list = [{
            id: 'run-1',
            automationId: 'a1',
            state: 'running',
            origin: { kind: 'manual', invokedAt: 10 },
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
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'Cancel run')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'automations.detail.cancelRun')).toBeUndefined();
    });

    it('opens an individual run through the Automation run-detail route', async () => {
        automationRunsState.list = [{
            id: 'run-1',
            automationId: 'a1',
            state: 'running',
            origin: { kind: 'manual', invokedAt: 10 },
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
        const runRow = findTestInstanceByTypeContainingText(screen, 'Pressable', 'RUNNING');
        await act(async () => {
            pressTestInstance(runRow, 'RUNNING');
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
