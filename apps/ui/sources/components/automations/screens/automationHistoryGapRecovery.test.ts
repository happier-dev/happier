import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    AutomationDefinitionListItemSchema,
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginMachineMaterializationV1Schema,
    type AutomationDefinitionListItem,
    type AutomationEventSourceStatusV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginContributedActionDispatch } from '@/components/plugins/actions/pluginContributedActionController';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    type AutomationDefinition,
    isPluginEventAutomationTrigger,
    type PluginEventAutomationTrigger,
} from '@/sync/domains/automations/automationTypes';

import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

import {
    readAutomationHistoryGapRecoveryStatus,
    recoverAutomationHistoryGap,
} from './automationHistoryGapRecovery';

const AUTOMATION_ID = 'automation-a';
const TRIGGER_ID = AutomationTriggerIdSchema.parse('trigger-event-a');
const TRIGGER_REVISION = 4;
const OTHER_TRIGGER_ID = AutomationTriggerIdSchema.parse('trigger-event-b');
const PLUGIN_ID = 'acme.github';
const EVENT_LOCAL_ID = 'events/repository';
const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111');
const ACTION_LOCAL_ID = 'automations/reset-history-gap';
const MACHINE_ID = 'watcher-machine';
const SERVER_ID = 'server-a';
const SERVER_IDENTITY_ID = 'srv_account_a';
const MATERIALIZATION_ID = 'github-materialization';
const GENERATION = 17;

const historyGapRecoveryUi = vi.hoisted(() => ({
    dispatch: vi.fn(),
    rereadAutomationStatus: vi.fn(),
}));

installAutomationScreensCommonModuleMocks({
    text: {
        translate: (key: string) => ({
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryTitle': 'History gap needs attention',
            'settingsPlugins.eventAutomationComposer.historyGapRecoverySubtitle': 'Reset the source baseline to resume observing new Events.',
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryUnavailable': 'The source recovery action is not available on its current watcher.',
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureTitle': 'Source recovery needs another try',
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureBody': 'The recovery was not confirmed. The source still needs attention.',
            'common.retry': 'Retry',
        }[key] ?? key),
    },
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => ACCOUNT_LIFETIME,
}));

vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => ({
        readMaterializations: () => ({
            kind: 'available',
            materializations: [executionOrigin().materialization],
        }),
    }),
    useActivePluginAccountAvailabilityReleaseClassifier: () => () => ({
        releaseContent: 'matched',
        validation: { kind: 'admitted' },
    }),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    resolveFreshMachineAdministrationExecutionTarget: () => executionOrigin().machineTarget,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: 'ready',
        inputs: projectionInputs(eligibleEvent()),
    }),
}));

vi.mock('@/agents/backendCatalog/loadDaemonMergedProjectionInputs', () => ({
    loadDaemonMergedProjectionInputs: async () => projectionInputs(eligibleEvent()),
}));

vi.mock('@/components/plugins/surfaces/pluginSurfaceActionDispatch', () => ({
    dispatchPluginSurfaceAction: (...args: readonly unknown[]) => historyGapRecoveryUi.dispatch(...args),
}));

function eventSourceStatus(
    input: Partial<AutomationEventSourceStatusV1> = {},
): AutomationEventSourceStatusV1 {
    return {
        automationId: AUTOMATION_ID,
        triggerId: TRIGGER_ID,
        triggerRevision: TRIGGER_REVISION,
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceSelectorId: SOURCE_SELECTOR_ID,
        reporterMaterializationRef: {
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
            pluginId: PLUGIN_ID,
        },
        reporterImmutableGenerationId: 'github-generation-a',
        state: 'attention',
        code: 'historyGap',
        lastObservedAt: 10,
        lastDispositionAt: 10,
        nextRetryAt: null,
        observedCount: 0,
        admittedCount: 0,
        skippedCount: 0,
        revision: 4,
        ...input,
    };
}

function eventTrigger(
    input: Partial<PluginEventAutomationTrigger> = {},
): PluginEventAutomationTrigger {
    const id = input.id ?? TRIGGER_ID;
    const revision = input.revision ?? TRIGGER_REVISION;
    const sourceSelectorId = input.sourceSelectorId ?? SOURCE_SELECTOR_ID;
    return {
        id,
        revision,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'pluginEvent',
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceSelectorId,
        sourceContractVersion: 1,
        observation: { kind: 'checkpointedPull', watcher: null },
        sourceStatus: eventSourceStatus({
            triggerId: id,
            triggerRevision: revision,
            sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(sourceSelectorId),
        }),
        sourceCatalogStatus: null,
        ...input,
    };
}

function automation(input: Partial<AutomationDefinitionListItem> = {}): AutomationDefinitionListItem {
    const parsed = AutomationDefinitionListItemSchema.parse({
        id: AUTOMATION_ID,
        name: 'Repository triage',
        description: null,
        enabled: true,
        targetType: 'newSession',
        existingSessionId: null,
        templateVersion: 3,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: 1,
        assignments: [],
        triggers: [eventTrigger()],
        ...input,
    });
    return parsed;
}

function automationForScreen(
    input: Partial<AutomationDefinitionListItem> = {},
): AutomationDefinition {
    const summary = automation(input);
    return {
        ...summary,
        detail: { kind: 'unloaded', templateVersion: summary.templateVersion },
        linkedExistingSessionId: null,
    };
}

function readEventTrigger(
    value: AutomationDefinitionListItem,
    triggerId = TRIGGER_ID,
): PluginEventAutomationTrigger {
    const trigger = value.triggers.find((candidate) => candidate.id === triggerId);
    if (!isPluginEventAutomationTrigger(trigger)) throw new Error(`expected plugin Event trigger ${triggerId}`);
    return trigger;
}

function eligibleEvent(
    immutableGenerationId = 'github-generation-a',
): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            immutableGenerationId,
            title: 'Repository updates',
            description: null,
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: { type: 'object', additionalProperties: false },
                    setupActionRef: { pluginId: PLUGIN_ID, localId: 'automations/setup' },
                    historyGapResetActionRef: { pluginId: PLUGIN_ID, localId: ACTION_LOCAL_ID },
                },
            },
        },
        setupAction: {
            id: `${PLUGIN_ID}/automations/setup`,
            identity: { pluginId: PLUGIN_ID, localId: 'automations/setup' },
            immutableGenerationId,
            title: 'Configure source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
        historyGapResetAction: {
            id: `${PLUGIN_ID}/${ACTION_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: ACTION_LOCAL_ID },
            immutableGenerationId,
            title: 'Reset source baseline',
            description: null,
            inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
            inputHints: null,
        },
    });
}

function projectionInputs(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): DaemonMergedProjectionInputs {
    const action = event.historyGapResetAction;
    if (!action) throw new Error('expected recovery Action');
    const projectionAction: PluginProjectionAction = {
        id: action.identity.localId,
        title: action.title,
        description: action.description,
        icon: null,
        scopes: ['settings'],
        surfaces: ['plugin'],
        placementBindings: [],
        inputSchema: action.inputSchema,
        inputHints: action.inputHints,
        slash: null,
        priority: null,
        dangerLevel: 'safe',
        confirmation: null,
        available: true,
    };
    const plugin: PluginProjectionEntry = {
        pluginId: PLUGIN_ID,
        immutableGenerationId: action.immutableGenerationId,
        title: 'Acme GitHub',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: GENERATION,
        generationLabel: String(GENERATION),
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [projectionAction],
        resources: [],
        editableSettingsGroups: [],
    };
    return {
        mergedProviderProjectionById: {},
        mergedBackendProjectionById: {},
        discoveredBackendIds: [],
        pluginProjectionById: { [PLUGIN_ID]: plugin },
        pluginProjectionV2: {
            v: 2,
            generation: GENERATION,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {
                [`${PLUGIN_ID}/${action.identity.localId}`]: {
                    id: action.identity.localId,
                    pluginId: PLUGIN_ID,
                    title: action.title,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    execution: { target: 'daemon' },
                    placementBindings: [],
                    priority: 0,
                    dangerLevel: 'safe',
                    available: true,
                },
            },
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        },
        automationEligibleEvents: [event],
        registryDiagnostics: [],
    };
}

function executionOrigin(): FreshPluginMachineExecutionOriginV1 {
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: SERVER_IDENTITY_ID,
        machineId: MACHINE_ID,
        materializationId: MATERIALIZATION_ID,
        pluginId: PLUGIN_ID,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    });
    return {
        origin: {
            serverIdentityId: SERVER_IDENTITY_ID,
            materializationRef: {
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
                pluginId: PLUGIN_ID,
            },
        },
        materialization,
        machineTarget: {
            kind: 'resolved',
            target: { serverIdentityId: SERVER_IDENTITY_ID, machineId: MACHINE_ID },
            serverId: SERVER_ID,
            profile: {
                id: SERVER_ID,
                name: 'Server A',
                serverUrl: 'https://server-a.invalid',
                serverIdentityId: SERVER_IDENTITY_ID,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
            },
            machine: {
                id: MACHINE_ID,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
            },
        },
    };
}

const ACCOUNT_LIFETIME = Object.freeze({
    scope: Object.freeze({ serverId: SERVER_ID, accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose() {} }),
});

describe('automation history-gap recovery status', () => {
    it('recognizes the exact Plugin Event trigger without treating another trigger as the source', () => {
        const event = automation();
        expect(isPluginEventAutomationTrigger(readEventTrigger(event, TRIGGER_ID))).toBe(true);

        const scheduled = AutomationDefinitionListItemSchema.parse({
            ...event,
            triggers: [{
                id: 'schedule-trigger',
                revision: 1,
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
                kind: 'schedule',
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                nextRunAt: 60_000,
            }],
        });
        expect(isPluginEventAutomationTrigger(
            scheduled.triggers.find((candidate) => candidate.id === 'schedule-trigger'),
        )).toBe(false);
    });

    it('admits only the exact current trigger-scoped checkpointed Event source attention status', () => {
        const current = automation();
        const currentTrigger = readEventTrigger(current);

        expect(readAutomationHistoryGapRecoveryStatus(current, TRIGGER_ID)).toMatchObject({
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
            state: 'attention',
            code: 'historyGap',
            revision: 4,
        });
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                        '22222222-2222-4222-8222-222222222222',
                    ),
                }),
            })],
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({ triggerRevision: TRIGGER_REVISION + 1 }),
            })],
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({ state: 'observing', code: null }),
            })],
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            enabled: false,
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                observation: {
                    kind: 'durablePush',
                    webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
                    endpointMaterializationRef: null,
                    observationStartsAt: 1,
                },
            })],
        }), TRIGGER_ID)).toBeNull();

        const otherTrigger = eventTrigger({
            id: OTHER_TRIGGER_ID,
            revision: 9,
            sourceStatus: eventSourceStatus({
                triggerId: OTHER_TRIGGER_ID,
                triggerRevision: 9,
            }),
        });
        const plural = automation({ triggers: [currentTrigger, otherTrigger] });
        expect(readAutomationHistoryGapRecoveryStatus(plural, TRIGGER_ID)).toEqual(currentTrigger.sourceStatus);
        expect(readAutomationHistoryGapRecoveryStatus(plural, 'missing-trigger')).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({ sourceStatus: otherTrigger.sourceStatus })],
        }), TRIGGER_ID)).toBeNull();
    });

    it('dispatches only the exact current recovery Action with host-filled source identity', async () => {
        const event = eligibleEvent();
        const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: { kind: 'baselined' },
        }));
        let currentAutomation = automation();

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
            dispatch,
        })).resolves.toEqual({ kind: 'settled' });

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: PLUGIN_ID, localId: ACTION_LOCAL_ID },
            input: {
                automationId: AUTOMATION_ID,
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
                sourceSelectorId: SOURCE_SELECTOR_ID,
            },
            contributedAction: {
                machineId: MACHINE_ID,
                serverId: SERVER_ID,
                expectedGeneration: String(GENERATION),
                expectedImmutableGenerationId: 'github-generation-a',
            },
        }));
        expect(dispatch.mock.calls[0]?.[0]?.resolveContributedAction?.({
            pluginId: PLUGIN_ID,
            localId: ACTION_LOCAL_ID,
        })).toMatchObject({ execution: { target: 'daemon' } });

        currentAutomation = automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({ state: 'baselined', code: null, revision: 5 }),
            })],
        });
        dispatch.mockClear();
        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
            dispatch,
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch when the current Automation is disabled during the currentness recheck before generic action selection', async () => {
        const event = eligibleEvent();
        const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: { kind: 'baselined' },
        }));
        let currentAutomation = automation();
        let projectionLoads = 0;

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => {
                projectionLoads += 1;
                if (projectionLoads === 2) currentAutomation = automation({ enabled: false });
                return projectionInputs(event);
            },
            dispatch,
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch a history gap reported by a replaced immutable contributor generation at the same release and materialization', async () => {
        const event = eligibleEvent('github-generation-b');
        const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: { kind: 'baselined' },
        }));
        const currentAutomation = automation();

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
            dispatch,
        })).resolves.toEqual({ kind: 'stale' });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('treats a source-status revision that changes during the currentness recheck as stale without dispatching', async () => {
        const event = eligibleEvent();
        const dispatch = vi.fn<PluginContributedActionDispatch>();
        let currentAutomation = automation();
        let projectionLoads = 0;

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => {
                projectionLoads += 1;
                if (projectionLoads === 2) {
                    currentAutomation = automation({
                        triggers: [eventTrigger({
                            sourceStatus: eventSourceStatus({
                                revision: readEventTrigger(currentAutomation).sourceStatus!.revision + 1,
                            }),
                        })],
                    });
                }
                return projectionInputs(event);
            },
            dispatch,
        })).resolves.toEqual({ kind: 'stale' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not recover a different trigger and treats target trigger revision replacement as stale', async () => {
        const event = eligibleEvent();
        const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({
            ok: true as const,
            result: { kind: 'baselined' },
        }));
        let currentAutomation = automation({
            triggers: [
                eventTrigger(),
                eventTrigger({
                    id: OTHER_TRIGGER_ID,
                    revision: 1,
                    sourceStatus: eventSourceStatus({
                        triggerId: OTHER_TRIGGER_ID,
                        triggerRevision: 1,
                        state: 'observing',
                        code: null,
                    }),
                }),
            ],
        });

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: OTHER_TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
            dispatch,
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(dispatch).not.toHaveBeenCalled();

        let projectionLoads = 0;
        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => {
                projectionLoads += 1;
                if (projectionLoads === 2) {
                    currentAutomation = automation({
                        triggers: [
                            eventTrigger({ revision: TRIGGER_REVISION + 1 }),
                            readEventTrigger(currentAutomation, OTHER_TRIGGER_ID),
                        ],
                    });
                }
                return projectionInputs(event);
            },
            dispatch,
        })).resolves.toEqual({ kind: 'stale' });
        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe('AutomationHistoryGapRecoveryAction', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps an unavailable recovery visible, announced, and retryable while source status remains authoritative', async () => {
        const currentAutomation = automationForScreen();
        historyGapRecoveryUi.dispatch.mockReset();
        historyGapRecoveryUi.dispatch.mockResolvedValue({ ok: false, diagnostic: 'do-not-disclose' });
        historyGapRecoveryUi.rereadAutomationStatus.mockReset();
        historyGapRecoveryUi.rereadAutomationStatus.mockResolvedValue(undefined);

        const { AutomationHistoryGapRecoveryAction } = await import('./AutomationHistoryGapRecoveryAction');
        const screen = await renderScreen(React.createElement(AutomationHistoryGapRecoveryAction, {
            automation: currentAutomation,
            triggerId: TRIGGER_ID,
            isCurrentRoute: () => true,
            rereadAutomationStatus: historyGapRecoveryUi.rereadAutomationStatus,
        }));
        const recoveryRow = screen.find((node) => (
            node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function'
        ));

        await pressTestInstanceAsync(recoveryRow, 'history-gap recovery');
        await vi.waitFor(() => expect(historyGapRecoveryUi.rereadAutomationStatus).toHaveBeenCalledTimes(1));

        const failure = screen.findByTestId('automation-history-gap-recovery-failure');
        expect(failure).toEqual(expect.objectContaining({
            props: expect.objectContaining({
                role: 'alert',
                accessibilityLiveRegion: 'assertive',
            }),
        }));
        expect(screen.getTextContent()).toContain('Source recovery needs another try');
        expect(screen.getTextContent()).not.toContain('do-not-disclose');
        expect(readAutomationHistoryGapRecoveryStatus(currentAutomation, TRIGGER_ID)).toEqual(
            readEventTrigger(currentAutomation).sourceStatus,
        );

        await screen.pressByTestIdAsync('automation-history-gap-recovery-retry');
        await vi.waitFor(() => expect(historyGapRecoveryUi.dispatch).toHaveBeenCalledTimes(2));
        expect(historyGapRecoveryUi.rereadAutomationStatus).toHaveBeenCalledTimes(2);
    });

    it('does not clear source attention or show failure after a settled Action before the canonical reread changes it', async () => {
        const currentAutomation = automationForScreen();
        historyGapRecoveryUi.dispatch.mockReset();
        historyGapRecoveryUi.dispatch.mockResolvedValue({ ok: true, result: { kind: 'baselined' } });
        historyGapRecoveryUi.rereadAutomationStatus.mockReset();
        historyGapRecoveryUi.rereadAutomationStatus.mockResolvedValue(undefined);

        const { AutomationHistoryGapRecoveryAction } = await import('./AutomationHistoryGapRecoveryAction');
        const screen = await renderScreen(React.createElement(AutomationHistoryGapRecoveryAction, {
            automation: currentAutomation,
            triggerId: TRIGGER_ID,
            isCurrentRoute: () => true,
            rereadAutomationStatus: historyGapRecoveryUi.rereadAutomationStatus,
        }));
        const recoveryRow = screen.find((node) => (
            node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function'
        ));

        await pressTestInstanceAsync(recoveryRow, 'history-gap recovery');
        await vi.waitFor(() => expect(historyGapRecoveryUi.rereadAutomationStatus).toHaveBeenCalledTimes(1));

        expect(screen.findByTestId('automation-history-gap-recovery-failure')).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(currentAutomation, TRIGGER_ID)).toEqual(
            readEventTrigger(currentAutomation).sourceStatus,
        );
    });
});
