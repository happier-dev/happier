import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { dispatchEscapeToLayerStack } from '@/keyboard/escape';
import type { PluginMachineExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';

import type { PluginEventAutomationComposerModel } from './usePluginEventAutomationComposer';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installAutomationComponentCommonModuleMocks();

vi.mock('@/components/plugins/shared/InstalledPluginBrandMark', () => ({
    InstalledPluginBrandMark: () => null,
}));
vi.mock('@/components/plugins/shared/installedPluginBrandPresentation', () => ({
    useInstalledPluginBrandPresentation: () => null,
}));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

const EVENT_ID = 'acme.github/events/repository';

function createEvent() {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: EVENT_ID,
            identity: { pluginId: 'acme.github', localId: 'events/repository' },
            immutableGenerationId: 'event-generation-a',
            title: 'Repository changed',
            description: 'A repository changed',
            payloadSchema: {
                type: 'object',
                properties: { action: { type: 'string' } },
                additionalProperties: false,
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
}

const watcherCandidates = [{
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
    validation: { kind: 'admitted' },
}] satisfies readonly PluginMachineExecutionOriginCandidateV1[];

function createModel(event: ReturnType<typeof createEvent>): PluginEventAutomationComposerModel {
    return {
        mode: 'event',
        setMode: vi.fn(),
        isEditingEvent: false,
        editTarget: null,
        targetKind: 'newSession',
        setTargetKind: vi.fn(),
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
            availability: 'available',
            installedPackage: null,
            expectedGeneration: null,
            machineId: null,
            serverId: null,
            accountLifetime: null,
            isCurrent: () => true,
        }),
        sourceStatus: 'idle',
        sourceDisplayLabel: null,
        sourceInstanceId: null,
        availableObservationTransports: ['checkpointedPull'],
        observationTransport: 'checkpointedPull',
        setObservationTransport: vi.fn(),
        webhookEndpoint: null,
        configureSource: vi.fn(),
        watcherCandidates,
        selectedWatcherOrigin: {
            serverIdentityId: 'srv_account_a',
            materializationRef: {
                machineId: 'watcher-machine',
                materializationId: 'github-materialization',
                pluginId: 'acme.github',
            },
        },
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
    } as unknown as PluginEventAutomationComposerModel;
}

const EVENT_TRIGGER_TEST_ID = 'automation-event-picker';
const FILTER_FIELD_TRIGGER_TEST_ID = 'automation-event-filter-clause-filter-0-field-picker';

async function renderComposer(triggerFocus: Readonly<{
    event: () => void;
    filterField: () => void;
}>) {
    const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');
    return renderScreen(<PluginEventAutomationComposerContent model={createModel(createEvent())} />, {
        createNodeMock: (element) => {
            const elementProps = element.props as { testID?: string };
            if (elementProps.testID === EVENT_TRIGGER_TEST_ID) return { focus: triggerFocus.event };
            if (elementProps.testID === FILTER_FIELD_TRIGGER_TEST_ID) return { focus: triggerFocus.filterField };
            return {};
        },
    });
}

describe('PluginEventAutomationComposerContent picker dismissal', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('returns focus to the owning trigger when an expanded picker collapses on selection', async () => {
        const eventFocus = vi.fn();
        const filterFieldFocus = vi.fn();
        const screen = await renderComposer({ event: eventFocus, filterField: filterFieldFocus });

        await act(async () => {
            screen.findByProps({ testID: EVENT_TRIGGER_TEST_ID }).props.onPress();
        });
        expect(screen.findByTestId('automation-event-picker-options')).toBeTruthy();

        await act(async () => {
            screen.findByProps({ testID: `automation-event-option-${EVENT_ID}` }).props.onPress();
        });
        expect(screen.findByTestId('automation-event-picker-options')).toBeNull();
        expect(eventFocus).toHaveBeenCalledTimes(1);

        // The same owner has to cover every picker in the composer, not only
        // the first one: a per-picker fix leaves the rest stranding focus.
        await act(async () => {
            screen.findByProps({ testID: FILTER_FIELD_TRIGGER_TEST_ID }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({
                testID: 'automation-event-filter-clause-filter-0-field-option-/action',
            }).props.onPress();
        });
        expect(screen.findByTestId('automation-event-filter-clause-filter-0-field-options')).toBeNull();
        expect(filterFieldFocus).toHaveBeenCalledTimes(1);
    });

    it('collapses an expanded picker on Escape and hands the key back to the enclosing surface', async () => {
        const eventFocus = vi.fn();
        const filterFieldFocus = vi.fn();
        const screen = await renderComposer({ event: eventFocus, filterField: filterFieldFocus });

        await act(async () => {
            screen.findByProps({ testID: EVENT_TRIGGER_TEST_ID }).props.onPress();
        });
        expect(screen.findByTestId('automation-event-picker-options')).toBeTruthy();

        const escapeEvent = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
        let handled = false;
        await act(async () => {
            handled = dispatchEscapeToLayerStack(escapeEvent);
        });

        expect(handled).toBe(true);
        expect(screen.findByTestId('automation-event-picker-options')).toBeNull();
        expect(eventFocus).toHaveBeenCalledTimes(1);

        // With nothing expanded the composer must stop claiming Escape so the
        // enclosing Automation surface still receives it.
        const secondEscape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
        let secondHandled = true;
        await act(async () => {
            secondHandled = dispatchEscapeToLayerStack(secondEscape);
        });
        expect(secondHandled).toBe(false);
    });
});
