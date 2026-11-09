import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { useNewSessionWizardProps } from './useNewSessionWizardProps';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { renderScreen } from '@/dev/testkit';

const capabilityBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(capabilityBoundary.rpc);
});


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

describe('useNewSessionWizardProps', () => {
    it('preserves destination projections and cancels an installable refresh when the Wizard leaves', async () => {
        let observed: ReturnType<typeof useNewSessionWizardProps> | null = null;
        const registerTemporaryComputerReplacementLaunch = vi.fn();

        function Probe({ focused = true }: Readonly<{ focused?: boolean }>) {
            observed = useNewSessionWizardProps({
                focused,
                theme: {},
                styles: {},
                safeAreaBottom: 0,
                headerHeight: 0,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
                useProfiles: false,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: 'machine-1',
                getProfileDisabled: () => false,
                getProfileSubtitleExtra: () => null,
                handleAddProfile: () => {},
                openProfileEdit: () => {},
                handleDuplicateProfile: () => {},
                handleDeleteProfile: () => {},
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: 'favorites', custom: 'custom', builtIn: 'builtIn' },
                machineEnvPresence: { meta: {}, isPreviewEnvSupported: false, isLoading: false },
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                wizardInstallableDeps: [{
                    entry: {
                        experimental: false,
                        groupTitleKey: 'machine.tools.installablesTitle',
                        capabilityId: 'dep.acme.cli',
                        title: 'Acme CLI',
                        subtitle: 'Tools for Acme workspaces',
                        iconName: 'terminal',
                        setupUrl: 'https://docs.acme.test/setup',
                        installLabels: { install: 'Install', update: 'Update', reinstall: 'Reinstall' },
                        installModal: {
                            installTitle: 'Install Acme CLI',
                            updateTitle: 'Update Acme CLI',
                            reinstallTitle: 'Reinstall Acme CLI',
                            description: 'Install the Acme command-line tools.',
                        },
                        buildLatestVersionDetectRequest: () => ({ requests: [] }),
                    },
                    depStatus: null,
                }],
                capabilitiesCacheKeySalt: 17,
                selectedMachineCapabilities: { status: 'loaded' },
                cliAvailability: { timestamp: 1, available: {} },
                tmuxRequested: false,
                enabledAgentIds: [],
                isAgentSelectable: () => true,
                agentType: 'customAcp',
                setAgentType: () => {},
                modelOptions: [],
                modelMode: 'default',
                setModelMode: () => {},
                selectedIndicatorColor: 'blue',
                profileMap: new Map(),
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
                machines: [],
                machineGroups: [{
                    serverId: 'server-a',
                    loading: false,
                    signedOut: false,
                    machines: [],
                }],
                machinePoolGroups: [{
                    serverId: 'server-a',
                    accountId: 'account-a',
                    serverName: 'Server A',
                    pools: [],
                    status: 'idle',
                    projectionReady: true,
                }],
                temporaryComputerProjection: { state: 'available', rowCount: 2 },
                targetServerId: null,
                selectedMachine: null,
                recentMachines: [],
                favoriteMachineItems: [],
                useMachinePickerSearch: false,
                refreshMachineData: () => {},
                setSelectedMachineId: () => {},
                getBestPathForMachine: () => '',
                setSelectedPath: () => {},
                favoriteMachines: [],
                setFavoriteMachines: () => {},
                selectedPath: '',
                recentPaths: [],
                usePathPickerSearch: false,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                registerTemporaryComputerReplacementLaunch,
                canCreate: false,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: vi.fn(),
                resumeSessionId: '',
                isResumeSupportChecking: false,
            } as any);
            return null;
        }

        const screen = await renderScreen(React.createElement(Probe));

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.installableDepInstallers).toEqual([
            expect.objectContaining({
                depId: 'dep.acme.cli',
                depTitle: 'Acme CLI',
                depSubtitle: 'Tools for Acme workspaces',
                setupUrl: 'https://docs.acme.test/setup',
            }),
        ]);
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.machine).toEqual(expect.objectContaining({
            machineGroups: [expect.objectContaining({ serverId: 'server-a' })],
            machinePoolGroups: [expect.objectContaining({ serverId: 'server-a', accountId: 'account-a' })],
            temporaryComputerProjection: { state: 'available', rowCount: 2 },
        }));
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.registerTemporaryComputerReplacementLaunch)
            .toBe(registerTemporaryComputerReplacementLaunch);
        let signal: AbortSignal | undefined;
        capabilityBoundary.rpc.mockImplementationOnce((args: { signal?: AbortSignal }) => {
            signal = args.signal;
            return new Promise(() => {});
        });
        const props = observed as ReturnType<typeof useNewSessionWizardProps> | null;
        props?.agent.installableDepInstallers?.[0]?.refreshStatus();
        await vi.waitFor(() => expect(capabilityBoundary.rpc).toHaveBeenCalled());
        expect(capabilityBoundary.rpc.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            payload: { requests: [{ id: 'dep.acme.cli' }] },
        }));
        const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
        expect(getMachineCapabilitiesCacheState('machine-1', null, 17)?.status).toBe('loading');
        props?.agent.installableDepInstallers?.[0]?.refreshLatestVersion?.();
        await act(async () => { await Promise.resolve(); });
        expect(signal?.aborted).toBe(false);
        await screen.update(React.createElement(Probe, { focused: false }));
        expect(signal?.aborted).toBe(true);
        await screen.unmount();
        expect(signal?.aborted).toBe(true);
        props?.agent.installableDepInstallers?.[0]?.refreshStatus();
        await act(async () => { await Promise.resolve(); });
        expect(getMachineCapabilitiesCacheState('machine-1', null, 17)?.status).toBe('idle');
    });

    it('updates memoized agent and typed Provider launch recovery fields', async () => {
        let observed: ReturnType<typeof useNewSessionWizardProps> | null = null;

        function Probe(props: Readonly<{
            agentLabel: string;
            composerTopContent: React.ReactNode;
            composerBottomContent: React.ReactNode;
            providerLaunchError: ProviderErrorV1;
            retryProviderLaunch: () => void;
            statusTrailingActions: React.ReactNode;
        }>) {
            observed = useNewSessionWizardProps({
                theme: {},
                styles: {},
                safeAreaBottom: 0,
                headerHeight: 0,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
                useProfiles: false,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: null,
                getProfileDisabled: () => false,
                getProfileSubtitleExtra: () => null,
                handleAddProfile: () => {},
                openProfileEdit: () => {},
                handleDuplicateProfile: () => {},
                handleDeleteProfile: () => {},
                openProfileEnvVarsPreview: () => {},
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: 'favorites', custom: 'custom', builtIn: 'builtIn' },
                machineEnvPresence: { meta: {}, isPreviewEnvSupported: false, isLoading: false },
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                wizardInstallableDeps: [],
                selectedMachineCapabilities: { status: 'idle' },
                cliAvailability: { timestamp: 1, available: { customAcp: false } },
                tmuxRequested: false,
                enabledAgentIds: ['customAcp'],
                isAgentSelectable: () => true,
                agentType: 'customAcp',
                agentLabel: props.agentLabel,
                setAgentType: () => {},
                modelOptions: [],
                modelMode: 'default',
                setModelMode: () => {},
                selectedIndicatorColor: 'blue',
                profileMap: new Map(),
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
                machines: [],
                targetServerId: null,
                selectedMachine: null,
                recentMachines: [],
                favoriteMachineItems: [],
                useMachinePickerSearch: false,
                refreshMachineData: () => {},
                setSelectedMachineId: () => {},
                getBestPathForMachine: () => '',
                setSelectedPath: () => {},
                favoriteMachines: [],
                setFavoriteMachines: () => {},
                selectedPath: '',
                recentPaths: [],
                usePathPickerSearch: false,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: false,
                isCreating: false,
                composerTopContent: props.composerTopContent,
                composerBottomContent: props.composerBottomContent,
                providerLaunchError: props.providerLaunchError,
                retryProviderLaunch: props.retryProviderLaunch,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: vi.fn(),
                resumeSessionId: '',
                isResumeSupportChecking: false,
                sessionPromptInputMaxHeight: 0,
                statusTrailingActions: props.statusTrailingActions,
            } as any);
            return null;
        }

        const providerLaunchError = createProviderErrorV1('provider_not_enabled_on_machine', {
            connectionId: 'pc_provider',
            machineId: 'machine-1',
        });
        const firstRetry = vi.fn();
        const secondRetry = vi.fn();
        const composerTopContent = React.createElement('ComposerNotice');
        const composerBottomContent = React.createElement('CapabilityApplyNotice');
        const statusTrailingActions = React.createElement('StatusActions');
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe, {
            agentLabel: 'Preset A',
            composerTopContent,
            composerBottomContent,
            providerLaunchError,
            retryProviderLaunch: firstRetry,
            statusTrailingActions,
        }))).tree;

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.agentLabel).toBe('Preset A');
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.providerLaunchError).toBe(providerLaunchError);
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.retryProviderLaunch).toBe(firstRetry);
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.composerTopContent).toBe(composerTopContent);
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.composerBottomContent).toBe(composerBottomContent);
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.statusTrailingActions).toBe(statusTrailingActions);

        act(() => {
            tree?.update(React.createElement(Probe, {
                agentLabel: 'Preset B',
                composerTopContent,
                composerBottomContent,
                providerLaunchError,
                retryProviderLaunch: secondRetry,
                statusTrailingActions,
            }));
        });

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.agentLabel).toBe('Preset B');
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.retryProviderLaunch).toBe(secondRetry);

        act(() => {
            tree?.update(React.createElement(Probe, {
                agentLabel: 'Preset B',
                composerTopContent,
                composerBottomContent: null,
                providerLaunchError,
                retryProviderLaunch: secondRetry,
                statusTrailingActions,
            }));
        });
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.composerBottomContent).toBeNull();
    });
});
