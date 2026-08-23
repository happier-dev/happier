import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderScreen } from '@/dev/testkit';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol';
import type { PluginEventAutomationComposerModel } from '@/components/automations/editor/usePluginEventAutomationComposer';
import type { PluginMachineExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const popoverBoundaryRef = { current: { nodeType: 'AutomationBoundary' } } as React.RefObject<any>;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Platform: {
                OS: 'ios',
                select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#f5f5f5', sectionTitle: '#666' },
                    input: { background: '#fff', placeholder: '#888' },
                    surface: '#ffffff',
                    divider: '#ddd',
                    text: '#111',
                    textSecondary: '#666',
                },
            },
        });
    },
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key, params) => params ? key : key });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => popoverBoundaryRef,
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));

describe('AutomationSettingsPopoverContent', () => {
    it('keeps the enable toggle header and replaces the form body with sentence controls', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: 'Nightly',
                description: 'Run nightly work',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            }}
            onChange={() => {}}
        />);

        const enableItem = screen.findByType('Item' as any);
        const toggle = enableItem.props.rightElement;
        expect(toggle?.props?.value).toBe(true);

        expect(screen.findAllByType('AutomationSettingsForm' as any)).toHaveLength(0);
        expect(screen.findByProps({ testID: 'automation-sentence-name-input' }).props.value).toBe('Nightly');
        expect(screen.findByProps({ testID: 'automation-sentence-schedule-trigger' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-sentence-notes-input' }).props.value).toBe('Run nightly work');
    });

    it('keeps details collapsed when disabled', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        expect(screen.findByType('Item' as any).props.rightElement?.props?.value).toBe(false);
        expect(screen.findAllByProps({ testID: 'automation-sentence-name-input' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'automation-sentence-schedule-trigger' })).toHaveLength(0);
    });

    it('offers the canonical Event composer mode from the ordinary Automation chip', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            event: {
                id: 'acme.github/events/repository',
                identity: { pluginId: 'acme.github', localId: 'events/repository' },
                immutableGenerationId: 'event-generation-a',
                title: 'Repository changed',
                description: 'A repository changed',
                automation: {
                    v: 1,
                    eligible: true,
                    source: {
                        sourceContractVersion: 1,
                        supportedObservationTransports: ['checkpointedPull'],
                        sourceConfigSchema: { type: 'object', additionalProperties: false },
                        setupActionRef: { pluginId: 'acme.github', localId: 'setup-source' },
                    },
                },
            },
            setupAction: {
                id: 'acme.github/setup-source',
                identity: { pluginId: 'acme.github', localId: 'setup-source' },
                immutableGenerationId: 'event-generation-a',
                title: 'Set up source',
                description: null,
                inputSchema: { type: 'object', additionalProperties: false },
                inputHints: null,
            },
        });
        const setMode = vi.fn();
        const eventComposer: PluginEventAutomationComposerModel = {
            mode: 'schedule',
            setMode,
            isEditingEvent: false,
            editTarget: null,
            targetKind: 'newSession',
            setTargetKind: vi.fn(),
            targetKindLocked: false,
            existingSessionOptions: [],
            selectedExistingSessionId: null,
            selectExistingSession: vi.fn(),
            existingSessionAvailability: null,
            executionPermissionMode: 'read_only',
            setExecutionPermissionMode: vi.fn(),
            resolveExecutionTarget: vi.fn(() => null),
            eligibleEvents: [event],
            eventCatalogStatus: 'ready',
            selectedEvent: null,
            selectEvent: vi.fn(),
            getPluginPresentation: () => ({
                eventKey: 'acme.github:events/repository',
                displayName: 'Acme GitHub',
                availability: 'unavailable',
                installedPackage: null,
                expectedGeneration: null,
                machineId: null,
                serverId: null,
                accountLifetime: null,
                isCurrent: () => false,
            }),
            sourceStatus: 'idle',
            sourceDisplayLabel: null,
            sourceInstanceId: null,
            availableObservationTransports: ['checkpointedPull'],
            observationTransport: 'checkpointedPull',
            setObservationTransport: vi.fn(),
            webhookEndpoint: null,
            configureSource: vi.fn(),
            watcherCandidates: [],
            selectedWatcherOrigin: null,
            selectWatcher: vi.fn(),
            payloadBrowser: { fields: [], samplePayload: null },
            filterClauses: [],
            addFilterClause: vi.fn(),
            removeFilterClause: vi.fn(),
            setFilterClauseField: vi.fn(),
            setFilterClauseOperator: vi.fn(),
            setFilterClauseValueText: vi.fn(),
            filterValid: true,
            maximumObservationAgeMsText: '',
            setMaximumObservationAgeMsText: vi.fn(),
            maximumObservationAgeMsValid: true,
            createDraft: null,
            revision: 0,
        };
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: 'Repository triage',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
            eventComposer={eventComposer}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-event' }).props.onPress();
        });

        expect(setMode).toHaveBeenCalledWith('event');
    });

    it('requires a selected watcher before exposing Event source setup as actionable', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            event: {
                id: 'acme.github/events/repository',
                identity: { pluginId: 'acme.github', localId: 'events/repository' },
                immutableGenerationId: 'event-generation-a',
                title: 'Repository changed',
                description: 'A repository changed',
                payloadSchema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { action: { type: 'string' } },
                },
                automation: {
                    v: 1,
                    eligible: true,
                    source: {
                        sourceContractVersion: 1,
                        supportedObservationTransports: ['checkpointedPull'],
                        sourceConfigSchema: { type: 'object', additionalProperties: false },
                        setupActionRef: { pluginId: 'acme.github', localId: 'setup-source' },
                    },
                },
            },
            setupAction: {
                id: 'acme.github/setup-source',
                identity: { pluginId: 'acme.github', localId: 'setup-source' },
                immutableGenerationId: 'event-generation-a',
                title: 'Set up source',
                description: null,
                inputSchema: { type: 'object', additionalProperties: false },
                inputHints: null,
            },
        });
        const eventComposer: PluginEventAutomationComposerModel = {
            mode: 'event',
            setMode: vi.fn(),
            isEditingEvent: false,
            editTarget: null,
            targetKind: 'newSession',
            setTargetKind: vi.fn(),
            targetKindLocked: false,
            existingSessionOptions: [],
            selectedExistingSessionId: null,
            selectExistingSession: vi.fn(),
            existingSessionAvailability: null,
            executionPermissionMode: 'read_only',
            setExecutionPermissionMode: vi.fn(),
            resolveExecutionTarget: vi.fn(() => null),
            eligibleEvents: [event],
            eventCatalogStatus: 'ready',
            selectedEvent: event,
            selectEvent: vi.fn(),
            getPluginPresentation: () => ({
                eventKey: 'acme.github:events/repository',
                displayName: 'Acme GitHub',
                availability: 'unavailable',
                installedPackage: null,
                expectedGeneration: null,
                machineId: null,
                serverId: null,
                accountLifetime: null,
                isCurrent: () => false,
            }),
            sourceStatus: 'idle',
            sourceDisplayLabel: null,
            sourceInstanceId: null,
            availableObservationTransports: ['checkpointedPull'],
            observationTransport: 'checkpointedPull',
            setObservationTransport: vi.fn(),
            webhookEndpoint: null,
            configureSource: vi.fn(),
            watcherCandidates: [{
                materialization: {
                    serverIdentityId: 'srv_account_a',
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization',
                    pluginId: 'acme.github',
                    version: '1.0.0',
                    sourceClass: 'registryPackage',
                    portableRelease: true,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: 'trusted',
                    observedAt: 100,
                },
                releaseContent: 'matched',
                validation: { kind: 'rejected', reason: 'offline' },
            }] satisfies readonly PluginMachineExecutionOriginCandidateV1[],
            selectedWatcherOrigin: null,
            selectWatcher: vi.fn(),
            payloadBrowser: {
                fields: [{ pointer: '/action', scalarKind: 'string', sampleValue: 'opened' }],
                samplePayload: { action: 'opened' },
            },
            filterClauses: [{ id: 'filter-0', field: '/action', op: 'eq', valueText: '"opened"' }],
            addFilterClause: vi.fn(),
            removeFilterClause: vi.fn(),
            setFilterClauseField: vi.fn(),
            setFilterClauseOperator: vi.fn(),
            setFilterClauseValueText: vi.fn(),
            filterValid: true,
            maximumObservationAgeMsText: '',
            setMaximumObservationAgeMsText: vi.fn(),
            maximumObservationAgeMsValid: true,
            createDraft: null,
            revision: 0,
        };
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: 'Repository triage',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
            eventComposer={eventComposer}
        />);

        expect(screen.findByProps({ testID: 'automation-event-watcher-picker' })).toBeTruthy();
        const sourceSetup = screen.findByProps({ testID: 'automation-event-configure-source' });
        expect(sourceSetup.props.disabled).toBe(true);
        expect(sourceSetup.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

        await act(async () => {
            screen.findByProps({ testID: 'automation-event-watcher-picker' }).props.onPress();
        });
        const unavailableWatcher = screen.findByProps({
            testID: 'automation-event-watcher-option-watcher-machine:github-materialization',
        });
        expect(unavailableWatcher.props.disabled).toBe(true);
        expect(unavailableWatcher.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
        const watcherTitle = unavailableWatcher.findAllByType('Text' as any).find((node) => (
            node.props.children === 'watcher-machine / github-materialization'
        ));
        expect(watcherTitle?.props.children).toBe(
            'watcher-machine / github-materialization',
        );
        expect(screen.findByProps({ testID: 'automation-event-payload-browser' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-event-filter-add-clause' })).toBeTruthy();
        expect(screen.findAllByProps({ testID: 'automation-event-filter-input' })).toHaveLength(0);
    });

    it('lets users choose hour presets, enter day intervals, and switch to cron from the sentence schedule editor', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const onChange = vi.fn();
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={onChange}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });
        screen.findByProps({ testID: 'automation-schedule-preset-120' }).props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'interval',
            everyMinutes: 120,
        }));

        const unitDropdown = screen.findByType('DropdownMenu' as any);
        expect(unitDropdown.props).toEqual(expect.objectContaining({
            popoverBoundaryRef,
            connectToTrigger: true,
        }));
        expect('popoverPortalWebTarget' in unitDropdown.props).toBe(false);

        unitDropdown.props.onSelect('days');
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'interval',
            everyMinutes: 24 * 60,
        }));

        screen.findByProps({ testID: 'automation-schedule-use-cron' }).props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'cron',
        }));
    });

    it('shows a compact cron field guide inside the cron editor', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'cron',
                everyMinutes: 60,
                cronExpr: '0 9 * * 1-5',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });

        expect(screen.findByProps({ testID: 'automation-cron-field-guide' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-minute' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-hour' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-dayOfMonth' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-month' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-weekday' })).toBeTruthy();
    });
});
