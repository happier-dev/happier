import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks, resetNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
}));
let platformOs: 'web' | 'android' = 'web';
const useKeyboardHandlerMock = vi.fn();

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
const CliNotDetectedBannerMock = vi.fn((_props: Record<string, unknown>) => null);
installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
            Dimensions: { get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }) },
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (value: any) => value?.[platformOs] ?? value?.default ?? value?.native ?? value?.ios ?? value?.android,
            },
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
    useKeyboardHandler: (...args: any[]) => useKeyboardHandlerMock(...args),
    useReanimatedKeyboardAnimation: () => ({
        height: { value: -240 },
        progress: { value: 1 },
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: any) => React.createElement('AnimatedView', props, props.children),
        },
        useAnimatedStyle: (fn: any) => fn(),
        useSharedValue: (initial: any) => ({ value: initial }),
    };
});

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
    AgentInput: () => null,
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));
vi.mock('@/components/sessions/new/components/CliNotDetectedBanner', () => ({
    CliNotDetectedBanner: (props: Record<string, unknown>) => CliNotDetectedBannerMock(props),
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

describe('NewSessionWizard', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.resetModules();
        CliNotDetectedBannerMock.mockClear();
        // Other suites in the same shard can update the shared mock override state in
        // `newSessionComponentsTestHelpers`. Re-apply the overrides here so this suite
        // stays deterministic regardless of file execution order.
        installNewSessionComponentsCommonModuleMocks({
            reactNative: async () => {
                const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
                return createReactNativeWebMock({
                    useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
                    Dimensions: { get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }) },
                    Platform: {
                        get OS() {
                            return platformOs;
                        },
                        select: (value: any) => value?.[platformOs] ?? value?.default ?? value?.native ?? value?.ios ?? value?.android,
                    },
                });
            },
        });
        mockEnv.windowWidth = 800;
        platformOs = 'web';
        useKeyboardHandlerMock.mockReset();
        pathSelectorPropsRef.current = null;
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

    function getTranslateY(style: any): number | null {
        const transform = flattenStyle(style).transform;
        if (!Array.isArray(transform)) return null;
        for (const entry of transform) {
            if (
                entry
                && typeof entry === 'object'
                && 'translateY' in entry
                && typeof entry.translateY === 'number'
            ) {
                return entry.translateY;
            }
        }
        return null;
    }

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

            const keyboardView = screen.findByType('KeyboardAvoidingView');
            expect(keyboardView.props.style).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    flex: 0,
                }),
            ]));
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('does not render CLI not detected banners in the AI backend section', async () => {
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
                profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                getSecretOverrideReady: () => true,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
            } as any}
            agent={{
                cliAvailability: { available: { codex: false }, isLoaded: true } as any,
                tmuxRequested: false,
                enabledAgentIds: ['codex'] as any,
                isAgentSelectable: () => true,
                isCliBannerDismissed: () => false,
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

        expect(CliNotDetectedBannerMock).not.toHaveBeenCalled();
    });

    it('uses the native keyboard-shift host on Android so the whole footer composer can move above the keyboard', async () => {
        platformOs = 'android';
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

        expect(screen.findAllByType('KeyboardAvoidingView')).toHaveLength(0);
        const composerHostTranslateY = screen
            .findAllByType('AnimatedView')
            .map((node) => getTranslateY(node.props.style))
            .find((translateY) => translateY !== null);
        expect(composerHostTranslateY).toBe(-240);
    });

    it('renders AI backend providers as a full list', async () => {
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
                profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                getSecretOverrideReady: () => true,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
            } as any}
            agent={{
                cliAvailability: { available: { codex: true, claude: true }, isLoaded: true } as any,
                tmuxRequested: false,
                enabledAgentIds: ['codex', 'claude'] as any,
                isAgentSelectable: () => true,
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

        expect(screen.findAllByType('Item' as any).filter((node: any) => String(node.props?.testID ?? '').startsWith('new-session-agent:'))).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ props: expect.objectContaining({ testID: 'new-session-agent:codex' }) }),
                expect.objectContaining({ props: expect.objectContaining({ testID: 'new-session-agent:claude' }) }),
            ]),
        );
        const codexRow = screen.findByProps({ testID: 'new-session-agent:codex' });
        expect(flattenStyle((codexRow.props.rightElement as any)?.props?.style).width).toBe(28);
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

            const keyboardView = screen.findByType('KeyboardAvoidingView');
            expect(keyboardView.props.style).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    justifyContent: 'flex-end',
                }),
            ]));
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
            machineBrowse: {
                enabled: true,
                machineId: 'machine-1',
                serverId: 'server-1',
            },
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

        expect(screen.findAllByType('Item' as any).filter((node: any) => node.props?.testID === 'new-session-model:gpt-5.4')).toHaveLength(1);
        expect(screen.findAllByType('Item' as any).filter((node: any) => node.props?.testID === 'new-session-model:gpt-5.4-mini')).toHaveLength(1);
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
