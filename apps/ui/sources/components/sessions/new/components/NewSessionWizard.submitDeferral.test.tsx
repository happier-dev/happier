import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            Platform: {
                OS: 'web',
                select: (value: any) => value.web ?? value.default ?? null,
            },
            Dimensions: { get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }) },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    icons: async () => ({
        Ionicons: () => React.createElement('Ionicons'),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(),
            },
        }).module;
    },
});

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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Record<string, unknown>) => React.createElement('Pressable', {
        testID: 'wizard-send',
        onPress: props.onSend,
    }),
}));

vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: () => null,
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

describe('NewSessionWizard submit deferral', () => {
    it('defers web submission by one animation frame before invoking handleCreateSession', async () => {
        vi.useFakeTimers();
        const { renderScreen } = await import('@/dev/testkit');
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const { Platform } = await import('react-native');
        const handleCreateSession = vi.fn();
        const prevRaf = (globalThis as any).requestAnimationFrame;
        delete (globalThis as any).requestAnimationFrame;
        (Platform as any).OS = 'web';

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
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
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
                        sessionPrompt: 'hello',
                        setSessionPrompt: () => {},
                        handleCreateSession,
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />);
        try {
            await screen.pressByTestIdAsync('wizard-send');

            expect(handleCreateSession).not.toHaveBeenCalled();

            await vi.runOnlyPendingTimersAsync();

            expect(handleCreateSession).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
            (globalThis as any).requestAnimationFrame = prevRaf;
            await screen.unmount();
        }
    });
});
