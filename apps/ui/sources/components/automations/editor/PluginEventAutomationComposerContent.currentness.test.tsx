import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
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
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

function createModel(options: Readonly<{
    eventAvailable?: boolean;
    watcherCurrent?: boolean;
    filterValid?: boolean;
    maximumObservationAgeMsValid?: boolean;
}> = {}): PluginEventAutomationComposerModel {
    const eventAvailable = options.eventAvailable ?? false;
    const watcherCurrent = options.watcherCurrent ?? true;
    const filterValid = options.filterValid ?? true;
    const maximumObservationAgeMsValid = options.maximumObservationAgeMsValid ?? true;
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
        validation: watcherCurrent ? { kind: 'admitted' } : { kind: 'rejected', reason: 'offline' },
    }] satisfies readonly PluginMachineExecutionOriginCandidateV1[];

    return {
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
            availability: eventAvailable ? 'available' : 'unavailable',
            installedPackage: null,
            expectedGeneration: null,
            machineId: null,
            serverId: null,
            accountLifetime: null,
            isCurrent: () => false,
        }),
        sourceStatus: 'configured',
        sourceDisplayLabel: 'acme/widgets',
        sourceInstanceId: 'repository:42',
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
        filterClauses: [],
        addFilterClause: vi.fn(),
        removeFilterClause: vi.fn(),
        setFilterClauseField: vi.fn(),
        setFilterClauseOperator: vi.fn(),
        setFilterClauseValueText: vi.fn(),
        filterValid,
        maximumObservationAgeMsText: '',
        setMaximumObservationAgeMsText: vi.fn(),
        maximumObservationAgeMsValid,
        createDraft: null,
        revision: 0,
    };
}

describe('PluginEventAutomationComposerContent currentness', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not present a stale configured source as ready to reconfigure', async () => {
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');

        const screen = await renderScreen(<PluginEventAutomationComposerContent model={createModel()} />);

        expect(screen.findByProps({ testID: 'automation-event-configure-source' }).props.disabled).toBe(true);
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.children)
            .toBe('automations.form.trigger.sourceUnavailable');
    });

    it('keeps the recovery state honest when the selected watcher is no longer admitted', async () => {
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');

        const screen = await renderScreen(
            <PluginEventAutomationComposerContent model={createModel({ eventAvailable: true, watcherCurrent: false })} />,
        );

        expect(screen.findByProps({ testID: 'automation-event-configure-source' }).props.disabled).toBe(true);
        expect(screen.findByProps({ testID: 'automation-event-source-unavailable' }).props.children)
            .toBe('automations.form.trigger.sourceUnavailable');
    });

    it('does not invite a source setup Action while the Event filter is invalid', async () => {
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');

        const screen = await renderScreen(
            <PluginEventAutomationComposerContent model={createModel({
                eventAvailable: true,
                filterValid: false,
            })}
            />,
        );

        const configure = screen.findByProps({ testID: 'automation-event-configure-source' });
        expect(configure.props.disabled).toBe(true);
        expect(configure.props.accessibilityState).toMatchObject({ disabled: true });
        expect(configure.props.accessibilityHint).toBe('automations.form.trigger.eventFilterInvalid');
        expect(screen.findAllByProps({ testID: 'automation-event-source-unavailable' })).toHaveLength(0);
    });
});
