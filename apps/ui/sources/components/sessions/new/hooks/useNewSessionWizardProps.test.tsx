import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol';

import { useNewSessionWizardProps } from './useNewSessionWizardProps';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

describe('useNewSessionWizardProps', () => {
    it('updates memoized agent and typed Provider launch recovery fields', async () => {
        let observed: ReturnType<typeof useNewSessionWizardProps> | null = null;

        function Probe(props: Readonly<{
            agentLabel: string;
            providerLaunchError: ProviderErrorV1;
            retryProviderLaunch: () => void;
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
                isCliBannerDismissed: () => false,
                dismissCliBanner: () => {},
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
                providerLaunchError: props.providerLaunchError,
                retryProviderLaunch: props.retryProviderLaunch,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: vi.fn(),
                resumeSessionId: '',
                isResumeSupportChecking: false,
                sessionPromptInputMaxHeight: 0,
            } as any);
            return null;
        }

        const providerLaunchError = createProviderErrorV1('provider_not_enabled_on_machine', {
            connectionId: 'pc_provider',
            machineId: 'machine-1',
        });
        const firstRetry = vi.fn();
        const secondRetry = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe, {
            agentLabel: 'Preset A',
            providerLaunchError,
            retryProviderLaunch: firstRetry,
        }))).tree;

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.agentLabel).toBe('Preset A');
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.providerLaunchError).toBe(providerLaunchError);
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.retryProviderLaunch).toBe(firstRetry);

        act(() => {
            tree?.update(React.createElement(Probe, {
                agentLabel: 'Preset B',
                providerLaunchError,
                retryProviderLaunch: secondRetry,
            }));
        });

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.agentLabel).toBe('Preset B');
        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.footer.retryProviderLaunch).toBe(secondRetry);
    });
});
