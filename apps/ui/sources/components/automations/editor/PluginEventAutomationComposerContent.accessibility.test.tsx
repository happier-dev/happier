import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { renderScreen } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import type { PluginMachineExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';

import type { PluginEventAutomationComposerModel } from './usePluginEventAutomationComposer';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installAutomationComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});

vi.mock('@/components/plugins/shared/installedPluginBrandPresentation', () => ({
    useInstalledPluginBrandPresentation: () => null,
}));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: () => null,
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

function composerModel(): PluginEventAutomationComposerModel {
    const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: 'acme.github/events/repository',
            identity: { pluginId: 'acme.github', localId: 'events/repository' },
            occurrenceId: 'event-occurrence-a',
            sourceCustody: { kind: 'development', registeredRootId: 'event-root-a' },
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
            occurrenceId: 'event-occurrence-a',
            title: 'Set up source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
    });
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
        validation: { kind: 'rejected', reason: 'offline' },
    }] satisfies readonly PluginMachineExecutionOriginCandidateV1[];
    return {
        eligibleEvents: [event],
        eventCatalogStatus: 'ready',
        selectedEvent: event,
        selectEvent: vi.fn(),
        getEventPresentation: (candidate: { event: { title: string; description: string | null } }) => ({ title: candidate.event.title, description: candidate.event.description }),
        getPluginPresentation: () => ({
            eventKey: 'acme.github:events/repository',
            displayName: 'Acme GitHub',
            availability: 'unavailable',
            installedPackage: null,
            expectedOccurrenceId: null,
            machineId: null,
            serverId: null,
            accountLifetime: null,
            isCurrent: () => false,
        }),
        sourceStatus: 'idle',
        sourceFailure: null,
        sourceDisplayLabel: null,
        sourceInstanceId: null,
        availableObservationTransports: ['checkpointedPull'],
        observationTransport: 'checkpointedPull',
        setObservationTransport: vi.fn(),
        webhookEndpoint: null,
        refreshWebhookEndpoint: null,
        webhookEndpointRefreshing: false,
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
            fields: [{ pointer: '/action', label: 'Action', scalarKind: 'string', sampleValue: 'opened' }],
            samplePayload: { action: 'opened' },
        },
        filterClauses: [{ id: 'filter-0', field: '/action', op: 'eq', valueText: '"opened"' }],
        addFilterClause: vi.fn(),
        removeFilterClause: vi.fn(),
        setFilterClauseField: vi.fn(),
        setFilterClauseOperator: vi.fn(),
        setFilterClauseValueText: vi.fn(),
        filterValid: false,
        maximumObservationAgeMsText: '',
        setMaximumObservationAgeMsText: vi.fn(),
        maximumObservationAgeMsValid: true,
        createDraft: null,
        invalidateConfiguredSource: vi.fn(),
        revision: 0,
    };

}

describe('PluginEventAutomationComposerContent accessibility', () => {
    it('gives Event composer failures usable screen-reader semantics', async () => {
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');
        const model = composerModel();
        const screen = await renderScreen(<PluginEventAutomationComposerContent model={model} />);

        expect(screen.findByProps({ testID: 'automation-event-filter-clause-filter-0-value' }).props.accessibilityLabel)
            .toBe('settingsPlugins.eventAutomationComposer.filterValue');
        expect(screen.findByProps({ testID: 'automation-event-configure-source' }).props.accessibilityHint)
            .toBe('automations.form.trigger.sourceUnavailable');
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.accessibilityRole)
            .toBe('alert');
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.accessibilityLiveRegion)
            .toBe('polite');
        expect(screen.findByProps({ testID: 'automation-event-filter-clause-filter-0-value' }).props.accessibilityHint)
            .toBe('automations.form.trigger.eventFilterInvalid');
        const alertTexts = screen.findAll((node) => (
            String(node.type) === 'Text' && node.props.accessibilityRole === 'alert'
        ));
        const politeAlertTexts = screen.findAll((node) => (
            String(node.type) === 'Text' && node.props.accessibilityLiveRegion === 'polite'
        ));
        expect(alertTexts).toHaveLength(2);
        expect(politeAlertTexts).toHaveLength(2);

        expect(screen.findByProps({ testID: 'automation-event-watcher-picker' }).props.accessibilityLabel)
            .toBe('automations.form.trigger.watchFrom');
        await screen.update(<PluginEventAutomationComposerContent
            model={{
                ...model,
                availableObservationTransports: ['durablePush'],
                observationTransport: 'durablePush',
            }}
        />);
        expect(screen.findByProps({ testID: 'automation-event-watcher-picker' }).props.accessibilityLabel)
            .toBe('automations.form.trigger.receiveOn');
        await screen.update(<PluginEventAutomationComposerContent
            model={{
                ...model,
                sourceStatus: 'unavailable',
                sourceFailure: {
                    code: 'channels_connection_required',
                    reason: 'channels_connection_required',
                    remediation: {
                        kind: 'openSettings',
                        path: '/settings/plugins/happier.channels/connections',
                    },
                },
            }}
        />);
        expect(screen.findByProps({ testID: 'automation-event-source-open-settings' }).props.accessibilityRole)
            .toBe('button');
    });

    // MF-4: the setup step shows the choices a person makes (which Event, which Machine, Only when);
    // payload pointers, the sample, the source id and the observation age are support's words, on request only.
    it('keeps implementation fields under Technical details', async () => {
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');
        const { TechnicalDetailsDisclosure } = await import('@/components/ui/lists/TechnicalDetailsDisclosure');
        const model: PluginEventAutomationComposerModel = {
            ...composerModel(),
            filterValid: true,
            sourceStatus: 'configured',
            sourceInstanceId: 'source-instance-7',
            maximumObservationAgeMsText: '30000',
        };
        const screen = await renderScreen(<PluginEventAutomationComposerContent model={model} />);
        expect(screen.findAllByProps({ testID: 'automation-event-payload-browser' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'automation-event-maximum-observation-age-input' })).toHaveLength(0);
        const details = screen.findAllByType(TechnicalDetailsDisclosure)
            .find((node) => node.props.testID === 'automation-event-technical-details');
        const values = (details?.props.lines as ReadonlyArray<{ value: string }>).map((line) => line.value);
        expect(values).toEqual(expect.arrayContaining(['/action', '30000']));
    });
});
