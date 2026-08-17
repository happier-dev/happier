import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentCatalogProjection from '@/agents/backendCatalog/agentCatalogProjection';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from '../sessionSettingsEntryTestHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());
const agentSetupFlowPropsSpy = vi.hoisted(() => vi.fn());
const administrationTargetState = vi.hoisted(() => ({
    selectedTarget: {
        serverIdentityId: 'server-a',
        machineId: 'machine-1',
    } as { serverIdentityId: string; machineId: string } | null,
    executionTarget: {
        target: {
            serverIdentityId: 'server-a',
            machineId: 'machine-1',
        },
        serverId: 'server-a',
        machine: {
            id: 'machine-1',
            metadata: null,
            daemonStateVersion: 0,
        },
    } as {
        target: { serverIdentityId: string; machineId: string };
        serverId: string;
        machine: { id: string; metadata: null; daemonStateVersion: number };
    } | null,
}));
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
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'backendEnabledByTargetKey') return {};
                    return undefined;
                } }),
                useAllMachines: () => allMachinesState.value,
                useMachineListByServerId: () => machineListByServerIdState.value,
            },
        });
    },
});

vi.mock('@/components/settings/acpCatalog/AcpCatalogSettingsSections', () => ({
    AcpCatalogSettingsSections: () => React.createElement('AcpCatalogSettingsSections'),
}));

vi.mock('@/components/settings/agents/setup/AgentSetupFlow', () => ({
    AgentSetupFlow: (props: Record<string, unknown>) => {
        agentSetupFlowPropsSpy(props);
        return React.createElement('AgentSetupFlow', props);
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.value,
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: administrationTargetState.selectedTarget,
        resolveExecutionTarget: () => administrationTargetState.executionTarget,
    }),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) =>
        machineContributionRegistryProjectionDescribeMock(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

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

beforeEach(() => {
    administrationTargetState.selectedTarget = {
        serverIdentityId: 'server-a',
        machineId: 'machine-1',
    };
    administrationTargetState.executionTarget = {
        target: {
            serverIdentityId: 'server-a',
            machineId: 'machine-1',
        },
        serverId: 'server-a',
        machine: {
            id: 'machine-1',
            metadata: null,
            daemonStateVersion: 0,
        },
    };
    agentSetupFlowPropsSpy.mockReset();
});

afterEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    resetSessionSettingsEntryState();
    standardCleanup();
});

describe('PluginAgentSettingsIndexScreen', () => {
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
        const getResolvedAgentCatalogEntriesSpy = vi.spyOn(agentCatalogProjection, 'getResolvedAgentCatalogEntries');
        const Screen = (await import('@/app/(app)/settings/agents')).default;

        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderSettingsView(React.createElement(Screen));

        expect(getResolvedAgentCatalogEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            enabledAgentIds: [],
        }));

        // Proves the screen is wired to the daemon-fed merged projection inputs (Packet E/B7),
        // even though this test mocks agentCatalogProjection output.
        await act(async () => {});
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
        expect(getResolvedAgentCatalogEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            mergedProviderProjectionById: expect.objectContaining({
                'acme.review.provider': expect.objectContaining({ title: 'Acme Review Provider' }),
            }),
        }));
        expect(agentSetupFlowPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            agentEntries: expect.arrayContaining([
                expect.objectContaining({
                    agentId: 'acme.review.provider',
                    catalogAgentId: 'claude',
                    title: 'Acme Review Provider',
                    iconAgentId: 'codex',
                    iconName: 'code-slash-outline',
                }),
            ]),
        }));

        expect(screen.findRowByTitle('Codex')).toBeFalsy();
        expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy();
        expect(screen.findRowByTitle('Acme Review Provider')?.props.subtitle).toContain(
            'settingsAgents.channelPlugin',
        );
        expect(screen.findRowByTitle('agent.customAcp')).toBeFalsy();
        expect(screen.findRowByTitle('Acme Review Provider')?.props.icon?.props?.name).toBe('code-slash-outline');

        const acpSections = screen.findAllByType('AcpCatalogSettingsSections' as any);
        expect(acpSections).toHaveLength(1);

        await act(async () => {
            screen.pressRowByTitle('Acme Review Provider');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/acme.review.provider');
        getResolvedAgentCatalogEntriesSpy.mockRestore();
    });

    it('refetches daemon provider projection data when the canonical target changes for the same machine', async () => {
        const Screen = (await import('@/app/(app)/settings/agents')).default;

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
        administrationTargetState.selectedTarget = {
            serverIdentityId: 'server-x',
            machineId: 'machine-1',
        };
        administrationTargetState.executionTarget = {
            target: {
                serverIdentityId: 'server-x',
                machineId: 'machine-1',
            },
            serverId: 'server-x',
            machine: {
                id: 'machine-1',
                metadata: null,
                daemonStateVersion: 0,
            },
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
        administrationTargetState.selectedTarget = {
            serverIdentityId: 'server-y',
            machineId: 'machine-1',
        };
        administrationTargetState.executionTarget = {
            target: {
                serverIdentityId: 'server-y',
                machineId: 'machine-1',
            },
            serverId: 'server-y',
            machine: {
                id: 'machine-1',
                metadata: null,
                daemonStateVersion: 0,
            },
        };

        await act(async () => {
            screen.tree.update(React.createElement(Screen, { key: 'server-b' } as any));
        });
        await act(async () => {});

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-y',
        }));
    });

    it('keeps the previous projected provider rows visible while a new canonical-target projection loads', async () => {
        const Screen = (await import('@/app/(app)/settings/agents')).default;

        allMachinesState.value = [
            {
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
            },
            {
                id: 'machine-2',
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
        ];
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
                id: 'machine-2',
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
        administrationTargetState.selectedTarget = {
            serverIdentityId: 'server-x',
            machineId: 'machine-1',
        };
        administrationTargetState.executionTarget = {
            target: {
                serverIdentityId: 'server-x',
                machineId: 'machine-1',
            },
            serverId: 'server-x',
            machine: {
                id: 'machine-1',
                metadata: null,
                daemonStateVersion: 0,
            },
        };
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy();

        let resolveReload!: (value: {
            supported: true;
            projection: typeof PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE;
        }) => void;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise((resolve) => {
            resolveReload = resolve;
        }));
        administrationTargetState.selectedTarget = {
            serverIdentityId: 'server-y',
            machineId: 'machine-2',
        };
        administrationTargetState.executionTarget = {
            target: {
                serverIdentityId: 'server-y',
                machineId: 'machine-2',
            },
            serverId: 'server-y',
            machine: {
                id: 'machine-2',
                metadata: null,
                daemonStateVersion: 0,
            },
        };

        await act(async () => {
            screen.tree.update(React.createElement(Screen, { refresh: 'server-y' } as any));
        });
        await act(async () => {});

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'server-y',
        }));
        expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy();

        await act(async () => {
            resolveReload({
                supported: true,
                projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            });
        });
    });

    it('uses the exact canonical Administration target instead of an active-server or global-machine fallback', async () => {
        const Screen = (await import('@/app/(app)/settings/agents')).default;

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
        administrationTargetState.selectedTarget = {
            serverIdentityId: 'server-selected',
            machineId: 'machine-selected',
        };
        administrationTargetState.executionTarget = {
            target: {
                serverIdentityId: 'server-selected',
                machineId: 'machine-selected',
            },
            serverId: 'server-selected',
            machine: {
                id: 'machine-selected',
                metadata: null,
                daemonStateVersion: 0,
            },
        };
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-selected', expect.objectContaining({
            serverId: 'server-selected',
        }));
        expect(machineContributionRegistryProjectionDescribeMock).not.toHaveBeenCalledWith('machine-other', expect.anything());
        expect(agentSetupFlowPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-selected',
            serverId: 'server-selected',
        }));
    });

    it('forwards projected plugin providers into setup even when they do not expose a built-in runtime carrier', async () => {
        const getResolvedAgentCatalogEntriesSpy = vi.spyOn(agentCatalogProjection, 'getResolvedAgentCatalogEntries');
        getResolvedAgentCatalogEntriesSpy.mockReturnValue([{
            agentId: 'acme.headless.provider',
            catalogAgentId: null,
            iconAgentId: 'claude',
            iconName: 'stack-simple',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            enabled: null,
            isBuiltIn: false,
            backendTargetKey: null,
            authPlugin: null,
        }]);

        const Screen = (await import('@/app/(app)/settings/agents')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        expect(agentSetupFlowPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            agentEntries: expect.arrayContaining([
                expect.objectContaining({
                    agentId: 'acme.headless.provider',
                    catalogAgentId: null,
                    iconAgentId: 'claude',
                }),
            ]),
        }));
        expect(screen.findRowByTitle('Acme Headless Provider')?.props.icon?.props?.name).toBe('sparkles-outline');

        getResolvedAgentCatalogEntriesSpy.mockRestore();
    });

    it('renders an explicit unavailable row instead of a blank page when no provider rows resolve', async () => {
        const getResolvedAgentCatalogEntriesSpy = vi.spyOn(agentCatalogProjection, 'getResolvedAgentCatalogEntries');
        getResolvedAgentCatalogEntriesSpy.mockReturnValue([]);
        activeServerSnapshotState.value = {
            serverId: null as unknown as string,
            serverUrl: '',
            generation: 2,
        };
        allMachinesState.value = [];
        machineListByServerIdState.value = {};
        administrationTargetState.selectedTarget = null;
        administrationTargetState.executionTarget = null;

        const Screen = (await import('@/app/(app)/settings/agents')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        expect(screen.findRowByTitle('settingsAgents.notAvailable')).toBeTruthy();
        expect(screen.findAllByType('AcpCatalogSettingsSections' as any)).toHaveLength(1);

        getResolvedAgentCatalogEntriesSpy.mockRestore();
    });
});
