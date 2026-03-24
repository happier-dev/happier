import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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
    it('updates the wizard agent label when the configured ACP backend label changes', async () => {
        let observed: ReturnType<typeof useNewSessionWizardProps> | null = null;

        function Probe({ agentLabel }: Readonly<{ agentLabel: string }>) {
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
                agentLabel,
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
                sessionPrompt: '',
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: false,
                isCreating: false,
                emptyAutocompletePrefixes: [],
                emptyAutocompleteSuggestions: vi.fn(),
                resumeSessionId: '',
                isResumeSupportChecking: false,
                sessionPromptInputMaxHeight: 0,
            } as any);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(Probe, { agentLabel: 'Preset A' }))).tree;

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.agentLabel).toBe('Preset A');

        act(() => {
            tree?.update(React.createElement(Probe, { agentLabel: 'Preset B' }));
        });

        expect((observed as ReturnType<typeof useNewSessionWizardProps> | null)?.agent.agentLabel).toBe('Preset B');
    });
});
