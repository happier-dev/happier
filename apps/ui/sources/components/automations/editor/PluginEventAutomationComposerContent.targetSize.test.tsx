import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

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

function flattenStyle(value: unknown): Record<string, unknown> {
    if (!value) return {};
    if (Array.isArray(value)) {
        return value.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }
    return typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** The WCAG 2.2 pointer floor every control draws at; a finger's target is a hit area, never the drawn box. */
const DRAWN_FLOOR = 24;

function readDrawnStyle(node: Readonly<{ props: { style?: unknown } }>): Record<string, unknown> {
    const rawStyle = typeof node.props.style === 'function'
        ? node.props.style({ pressed: false })
        : node.props.style;
    return flattenStyle(rawStyle);
}

describe('PluginEventAutomationComposerContent interactive targets', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('cancelAnimationFrame', () => {});
    });

    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
        platformState.os = 'android';
    });

    it.each([
        ['iOS', 'ios', 44],
        ['Android', 'android', 48],
    ] as const)('draws every Event composer control at its design size and reaches the %s target by hit area', async (_label, platform, minimum) => {
        platformState.os = platform;
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        vi.resetModules();
        const { PluginEventAutomationComposerContent } = await import('./PluginEventAutomationComposerContent');
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
        const model: PluginEventAutomationComposerModel = {
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
            invalidateConfiguredSource: vi.fn(),
            revision: 0,
        };
        const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const { act } = await import('react-test-renderer');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                <PluginEventAutomationComposerContent model={model} />
            </HappierUiPlatformProvider>,
        );
        const controls = [
            'automation-event-picker',
            'automation-event-watcher-picker',
            'automation-event-configure-source',
            'automation-event-filter-add-clause',
            'automation-event-filter-clause-filter-0-field-picker',
            'automation-event-filter-clause-filter-0-operator-picker',
            'automation-event-filter-clause-filter-0-remove',
        ];
        // The filter value and maximum-age fields are `FieldTextInput`s: their touch floor is that
        // owner's (native 44/48, none on web; `FieldTextInput` owner tests), not a second one here.
        for (const testID of ['automation-event-filter-clause-filter-0-value', 'automation-event-maximum-observation-age-input']) {
            expect(screen.findByProps({ testID }).type).toBe(FieldTextInput);
        }

        for (const testID of controls) {
            const drawn = readDrawnStyle(screen.findByProps({ testID }));
            expect(drawn.minWidth, `${testID} drawn width`).toBe(DRAWN_FLOOR);
            expect(drawn.minHeight, `${testID} drawn height`).toBe(DRAWN_FLOOR);

            // Under a finger the shared hit area (native hit slop) reaches the platform target past the drawn box.
            const host = screen.findHostByTestId(testID)!;
            await act(async () => {
                host.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 40, height: 36 } } });
            });
            const slop = screen.findHostByTestId(testID)!.props.hitSlop as Record<'top' | 'bottom' | 'left' | 'right', number>;
            expect(36 + slop.top + slop.bottom, `${testID} hit height`).toBe(minimum);
            expect(40 + slop.left + slop.right, `${testID} hit width`).toBe(minimum);
        }

        // The opened option rows are now owned by the shared virtualized
        // SelectionList, whose target sizing is covered at that canonical
        // owner. This suite retains the Event composer's own trigger controls.
    });
});
