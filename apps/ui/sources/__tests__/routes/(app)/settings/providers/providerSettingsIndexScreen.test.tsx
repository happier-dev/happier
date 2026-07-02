import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providerCatalogProjection from '@/agents/backendCatalog/providerCatalogProjection';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from '../sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());
const providerSetupFlowPropsSpy = vi.hoisted(() => vi.fn());
const activeServerSnapshotState = vi.hoisted(() => ({
    value: {
        serverId: 'server-a',
        serverUrl: 'http://localhost:3000',
        generation: 1,
    },
}));
const allMachinesState = vi.hoisted(() => ({
    value: [{
        id: 'machine-1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    }] as Machine[],
}));
const machineListByServerIdState = vi.hoisted(() => ({
    value: {
        'server-a': [{
            id: 'machine-1',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
        }],
    } as Record<string, Machine[] | null>,
}));

installSessionSettingsEntryModuleMocks({
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#999',
                },
            },
        });
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'backendEnabledByTargetKey') return {};
                    return undefined;
                },
                useAllMachines: () => allMachinesState.value,
                useMachineListByServerId: () => machineListByServerIdState.value,
            },
        });
    },
});

vi.mock('@/components/settings/acpCatalog/AcpCatalogSettingsSections', () => ({
    AcpCatalogSettingsSections: () => React.createElement('AcpCatalogSettingsSections'),
}));

vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => {
        providerSetupFlowPropsSpy(props);
        return React.createElement('ProviderSetupFlow', props);
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.value,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) =>
        machineContributionRegistryProjectionDescribeMock(...args),
}));

vi.mock('@/agents/catalog/providerSettingsCatalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/providerSettingsCatalog')>();
    return actual;
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['legacy.codex', 'legacy.claude'],
    isAgentId: (agentId: string) => ['codex', 'claude', 'customAcp', 'kiro'].includes(agentId),
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agent.${agentId}`,
        availability: { experimental: agentId === 'kiro' },
        ui: {
            agentPickerIconName: agentId === 'claude'
                ? 'sparkles-outline'
                : agentId === 'codex'
                    ? 'code-slash-outline'
                    : 'layers-outline',
        },
    }),
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
}));

afterEach(() => {
    resetSessionSettingsEntryState();
    standardCleanup();
});

describe('ProviderSettingsIndexScreen', () => {
    afterEach(() => {
        activeServerSnapshotState.value = {
            serverId: 'server-a',
            serverUrl: 'http://localhost:3000',
            generation: 1,
        };
        allMachinesState.value = [{
            id: 'machine-1',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        }];
        machineListByServerIdState.value = {
            'server-a': [{
                id: 'machine-1',
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            }],
        };
    });

    it('renders merged provider rows from the descriptor projection without relying on built-in registry lists', async () => {
        const getResolvedProviderCatalogEntriesSpy = vi.spyOn(providerCatalogProjection, 'getResolvedProviderCatalogEntries');
        const Screen = (await import('@/app/(app)/settings/providers')).default;

        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderSettingsView(React.createElement(Screen));

        expect(getResolvedProviderCatalogEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            enabledAgentIds: [],
        }));

        // Proves the screen is wired to the daemon-fed merged projection inputs (Packet E/B7),
        // even though this test mocks providerCatalogProjection output.
        await act(async () => {});
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
        expect(getResolvedProviderCatalogEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            mergedProviderProjectionById: expect.objectContaining({
                'acme.review.provider': expect.objectContaining({ title: 'Acme Review Provider' }),
            }),
        }));
        expect(providerSetupFlowPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            providerEntries: expect.arrayContaining([
                expect.objectContaining({
                    providerId: 'acme.review.provider',
                    providerAgentId: 'claude',
                    title: 'Acme Review Provider',
                    iconAgentId: 'codex',
                    iconName: 'code-slash-outline',
                }),
            ]),
        }));

        expect(screen.findRowByTitle('Codex')).toBeTruthy();
        expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy();
        expect(screen.findRowByTitle('agent.customAcp')).toBeFalsy();
        expect(screen.findRowByTitle('Acme Review Provider')?.props.icon?.props?.name).toBe('code-slash-outline');

        const acpSections = screen.findAllByType('AcpCatalogSettingsSections' as any);
        expect(acpSections).toHaveLength(1);

        await act(async () => {
            screen.pressRowByTitle('Codex');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers/codex');

        await act(async () => {
            screen.pressRowByTitle('Acme Review Provider');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers/acme.review.provider');
        getResolvedProviderCatalogEntriesSpy.mockRestore();
    });

    it('refetches daemon provider projection data when the active server changes for the same machine', async () => {
        const Screen = (await import('@/app/(app)/settings/providers')).default;

        allMachinesState.value = [{
            id: 'machine-1',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        }];
        machineListByServerIdState.value = {
            'server-x': [{
                id: 'machine-1',
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            }],
            'server-y': [{
                id: 'machine-1',
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            }],
        };
        activeServerSnapshotState.value = {
            serverId: 'server-x',
            serverUrl: 'http://localhost:3100',
            generation: 1,
        };
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-x',
        }));

        machineContributionRegistryProjectionDescribeMock.mockClear();
        activeServerSnapshotState.value = {
            serverId: 'server-y',
            serverUrl: 'http://localhost:4000',
            generation: 2,
        };

        await act(async () => {
            screen.tree.update(React.createElement(Screen, { key: 'server-b' } as any));
        });
        await act(async () => {});

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-y',
        }));
    });

    it('uses a machine scoped to the active server instead of a globally active machine from another server', async () => {
        const Screen = (await import('@/app/(app)/settings/providers')).default;

        allMachinesState.value = [
            {
                id: 'machine-other',
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            },
            {
                id: 'machine-server-a',
                seq: 2,
                createdAt: 0,
                updatedAt: 0,
                active: false,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ];
        machineListByServerIdState.value = {
            'server-a': [{
                id: 'machine-server-a',
                seq: 2,
                createdAt: 0,
                updatedAt: 0,
                active: false,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            }],
            'server-b': [{
                id: 'machine-other',
                seq: 1,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                activeAt: 0,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            }],
        };
        activeServerSnapshotState.value = {
            serverId: 'server-a',
            serverUrl: 'http://localhost:3000',
            generation: 1,
        };
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-server-a', expect.objectContaining({
            serverId: 'server-a',
        }));
        expect(machineContributionRegistryProjectionDescribeMock).not.toHaveBeenCalledWith('machine-other', expect.anything());
    });

    it('forwards projected plugin providers into setup even when they do not expose a built-in runtime carrier', async () => {
        const getResolvedProviderCatalogEntriesSpy = vi.spyOn(providerCatalogProjection, 'getResolvedProviderCatalogEntries');
        getResolvedProviderCatalogEntriesSpy.mockReturnValue([{
            providerId: 'acme.headless.provider',
            providerAgentId: null,
            iconAgentId: 'claude',
            iconName: 'layers-outline',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            enabled: null,
            isBuiltIn: false,
            backendTargetKey: null,
            descriptor: null,
            behavior: null,
            authPlugin: null,
        }]);

        const Screen = (await import('@/app/(app)/settings/providers')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        expect(providerSetupFlowPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            providerEntries: expect.arrayContaining([
                expect.objectContaining({
                    providerId: 'acme.headless.provider',
                    providerAgentId: null,
                    iconAgentId: 'claude',
                }),
            ]),
        }));
        expect(screen.findRowByTitle('Acme Headless Provider')?.props.icon?.props?.name).toBe('sparkles-outline');

        getResolvedProviderCatalogEntriesSpy.mockRestore();
    });
});
