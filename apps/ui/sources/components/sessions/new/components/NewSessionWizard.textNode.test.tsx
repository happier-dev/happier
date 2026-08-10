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

const machineSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
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
    useKeyboardHandler: (...args: any[]) => useKeyboardHandlerMock(...args),
    useReanimatedKeyboardAnimation: () => ({
        height: { value: -240 },
        progress: { value: 1 },
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaFrame: () => ({ width: mockEnv.windowWidth, height: 600, x: 0, y: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// `react-native-reanimated` is a testkit-owned boundary: `sources/dev/vitestSetup.ts`
// already installs `createReanimatedModuleMock()` for every suite. This file used to
// shadow it with a three-export inline mock, which silently broke the moment production
// reached for a fourth export (`useDerivedValue`). Do not reintroduce an inline mock here.

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
        machineSelectorPropsRef.current = null;
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

    async function renderWizardForModelRefresh(agentOverrides: Record<string, unknown> = {}) {
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
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
            }}
        />);
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
                    emptyAutocompleteKinds: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    isResumeSupportChecking: false,
                    resumeSessionId: null,
                    connectionStatus: undefined,
                    showResumePicker: false,
                } as any}
            />);

            const scaffold = screen.findByProps({ testID: 'new-session-wizard-keyboard-host' });
            expect(scaffold.props.style).toEqual(expect.arrayContaining([
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
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
            }}
        />);

        expect(CliNotDetectedBannerMock).not.toHaveBeenCalled();
    });

    it('uses the shared scaffold composer host on Android so the whole footer composer can move above the keyboard', async () => {
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
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                sessionPromptInputMaxHeight: 200,
                isResumeSupportChecking: false,
                resumeSessionId: null,
                connectionStatus: undefined,
                showResumePicker: false,
            } as any}
        />);

        const composerHost = screen.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' });
        expect(flattenStyle(composerHost.props.style).position).toBe('absolute');
        expect(typeof getTranslateY(composerHost.props.style)).toBe('number');
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
                emptyAutocompleteKinds: [],
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
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' }).length).toBeGreaterThan(0);
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
                emptyAutocompleteKinds: [],
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
                    emptyAutocompleteKinds: [],
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
                                emptyAutocompleteKinds: [],
                                emptyAutocompleteSuggestions: async () => [],
                                sessionPromptInputMaxHeight: 200,
                                isResumeSupportChecking: false,
                                resumeSessionId: null,
                                connectionStatus: undefined,
                                showResumePicker: false,
                            } as any}
                        />);

            const scaffold = screen.findByProps({ testID: 'new-session-wizard-keyboard-host' });
            expect(scaffold.props.style).toEqual(expect.arrayContaining([
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
                            emptyAutocompleteKinds: [],
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

    it('applies forced dropdown presentation to every wizard selection section', async () => {
        machineSelectorPropsRef.current = null;
        pathSelectorPropsRef.current = null;
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
                        sectionPresentation={{
                            profiles: 'dropdown',
                            backends: 'dropdown',
                            models: 'dropdown',
                            machines: 'dropdown',
                            paths: 'dropdown',
                            permissions: 'dropdown',
                        }}
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
                            { value: 'default', label: 'Use CLI settings', description: 'Use configured model' },
                            { value: 'opus', label: 'Opus', description: 'High capability' },
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
                        recentPaths: ['/tmp/recent'],
                        usePathPickerSearch: false,
                        favoriteDirectories: ['~/favorite'],
                        setFavoriteDirectories: () => {},
                    } as any}
                    footer={{
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />);

        const itemTestIds = screen.findAllByType('Item' as any).map((node: any) => node.props?.testID).filter(Boolean);
        expect(itemTestIds).toEqual(expect.arrayContaining([
            'new-session-profile-dropdown-trigger',
            'new-session-agent-dropdown-trigger',
            'new-session-model-dropdown-trigger',
            'new-session-permission-dropdown-trigger',
        ]));
        expect(itemTestIds).not.toContain('new-session-agent:codex');
        expect(itemTestIds).not.toContain('new-session-model:default');
        expect(machineSelectorPropsRef.current).toMatchObject({
            presentation: 'dropdown',
            dropdownTestID: 'new-session-machine-dropdown-trigger',
            favoriteGroupPlacement: 'beforeRecent',
        });
        // PathSelectionList now owns the path-picker presentation; the legacy
        // `pathEntryPresentation` / `savedPathsPresentation` / `favoriteGroupPlacement`
        // / `machineBrowse` props are gone. Assert the new contract: machine
        // identity threads through to the SelectionList adapter.
        expect(pathSelectorPropsRef.current).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
    });

    it('uses dropdown presentation automatically when machine and path sections have many visible rows', async () => {
        machineSelectorPropsRef.current = null;
        pathSelectorPropsRef.current = null;
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
        const recentMachines = Array.from({ length: 5 }, (_, index) => ({
            ...machine,
            id: `recent-machine-${index}`,
            metadata: { ...machine.metadata, displayName: `Recent ${index}` },
        }));

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
                        machines: [machine],
                        serverId: 'server-1',
                        selectedMachine: machine,
                        recentMachines,
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
                        setSelectedMachineId: () => {},
                        getBestPathForMachine: () => '/tmp',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        setFavoriteMachines: () => {},
                        selectedPath: '/tmp',
                        recentPaths: ['/tmp/one', '/tmp/two', '/tmp/three', '/tmp/four', '/tmp/five'],
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
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />);

        expect(machineSelectorPropsRef.current).toMatchObject({
            presentation: 'dropdown',
        });
        // PathSelectionList replaces the legacy savedPathsPresentation toggle —
        // the SelectionList primitive now drives the same compact dropdown
        // affordance internally when content overflows.
        expect(pathSelectorPropsRef.current).not.toBeNull();
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
                emptyAutocompleteKinds: [],
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
                        emptyAutocompleteKinds: [],
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
                        emptyAutocompleteKinds: [],
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
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />)).tree;

        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });
});
