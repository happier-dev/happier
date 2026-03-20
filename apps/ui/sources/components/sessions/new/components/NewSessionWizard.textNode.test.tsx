import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
    Dimensions: { get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }) },
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('LinearGradient', props, props.children),
}));

vi.mock('color', () => ({
    default: () => ({
        alpha: () => ({ rgb: () => ({ string: () => 'rgba(0,0,0,0.08)' }) }),
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
        'Item',
        props,
        [
            props.leftElement == null ? null : React.createElement('Text', { key: 'left' }, props.leftElement),
            props.rightElement == null ? null : React.createElement(React.Fragment, { key: 'right' }, props.rightElement),
            props.subtitle == null ? null : React.createElement('Text', { key: 'subtitle' }, props.subtitle),
        ],
    ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => null,
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));
vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));
vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: Record<string, unknown>) => {
        pathSelectorPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));
vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({ maxFileBytes: 1 }),
}));
vi.mock('@/components/sessions/attachments/useAttachmentDraftManager', () => ({
    useAttachmentDraftManager: () => ({
        filePickerRef: { current: null },
        drafts: [],
        hasSendableAttachments: false,
        agentInputAttachments: [],
        addWebFiles: () => {},
        addPickedAttachments: () => {},
        applyDraftPatch: () => {},
        clearDrafts: () => {},
    }),
}));
vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: vi.fn(),
    formatAttachmentsBlock: vi.fn(() => ''),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));
vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), confirm: vi.fn() },
}));

describe('NewSessionWizard', () => {
    it('does not render the legacy visible session type section even when the feature flag is enabled', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <NewSessionWizard
                        layout={{
                            theme: {
                                colors: {
                                    divider: '#ddd',
                                    shadow: { color: '#000' },
                                    groupped: { background: '#fff' },
                                    text: '#000',
                                    textSecondary: '#666',
                                    input: { background: '#fff' },
                                    button: { secondary: { tint: '#000' } },
                                    warning: '#d97706',
                                    box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                                },
                            } as any,
                            styles: {} as any,
                            safeAreaBottom: 0,
                            headerHeight: 44,
                            newSessionSidePadding: 0,
                            newSessionBottomPadding: 0,
                        }}
                        profiles={{
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
                            openProfileEnvVarsPreview: () => {},
                            suppressNextSecretAutoPromptKeyRef: { current: null },
                            openSecretRequirementModal: () => {},
                            profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                            getSecretOverrideReady: () => false,
                            getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                            getSecretMachineEnvOverride: () => null,
                            secretBindingsByProfileId: {},
                            selectedSecretIdByProfileIdByEnvVarName: {},
                            setSecretBindingChoice: () => {},
                            setSessionOnlySecretValueEnc: () => {},
                        } as any}
                        agent={{
                            cliAvailability: { available: true },
                            tmuxRequested: false,
                            enabledAgentIds: ['codex'],
                            isAgentSelectable: () => true,
                            isCliBannerDismissed: () => true,
                            dismissCliBanner: () => {},
                            agentType: 'codex',
                            setAgentType: () => {},
                            selectedIndicatorColor: '#000',
                            permissionMode: 'default',
                            handlePermissionModeChange: () => {},
                            modelOptions: [],
                            modelMode: 'default',
                            setModelMode: () => {},
                        } as any}
                        machine={{
                            machines: [{
                                id: 'machine-1',
                                seq: 1,
                                createdAt: 0,
                                updatedAt: 0,
                                active: true,
                                activeAt: 0,
                                revokedAt: null,
                                metadata: {
                                    host: 'box.local',
                                    platform: 'test',
                                    happyCliVersion: '0.0.0-test',
                                    happyHomeDir: '/tmp/happy-home',
                                    homeDir: '/tmp',
                                    displayName: 'Box',
                                },
                                metadataVersion: 1,
                                daemonState: null,
                                daemonStateVersion: 0,
                            }],
                            serverId: 'server-1',
                            selectedMachine: {
                                id: 'machine-1',
                                seq: 1,
                                createdAt: 0,
                                updatedAt: 0,
                                active: true,
                                activeAt: 0,
                                revokedAt: null,
                                metadata: {
                                    host: 'box.local',
                                    platform: 'test',
                                    happyCliVersion: '0.0.0-test',
                                    happyHomeDir: '/tmp/happy-home',
                                    homeDir: '/tmp',
                                    displayName: 'Box',
                                },
                                metadataVersion: 1,
                                daemonState: null,
                                daemonStateVersion: 0,
                            },
                            recentMachines: [],
                            favoriteMachineItems: [],
                            useMachinePickerSearch: false,
                            onRefreshMachines: () => {},
                            setSelectedMachineId: () => {},
                            getBestPathForMachine: () => '/tmp',
                            setSelectedPath: () => {},
                            favoriteMachines: [],
                            setFavoriteMachines: () => {},
                            selectedPath: '/tmp',
                            recentPaths: [],
                            usePathPickerSearch: false,
                            favoriteDirectories: [],
                            setFavoriteDirectories: () => {},
                        } as any}
                        footer={{
                            sessionPrompt: '',
                            setSessionPrompt: () => {},
                            handleCreateSession: () => {},
                            canCreate: false,
                            isCreating: false,
                            emptyAutocompletePrefixes: [],
                            emptyAutocompleteSuggestions: async () => [],
                            selectedProfileEnvVarsCount: 0,
                            envVarsPopover: undefined,
                            agentInputExtraActionChips: [],
                        }}
                    />,
                );
            });

            const textNodes = tree.root.findAllByType('Text' as any).map((node) => node.props.children).flat().filter(Boolean);
            expect(textNodes).not.toContain('newSession.selectSessionTypeTitle');
            expect(textNodes).not.toContain('newSession.selectSessionTypeDescription');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes machine browsing config through to the shared path selector', async () => {
        pathSelectorPropsRef.current = null;
        const { NewSessionWizard } = await import('./NewSessionWizard');

        await act(async () => {
            renderer.create(
                <NewSessionWizard
                    layout={{
                        theme: {
                            colors: {
                                divider: '#ddd',
                                shadow: { color: '#000' },
                                groupped: { background: '#fff' },
                                text: '#000',
                                textSecondary: '#666',
                                input: { background: '#fff' },
                                button: { secondary: { tint: '#000' } },
                                warning: '#d97706',
                                box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                            },
                        } as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
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
                        openProfileEnvVarsPreview: () => {},
                        suppressNextSecretAutoPromptKeyRef: { current: null },
                        openSecretRequirementModal: () => {},
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        isCliBannerDismissed: () => true,
                        dismissCliBanner: () => {},
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any}
                    machine={{
                        machines: [{
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'box.local',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Box',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        }],
                        serverId: 'server-1',
                        selectedMachine: {
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'box.local',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Box',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                        recentMachines: [],
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
                        setSelectedMachineId: () => {},
                        getBestPathForMachine: () => '/tmp',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        setFavoriteMachines: () => {},
                        selectedPath: '/tmp',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    } as any}
                    footer={{
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        selectedProfileEnvVarsCount: 0,
                        envVarsPopover: undefined,
                        agentInputExtraActionChips: [],
                    }}
                />,
            );
        });

        expect(pathSelectorPropsRef.current).toMatchObject({
            machineBrowse: {
                enabled: true,
                machineId: 'machine-1',
                serverId: 'server-1',
            },
        });
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionWizard
                    layout={{
                        theme: {
                            colors: {
                                divider: '#ddd',
                                shadow: { color: '#000' },
                                groupped: { background: '#fff' },
                                text: '#000',
                                textSecondary: '#666',
                                input: { background: '#fff' },
                                button: { secondary: { tint: '#000' } },
                                warning: '#d97706',
                                box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                            },
                        } as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
                        useProfiles: false,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: null,
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: 'machine-offline',
                        getProfileDisabled: () => false,
                        getProfileSubtitleExtra: () => null,
                        handleAddProfile: () => {},
                        openProfileEdit: () => {},
                        handleDuplicateProfile: () => {},
                        handleDeleteProfile: () => {},
                        openProfileEnvVarsPreview: () => {},
                        suppressNextSecretAutoPromptKeyRef: { current: null },
                        openSecretRequirementModal: () => {},
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: true,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        isCliBannerDismissed: () => true,
                        dismissCliBanner: () => {},
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any}
                    machine={{
                        machines: [{
                            id: 'machine-offline',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: false,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'offline-box',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Offline Box',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        }],
                        serverId: null,
                        selectedMachine: {
                            id: 'machine-offline',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: false,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'offline-box',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Offline Box',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                        recentMachines: [],
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
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
                    } as any}
                    footer={{
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        selectedProfileEnvVarsCount: 0,
                        envVarsPopover: undefined,
                        agentInputExtraActionChips: [{
                            key: 'attachments-add',
                            labelPolicy: 'auto-hide',
                            render: () => (
                                <React.Fragment>
                                    .
                                </React.Fragment>
                            ),
                        }],
                    }}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) walk(child, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
    });

    it('does not emit raw text nodes from the profile header when icons render as text on web', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionWizard
                    layout={{
                        theme: {
                            colors: {
                                divider: '#ddd',
                                shadow: { color: '#000' },
                                groupped: { background: '#fff' },
                                text: '#000',
                                textSecondary: '#666',
                                input: { background: '#fff' },
                                button: { secondary: { tint: '#000' } },
                                warning: '#d97706',
                                box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                            },
                        } as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
                        useProfiles: true,
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
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        isCliBannerDismissed: () => true,
                        dismissCliBanner: () => {},
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any}
                    machine={{
                        machines: [],
                        serverId: null,
                        selectedMachine: null,
                        recentMachines: [],
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
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
                    } as any}
                    footer={{
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        selectedProfileEnvVarsCount: 0,
                        envVarsPopover: undefined,
                        agentInputExtraActionChips: [],
                    }}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) walk(child, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);
        expect(badNodes).toEqual([]);
    });
});
