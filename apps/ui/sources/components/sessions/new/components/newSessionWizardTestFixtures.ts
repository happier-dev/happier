import type * as React from 'react';
import { createMachineFixture, createThemeFixture } from '@/dev/testkit';
import { createNewSessionPromptStore } from '../hooks/screenModel/newSessionPromptStore';
import type { CLIAvailability } from '@/agents/machineAgents/machineAgentCliAvailability';

export type NewSessionWizardTestProps = Omit<React.ComponentProps<typeof import('./NewSessionWizard').NewSessionWizard>, 'popoverBoundaryRef'>;

/** Public caller data only: the rendered Wizard and all its internal owners stay real. */
export function createNewSessionWizardTestProps(): NewSessionWizardTestProps {
    const machine = createMachineFixture({ id: 'machine-1', metadata: {
        displayName: 'Machine 1', host: 'machine-1.local', homeDir: '/Users/alice',
        happyHomeDir: '/Users/alice/.happier', happyCliVersion: '1.0.0', platform: 'darwin',
    } });
    const cliAvailability: CLIAvailability = {
        available: { codex: true, claude: true, gemini: true, pi: true },
        login: {}, authStatus: {}, resolvedPath: {}, resolutionSource: {},
        tmux: null, isDetecting: false, timestamp: 1, refresh: () => {},
    };
    return {
        layout: { theme: createThemeFixture(), styles: {}, safeAreaTop: 0, safeAreaBottom: 34,
            headerHeight: 44, newSessionSidePadding: 16, newSessionBottomPadding: 12, shouldBottomAnchor: true },
        profiles: {
            useProfiles: false, profiles: [], favoriteProfileIds: [], setFavoriteProfileIds: () => {},
            selectedProfileId: null, onPressDefaultEnvironment: () => {}, onPressProfile: () => {},
            selectedMachineId: machine.id, getProfileDisabled: () => false, getProfileSubtitleExtra: () => null,
            handleAddProfile: () => {}, openProfileEdit: () => {}, handleDuplicateProfile: () => {}, handleDeleteProfile: () => {},
            suppressNextSecretAutoPromptKeyRef: { current: null }, openSecretRequirementModal: () => {},
            profilesGroupTitles: { favorites: '', custom: '', builtIn: '' }, getSecretOverrideReady: () => false,
            getSecretSatisfactionForProfile: () => ({ isSatisfied: true }), getSecretMachineEnvOverride: () => null,
        },
        agent: {
            cliAvailability, tmuxRequested: false, enabledAgentIds: ['codex'], isAgentSelectable: () => true,
            agentType: 'codex', setAgentType: () => {}, selectedIndicatorColor: '#000', profileMap: new Map(),
            permissionMode: 'default', handlePermissionModeChange: () => {},
            modelOptions: [{ value: 'default', label: 'Default', description: '' }], modelMode: 'default', setModelMode: () => {},
        },
        machine: {
            machines: [machine], serverId: null, selectedMachine: machine, recentMachines: [], favoriteMachineItems: [],
            useMachinePickerSearch: false, onRefreshMachines: () => {}, setSelectedMachineId: () => {},
            getBestPathForMachine: () => '/Users/alice/repo', setSelectedPath: () => {},
            favoriteMachines: [], setFavoriteMachines: () => {}, selectedPath: '/Users/alice/repo', recentPaths: [],
            usePathPickerSearch: false, favoriteDirectories: [], setFavoriteDirectories: () => {},
        },
        footer: { promptStore: createNewSessionPromptStore(''), setSessionPrompt: () => {}, handleCreateSession: () => {},
            canCreate: true, isCreating: false, emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
            agentInputExtraActionChips: [], submitAccessibilityLabel: 'Create' },
    };
}
