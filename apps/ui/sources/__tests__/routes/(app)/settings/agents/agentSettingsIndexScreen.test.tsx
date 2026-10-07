import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentCatalogProjection from '@/agents/backendCatalog/agentCatalogProjection';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol';
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

const daemonProjectionResponseBoundary = vi.hoisted(() => vi.fn());
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

function createQualifiedExternalAgentProjection() {
    const agent = PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'];
    if (!agent) throw new Error('Expected the external Agent fixture to be complete.');

    return {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        agentsById: {
            'acme.review/provider': {
                ...agent,
                id: 'acme.review/provider',
            },
        },
    };
}

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

const acpCatalogState = vi.hoisted(() => ({
    backends: [] as Array<{ id: string; name: string; title?: string; command: string; args: string[] }>,
}));

vi.mock('@/components/settings/acpCatalog/AcpCatalogSettingsSections', () => ({
    useAcpCatalogBackends: () => ({ backends: acpCatalogState.backends, deleteBackend: async () => {} }),
    formatAcpBackendCommand: (command: string, args: readonly string[]) => [command, ...args].join(' '),
}));


vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.value,
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: administrationTargetState.selectedTarget,
        resolveExecutionTarget: () => administrationTargetState.executionTarget,
        pickerRows: [],
        candidates: [],
    }),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));

// The daemon RPC boundary publishes schema-valid envelopes; projection parsing,
// Account binding, invalidation and catalog loading remain the real owners.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async (params) => {
        if (params.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            throw new Error(`Unexpected Agent index RPC: ${params.method}`);
        }
        const response = await daemonProjectionResponseBoundary(params.machineId, { serverId: params.serverId });
        if (response.supported !== true) return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection: response.projection,
        });
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['legacy.codex', 'legacy.claude'],
    isBundledAgentId: (agentId: string) => ['codex', 'claude', 'customAcp', 'kiro'].includes(agentId),
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

/** A collection row's mark: the agent identity icon inside its mark slot. */
function readIdentityIcon(icon: React.ReactElement<{ children?: React.ReactNode }> | undefined): any {
    return React.Children.toArray(icon?.props.children)
        .find((child) => React.isValidElement(child) && child.type === AgentCatalogIdentityIcon);
}

installDisconnectedServerSocketBoundary();
let restoreCredentials: (() => void) | undefined;

beforeEach(async () => {
    await loadSyncSingletonForTests();
    for (const id of ['server-a', 'server-x', 'server-y', 'server-b', 'server-selected']) {
        const home = await upsertServerProfile({ serverUrl: `https://${id}`, name: id });
        if (home.id !== id) throw new Error(`Unexpected test Home id: ${home.id}`);
    }
    const credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl')
        .mockResolvedValue({ token: createAccountTokenForTests('account-a') });
    restoreCredentials = () => credentialBoundary.mockRestore();
    clearActiveUnsavedChangesGuard();
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
    acpCatalogState.backends = [];
});

afterEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    resetSessionSettingsEntryState();
    standardCleanup();
    restoreCredentials?.();
    restoreCredentials = undefined;
    clearActiveUnsavedChangesGuard();
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
        const projection = createQualifiedExternalAgentProjection();

        daemonProjectionResponseBoundary.mockReset();
        daemonProjectionResponseBoundary.mockResolvedValue({
            supported: true,
            projection,
        });

        const screen = await renderSettingsView(React.createElement(Screen));

        expect(getResolvedAgentCatalogEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            enabledAgentIds: [],
        }));

        // Proves the screen is wired to the daemon-fed merged projection inputs (Packet E/B7),
        // even though this test mocks agentCatalogProjection output.
        await act(async () => {});
        await vi.waitFor(() => expect(daemonProjectionResponseBoundary).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        })));
        expect(getResolvedAgentCatalogEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            mergedProviderProjectionById: expect.objectContaining({
                'acme.review/provider': expect.objectContaining({
                    identity: { pluginId: 'acme.review', localId: 'provider' },
                    title: 'Acme Review Provider',
                }),
            }),
        }));
        expect(screen.findRowByTitle('Codex')).toBeFalsy();
        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());
        // The machine has not reported on this agent yet: no guessed status line.
        expect(screen.findRowByTitle('Acme Review Provider')?.props.subtitle).toBeUndefined();
        expect(screen.findRowByTitle('agent.customAcp')).toBeFalsy();
        const projectedIcon = readIdentityIcon(screen.findRowByTitle('Acme Review Provider')?.props.icon);
        expect(projectedIcon?.type).toBe(AgentCatalogIdentityIcon);
        expect(projectedIcon?.props.entry).toEqual(expect.objectContaining({
            qualifiedId: 'acme.review/provider',
            identity: { pluginId: 'acme.review', localId: 'provider' },
        }));

        await act(async () => {
            screen.pressRowByTitle('Acme Review Provider');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/provider?pluginId=acme.review');
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
        daemonProjectionResponseBoundary.mockReset();
        daemonProjectionResponseBoundary.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        await vi.waitFor(() => expect(daemonProjectionResponseBoundary).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-x',
        })));

        daemonProjectionResponseBoundary.mockClear();
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

        await vi.waitFor(() => expect(daemonProjectionResponseBoundary).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-y',
        })));
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
        daemonProjectionResponseBoundary.mockReset();
        daemonProjectionResponseBoundary.mockResolvedValueOnce({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());

        let resolveReload!: (value: {
            supported: true;
            projection: typeof PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE;
        }) => void;
        daemonProjectionResponseBoundary.mockImplementation(() => new Promise((resolve) => {
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

        await vi.waitFor(() => expect(daemonProjectionResponseBoundary).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'server-y',
        })));
        expect(screen.findRowByTitle('Acme Review Provider')).toBeFalsy();

        await act(async () => {
            resolveReload({
                supported: true,
                projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            });
        });
        await act(async () => {});

        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());
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
        daemonProjectionResponseBoundary.mockReset();
        daemonProjectionResponseBoundary.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        await renderSettingsView(React.createElement(Screen));
        await act(async () => {});

        await vi.waitFor(() => expect(daemonProjectionResponseBoundary).toHaveBeenCalledWith('machine-selected', expect.objectContaining({
            serverId: 'server-selected',
        })));
        expect(daemonProjectionResponseBoundary).not.toHaveBeenCalledWith('machine-other', expect.anything());
    });

    it('lists projected plugin agents even when they do not expose a built-in runtime carrier', async () => {
        const getResolvedAgentCatalogEntriesSpy = vi.spyOn(agentCatalogProjection, 'getResolvedAgentCatalogEntries');
        getResolvedAgentCatalogEntriesSpy.mockReturnValue([{
            agentId: 'acme.headless.provider',
            qualifiedId: 'acme.headless.provider',
            identity: null,
            installedPackage: null,
            projectionGeneration: null,
            catalogAgentId: null,
            iconAgentId: 'claude',
            iconName: 'stack-simple',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            enabled: null,
            isBuiltIn: false,
            backendTargetKey: null,
            descriptor: null,
            behavior: null,
            authPlugin: null,
            cliAuthBackgroundCheckSafe: false,
            connectedAccounts: [],
        }]);

        const Screen = (await import('@/app/(app)/settings/agents')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        const projectedIcon = readIdentityIcon(screen.findRowByTitle('Acme Headless Provider')?.props.icon);
        expect(projectedIcon?.type).toBe(AgentCatalogIdentityIcon);
        expect(projectedIcon?.props.entry).toEqual(expect.objectContaining({
            qualifiedId: 'acme.headless.provider',
            identity: null,
            iconAgentId: 'claude',
        }));

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

        getResolvedAgentCatalogEntriesSpy.mockRestore();
    });

    it('lists custom ACP agents as their own group and opens the definition editor', async () => {
        const getResolvedAgentCatalogEntriesSpy = vi.spyOn(agentCatalogProjection, 'getResolvedAgentCatalogEntries');
        getResolvedAgentCatalogEntriesSpy.mockReturnValue([]);
        acpCatalogState.backends = [{ id: 'acp-1', name: 'my-acp', title: 'My ACP agent', command: 'my-acp', args: ['--stdio'] }];

        const Screen = (await import('@/app/(app)/settings/agents')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        expect(screen.findRowByTitle('settingsAgents.notAvailable')).toBeFalsy();
        expect(screen.findGroup('settingsAgents.collection.customAgents')).toBeTruthy();
        expect(screen.findRowByTitle('My ACP agent')?.props.subtitle).toBe('my-acp --stdio');
        await act(async () => {
            screen.pressRowByTitle('My ACP agent');
        });
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/acp-1');
        getResolvedAgentCatalogEntriesSpy.mockRestore();
    });

    it('offers adding an ACP agent or asking an agent to add one, and sends askers without a machine to machine setup', async () => {
        const getResolvedAgentCatalogEntriesSpy = vi.spyOn(agentCatalogProjection, 'getResolvedAgentCatalogEntries');
        getResolvedAgentCatalogEntriesSpy.mockReturnValue([]);

        const Screen = (await import('@/app/(app)/settings/agents')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        const menu = screen.findAll((node) => node.props?.testID === 'settings-agents-collection.addMenu'
            && typeof node.props?.onSelect === 'function')[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['acp', 'askAgent']);
        await act(async () => {
            menu?.props.onSelect('acp');
        });
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom');
        // This Account has no machine to run the session on: the entry says so and opens setup.
        expect(menu?.props.items[1].subtitle).toBe('settingsAgents.authoring.needsMachine');
        await act(async () => {
            menu?.props.onSelect('askAgent');
        });
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/machines');
        getResolvedAgentCatalogEntriesSpy.mockRestore();
    });
});
