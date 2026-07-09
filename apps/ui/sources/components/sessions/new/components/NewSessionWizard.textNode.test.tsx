import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import { installNewSessionComponentsCommonModuleMocks, resetNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
    keyboardHeight: 0,
}));

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
const machineSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
const modelSelectionPropsRef: { current: Record<string, unknown> | null } = { current: null };
const dropdownPropsRef: { current: Record<string, unknown> | null } = { current: null };
const agentInputPropsRef: { current: Record<string, unknown> | null } = { current: null };
installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
            Dimensions: { get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }) },
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: () => {},
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
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
    AgentInput: (props: Record<string, unknown>) => {
        agentInputPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));
vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: Record<string, unknown>) => {
        machineSelectorPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
    PathSelectionList: (props: Record<string, unknown>) => {
        pathSelectorPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/sessions/new/components/NewSessionModelSelectionContent', () => ({
    NewSessionModelSelectionContent: (props: Record<string, unknown>) => {
        modelSelectionPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        dropdownPropsRef.current = props;
        return React.createElement('DropdownMenu', props);
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
        getDraftsSnapshot: () => [],
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

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => mockEnv.keyboardHeight,
}));

describe('NewSessionWizard', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.resetModules();
        // Other suites in the same shard can update the shared mock override state in
        // `newSessionComponentsTestHelpers`. Re-apply the overrides here so this suite
        // stays deterministic regardless of file execution order.
        installNewSessionComponentsCommonModuleMocks({
            reactNative: async () => {
                const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
                return createReactNativeWebMock({
                    useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
                    Dimensions: { get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }) },
                });
            },
        });
        mockEnv.windowWidth = 800;
        mockEnv.keyboardHeight = 0;
        pathSelectorPropsRef.current = null;
        machineSelectorPropsRef.current = null;
        modelSelectionPropsRef.current = null;
        dropdownPropsRef.current = null;
        agentInputPropsRef.current = null;
    });

    afterAll(() => {
        resetNewSessionComponentsCommonModuleMocks();
    });

    function flattenStyle(style: any): Record<string, any> {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
        }
        if (typeof style === 'number') return {};
        if (typeof style === 'object') return style as Record<string, any>;
        return {};
    }

    async function renderWizardForModelRefresh(
        agentOverrides: Record<string, unknown> = {},
        footerOverrides: Record<string, unknown> = {},
    ) {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        return renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
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
                modelOptions: [{ value: 'default', label: 'Use CLI settings', description: 'Use configured model' }],
                modelMode: 'default',
                setModelMode: () => {},
                ...agentOverrides,
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
                selectedMachine: null,
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
                agentInputExtraActionChips: [],
                ...footerOverrides,
            }}
        />);
    }

    it('passes launch status badges through to the wizard composer input', async () => {
        const statusBadges = [{
            key: 'new-session-launch-starting',
            label: 'newSession.startingSession',
            testID: 'new-session-launch-status',
            tone: 'active' as const,
        }];

        await renderWizardForModelRefresh({}, {
            isCreating: true,
            statusBadges,
        });

        expect(agentInputPropsRef.current?.statusBadges).toBe(statusBadges);
    });

    it('renders the submitted prompt as pending wizard launch content while creation is unresolved', async () => {
        const pendingLaunchAttempt: NewSessionLaunchAttempt = {
            attemptId: 'attempt-1',
            spawnNonce: 'spawn-1',
            spawnAttemptKey: null,
            scopeKey: 'scope-1',
            createdSessionId: null,
            daemonInitialPromptUsed: false,
            firstTurnLocalId: 'first-turn-1',
            attachmentMessageLocalId: 'attachment-1',
            status: 'spawning',
            prompt: {
                prompt: 'Build the wizard pending launch state',
                displayText: 'Build the wizard pending launch state',
                meta: null,
            },
            phaseErrors: {},
        };

        const screen = await renderWizardForModelRefresh({}, {
            sessionPrompt: 'Build the wizard pending launch state',
            isCreating: true,
            pendingLaunchAttempt,
        });

        expect(screen.findByProps({ testID: 'new-session-launch-pending-preview' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'new-session-launch-pending-preview-prompt' }).props.children)
            .toBe('Build the wizard pending launch state');
    });

    it('does not force the wizard shell to full-height on wide web layouts', async () => {
        mockEnv.windowWidth = 900;
        try {
            const { NewSessionWizard } = await import('./NewSessionWizard');

            const screen = await renderScreen(<NewSessionWizard
                popoverBoundaryRef={{ current: null } as any}
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
                    styles: {
                        container: { flex: 0 },
                    } as any,
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
                    profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                    getSecretOverrideReady: () => true,
                    getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
                } as any}
                agent={{
                    cliAvailability: { available: {}, isLoaded: true } as any,
                    tmuxRequested: false,
                    enabledAgentIds: ['codex'] as any,
                    isAgentSelectable: () => true,
                    isCliBannerDismissed: () => true,
                    dismissCliBanner: () => {},
                    agentType: 'codex' as any,
                    setAgentType: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }] as any,
                    setModelMode: () => {},
                    selectedIndicatorColor: '#000',
                    profileMap: new Map(),
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                } as any}
                machine={{
                    machines: [{
                        id: 'machine-1',
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
                    selectedMachine: null,
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
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompletePrefixes: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    isResumeSupportChecking: false,
                    resumeSessionId: null,
                    connectionStatus: undefined,
                    showResumePicker: false,
                } as any}
            />);

            expect(screen.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' })).toBeTruthy();
            expect(screen.findAllByType('View').some((node) => flattenStyle(node.props.style).flex === 0)).toBe(true);
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('applies the top safe-area inset to the wizard content on iOS', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
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
                safeAreaTop: 18,
                safeAreaBottom: 0,
                headerHeight: 44,
                newSessionTopPadding: 14,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
            } as any}
            profiles={{
                useProfiles: true,
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
                profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                getSecretOverrideReady: () => true,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
            } as any}
            agent={{
                cliAvailability: { available: { codex: true }, isLoaded: true } as any,
                tmuxRequested: false,
                enabledAgentIds: ['codex'] as any,
                isAgentSelectable: () => true,
                isCliBannerDismissed: () => true,
                dismissCliBanner: () => {},
                agentType: 'codex' as any,
                setAgentType: () => {},
                modelOptions: [] as any,
                setModelMode: () => {},
                selectedIndicatorColor: '#000',
                profileMap: new Map(),
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
            } as any}
            machine={{
                machines: [{
                    id: 'machine-1',
                    active: true,
                    activeAt: Date.now(),
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
                selectedMachine: null,
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
                agentInputExtraActionChips: [],
            }}
        />);

        const contentWrapper = screen.findAllByType('View' as any).find((node: any) => {
            const style = flattenStyle(node.props?.style);
            return style.width === '100%' && style.alignSelf === 'center' && style.paddingTop === 18;
        });

        expect(contentWrapper).toBeDefined();
    });

    it('stretches the footer padding wrapper to full width on web (avoids shrink-to-fit collapse)', async () => {
        mockEnv.windowWidth = 1200;
        try {
            const { NewSessionWizard } = await import('./NewSessionWizard');

            const screen = await renderScreen(<NewSessionWizard
                popoverBoundaryRef={{ current: null } as any}
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
                    newSessionSidePadding: 123,
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
                    profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                    getSecretOverrideReady: () => true,
                    getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
                } as any}
                agent={{
                    cliAvailability: { available: {}, isLoaded: true } as any,
                    tmuxRequested: false,
                    enabledAgentIds: ['codex'] as any,
                    isAgentSelectable: () => true,
                    isCliBannerDismissed: () => true,
                    dismissCliBanner: () => {},
                    agentType: 'codex' as any,
                    setAgentType: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }] as any,
                    setModelMode: () => {},
                    selectedIndicatorColor: '#000',
                    profileMap: new Map(),
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                } as any}
                machine={{
                    machines: [{
                        id: 'machine-1',
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
                    selectedMachine: null,
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
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompletePrefixes: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    isResumeSupportChecking: false,
                    resumeSessionId: null,
                    connectionStatus: undefined,
                    showResumePicker: false,
                } as any}
            />);

            const paddedViews = screen
                .findAllByType('View')
                .filter((node) => flattenStyle(node.props.style).paddingHorizontal === 123);
            expect(paddedViews).toHaveLength(1);
            expect(flattenStyle(paddedViews[0].props.style).width).toBe('100%');
            expect(flattenStyle(paddedViews[0].props.style).alignSelf).toBe('stretch');
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('anchors the wizard shell to the bottom on narrow mobile web layouts', async () => {
        mockEnv.windowWidth = 390;
        mockEnv.keyboardHeight = 48;
        try {
            const { NewSessionWizard } = await import('./NewSessionWizard');

            const screen = await renderScreen(<NewSessionWizard
                            popoverBoundaryRef={{ current: null } as any}
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
                                newSessionBottomPadding: 8,
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
                                selectedMachine: null,
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
                                canCreate: true,
                                isCreating: false,
                                emptyAutocompletePrefixes: [],
                                emptyAutocompleteSuggestions: async () => [],
                                sessionPromptInputMaxHeight: 200,
                                isResumeSupportChecking: false,
                                resumeSessionId: null,
                                connectionStatus: undefined,
                                showResumePicker: false,
                            } as any}
                        />);

            const allViews = screen.findAllByType('View');
            expect(screen.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' })).toBeTruthy();
            expect(allViews.some((node) => flattenStyle(node.props.style).justifyContent === 'flex-end')).toBe(true);
            expect(allViews.some((node) => flattenStyle(node.props.style).paddingTop === 12 && flattenStyle(node.props.style).paddingBottom === 8)).toBe(true);
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('does not render the legacy visible session type section even when the feature flag is enabled', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
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
                            agentInputExtraActionChips: [],
                        }}
                    />);
        try {
            const textContent = screen.getTextContent();
            expect(textContent).not.toContain('newSession.selectSessionTypeTitle');
            expect(textContent).not.toContain('newSession.selectSessionTypeDescription');
        } finally {
            await screen.unmount();
        }
    });

    it('passes machine browsing config through to the shared path selector', async () => {
        pathSelectorPropsRef.current = null;
        const { NewSessionWizard } = await import('./NewSessionWizard');

        await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
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
                        agentInputExtraActionChips: [],
                    }}
                />);

        expect(pathSelectorPropsRef.current).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
    });

    it('renders stable wizard model testIDs for inline model options', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
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
                        modelOptions: [
                            { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Primary model' },
                            { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Faster model' },
                        ],
                        modelMode: 'gpt-5.4-mini',
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
                        agentInputExtraActionChips: [],
                    }}
                />);

        expect(modelSelectionPropsRef.current?.modelOptions).toEqual([
            { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Primary model' },
            { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Faster model' },
        ]);
        expect(modelSelectionPropsRef.current?.selectedModelId).toBe('gpt-5.4-mini');
    });

    it('renders the wizard model refresh action when model options can be refreshed', async () => {
        const onRefresh = vi.fn();

        const screen = await renderWizardForModelRefresh({
            modelOptionsProbe: { phase: 'idle', onRefresh },
        });

        screen.pressByTestId('new-session-model-refresh');

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('keeps the wizard model section visible with a loading indicator while models are loading', async () => {
        const onRefresh = vi.fn();

        const screen = await renderWizardForModelRefresh({
            modelOptions: [],
            modelOptionsProbe: { phase: 'loading', onRefresh },
        });

        const refreshButton = screen.findByTestId('new-session-model-refresh');
        expect(refreshButton?.props.disabled).toBe(true);
        expect(refreshButton?.props.onPress).toBeUndefined();
        expect(modelSelectionPropsRef.current?.modelOptions).toEqual([]);
        expect(screen.tree.root.findAllByProps({ accessibilityRole: 'progressbar' }).length).toBeGreaterThan(0);
    });

    it('applies forced dropdown presentation to wizard machine, path, model, and permission sections', async () => {
        mockEnv.windowWidth = 1200;
        const { NewSessionWizard } = await import('./NewSessionWizard');

        await renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            sectionPresentation={{
                backends: 'dropdown',
                models: 'dropdown',
                machines: 'dropdown',
                paths: 'dropdown',
                permissions: 'dropdown',
            } as any}
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
                styles: {
                    wizardSelectionPair: {},
                    wizardSelectionPairColumn: {},
                } as any,
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
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                getSecretOverrideReady: () => false,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                getSecretMachineEnvOverride: () => null,
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
                modelOptions: [
                    { value: 'default', label: 'Use CLI settings', description: '' },
                    { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Primary model' },
                ],
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
                recentPaths: ['/tmp', '/repo'],
                usePathPickerSearch: true,
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
                agentInputExtraActionChips: [],
            }}
        />);

        expect(machineSelectorPropsRef.current).toMatchObject({
            presentation: 'dropdown',
            dropdownTestID: 'new-session-machine-dropdown-trigger',
        });
        expect(pathSelectorPropsRef.current).toMatchObject({
            initialValue: '/tmp',
            maxHeight: 320,
        });
        expect(modelSelectionPropsRef.current).toMatchObject({
            presentation: 'compact',
        });
        expect(dropdownPropsRef.current).toMatchObject({
            selectedId: 'default',
        });
    });

    it('only uses wizard selector columns on wide web when the column layout preference is enabled', async () => {
        mockEnv.windowWidth = 1200;
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const machine = {
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
        };
        const renderWizard = (useColumnLayout?: boolean) => renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            useColumnLayout={useColumnLayout}
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
                styles: {
                    wizardSelectionPair: { testColumnPair: true },
                    wizardSelectionPairColumn: { testColumnPairColumn: true },
                } as any,
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
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                getSecretOverrideReady: () => false,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                getSecretMachineEnvOverride: () => null,
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
                modelOptions: [
                    { value: 'default', label: 'Use CLI settings', description: 'Use configured model' },
                    { value: 'opus', label: 'Opus', description: 'High capability' },
                ],
                modelMode: 'default',
                setModelMode: () => {},
            } as any}
            machine={{
                machines: [machine],
                serverId: 'server-1',
                selectedMachine: machine,
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
                agentInputExtraActionChips: [],
            }}
        />);
        const countColumnPairs = (screen: Awaited<ReturnType<typeof renderWizard>>) => screen
            .findAllByType('View')
            .filter((node) => flattenStyle(node.props.style).testColumnPair === true)
            .length;

        const defaultScreen = await renderWizard();
        expect(countColumnPairs(defaultScreen)).toBe(0);

        const enabledScreen = await renderWizard(true);
        expect(countColumnPairs(enabledScreen)).toBeGreaterThan(0);
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
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
                />)).tree;

        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });

    it('does not emit raw text nodes from the profile header when icons render as text on web', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
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
                        agentInputExtraActionChips: [],
                    }}
                />)).tree;

        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });
});
