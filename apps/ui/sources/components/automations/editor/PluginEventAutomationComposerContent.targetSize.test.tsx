import * as React from 'react';
import { act } from 'react-test-renderer';
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

const platformState = vi.hoisted(() => ({
    os: 'android' as 'ios' | 'android',
}));

installAutomationComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: platformState.os });
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

function flattenStyle(value: unknown): Record<string, unknown> {
    if (!value) return {};
    if (Array.isArray(value)) {
        return value.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }
    return typeof value === 'object' ? value as Record<string, unknown> : {};
}

function expectMinimumInteractiveTarget(
    node: Readonly<{ props: { style?: unknown } }>,
    minimum: number,
): void {
    const rawStyle = typeof node.props.style === 'function'
        ? node.props.style({ pressed: false })
        : node.props.style;
    const style = flattenStyle(rawStyle);
    expect(style.minWidth).toBeGreaterThanOrEqual(minimum);
    expect(style.minHeight).toBeGreaterThanOrEqual(minimum);
}

describe('PluginEventAutomationComposerContent interactive targets', () => {
    afterEach(() => {
        standardCleanup();
        platformState.os = 'android';
    });

    it.each([
        ['iOS', 'ios', 44],
        ['Android', 'android', 48],
    ] as const)('uses the canonical %s minimum for every Event composer control', async (_label, platform, minimum) => {
        platformState.os = platform;
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        vi.resetModules();
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
        };
        const screen = await renderScreen(<PluginEventAutomationComposerContent model={model} />);
        const controls = [
            'automation-trigger-schedule',
            'automation-trigger-event',
            'automation-event-target-new-session',
            'automation-event-target-existing-session',
            'automation-event-target-execution-run',
            'automation-event-picker',
            'automation-event-watcher-picker',
            'automation-event-configure-source',
            'automation-event-filter-add-clause',
            'automation-event-filter-clause-filter-0-field-picker',
            'automation-event-filter-clause-filter-0-operator-picker',
            'automation-event-filter-clause-filter-0-remove',
            'automation-event-filter-clause-filter-0-value',
            'automation-event-maximum-observation-age-input',
        ];

        for (const testID of controls) {
            expectMinimumInteractiveTarget(screen.findByProps({ testID }), minimum);
        }

        await act(async () => {
            screen.findByProps({ testID: 'automation-event-picker' }).props.onPress();
            screen.findByProps({ testID: 'automation-event-watcher-picker' }).props.onPress();
            screen.findByProps({ testID: 'automation-event-filter-clause-filter-0-field-picker' }).props.onPress();
        });

        for (const testID of [
            'automation-event-option-acme.github/events/repository',
            'automation-event-watcher-option-watcher-machine:github-materialization',
            'automation-event-filter-clause-filter-0-field-option-/action',
        ]) {
            expectMinimumInteractiveTarget(screen.findByProps({ testID }), minimum);
        }

        await act(async () => {
            screen.findByProps({ testID: 'automation-event-filter-clause-filter-0-operator-picker' }).props.onPress();
        });

        for (const testID of [
            'automation-event-filter-clause-filter-0-operator-option-eq',
            'automation-event-filter-clause-filter-0-operator-option-in',
        ]) {
            expectMinimumInteractiveTarget(screen.findByProps({ testID }), minimum);
        }
    });
});
