import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol';

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

vi.mock('@/components/plugins/shared/InstalledPluginBrandMark', () => ({
    InstalledPluginBrandMark: () => null,
}));
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

describe('PluginEventAutomationComposerContent accessibility', () => {
    it('gives Event composer failures usable screen-reader semantics', async () => {
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');
        const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            event: {
                id: 'acme.github/events/repository',
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
        const model: PluginEventAutomationComposerModel = {
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
                fields: [{ pointer: '/action', scalarKind: 'string', sampleValue: 'opened' }],
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
            maximumObservationAgeMsValid: false,
            createDraft: null,
            invalidateConfiguredSource: vi.fn(),
            revision: 0,
        };

        const screen = await renderScreen(<PluginEventAutomationComposerContent model={model} />);

        expect(screen.findByProps({ testID: 'automation-event-filter-clause-filter-0-value' }).props.accessibilityLabel)
            .toBe('settingsPlugins.eventAutomationComposer.filterValue');
        expect(screen.findByProps({ testID: 'automation-event-maximum-observation-age-input' }).props.accessibilityLabel)
            .toBe('automations.form.trigger.maximumObservationAge');
        expect(screen.findByProps({ testID: 'automation-event-configure-source' }).props.accessibilityHint)
            .toBe('automations.form.trigger.sourceUnavailable');
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.accessibilityRole)
            .toBe('alert');
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.accessibilityLiveRegion)
            .toBe('polite');
        expect(screen.findByProps({ testID: 'automation-event-filter-clause-filter-0-value' }).props.accessibilityHint)
            .toBe('automations.form.trigger.eventFilterInvalid');
        expect(screen.findByProps({ testID: 'automation-event-maximum-observation-age-input' }).props.accessibilityHint)
            .toBe('automations.form.trigger.maximumObservationAgeInvalid');
        const alertTexts = screen.findAll((node) => (
            String(node.type) === 'Text' && node.props.accessibilityRole === 'alert'
        ));
        const politeAlertTexts = screen.findAll((node) => (
            String(node.type) === 'Text' && node.props.accessibilityLiveRegion === 'polite'
        ));
        expect(alertTexts).toHaveLength(3);
        expect(politeAlertTexts).toHaveLength(3);

        expect(screen.findByProps({ testID: 'automation-event-watcher-picker' }).props.accessibilityLabel)
            .toBe('automations.detail.event.watcherTitle');
        await screen.update(<PluginEventAutomationComposerContent
            model={{
                ...model,
                availableObservationTransports: ['durablePush'],
                observationTransport: 'durablePush',
            }}
        />);
        expect(screen.findByProps({ testID: 'automation-event-watcher-picker' }).props.accessibilityLabel)
            .toBe('automations.detail.event.observationPlacementTitle');
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
});
