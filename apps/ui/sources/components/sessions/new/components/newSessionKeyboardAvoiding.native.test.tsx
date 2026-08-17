import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    keyboardListeners: new Map<string, (event?: { endCoordinates?: { height?: number } }) => void>(),
    platform: 'ios' as 'ios' | 'android',
}));
const useKeyboardHandlerMock = vi.fn();
let latestAnimatedStyleFactory: null | (() => any) = null;
const keyboardAnimationState = {
    height: { value: -240 },
    progress: { value: 1 },
};

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Keyboard: {
                addListener: (eventName: string, listener: (event?: { endCoordinates?: { height?: number } }) => void) => {
                    mockEnv.keyboardListeners.set(eventName, listener);
                    return {
                        remove: () => {
                            mockEnv.keyboardListeners.delete(eventName);
                        },
                    };
                },
            },
            Platform: {
                get OS() {
                    return mockEnv.platform;
                },
                select: (value: any) => value[mockEnv.platform] ?? value.native ?? value.default,
            },
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            useWindowDimensions: () => ({ width: 390, height: 844 }),
            Dimensions: {
                get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
            },
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (...args: any[]) => useKeyboardHandlerMock(...args),
    useReanimatedKeyboardAnimation: () => keyboardAnimationState,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: any) => React.createElement('AnimatedView', props, props.children),
        },
        useAnimatedStyle: (fn: any) => {
            latestAnimatedStyleFactory = fn;
            return fn();
        },
        runOnJS: (fn: (...args: any[]) => unknown) => fn,
        useSharedValue: (initial: any) => ({ value: initial }),
    };
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => null,
}));

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/new/attachments/useNewSessionAttachmentsController', () => ({
    useNewSessionAttachmentsController: () => ({
        attachmentsUploadsEnabled: false,
        filePickerRef: { current: null },
        hasSendableAttachments: false,
        agentInputAttachments: [],
        addWebFiles: () => {},
        addPickedAttachments: () => {},
        actionChips: [],
        attachmentRowItems: [],
        handleSend: () => {},
    }),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
    PathSelectionList: () => null,
}));

vi.mock('@/components/sessions/new/components/WizardSectionHeaderRow', () => ({
    WizardSectionHeaderRow: () => null,
}));

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/sessions/new/components/CliNotDetectedBanner', () => ({
    CliNotDetectedBanner: () => null,
}));

vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
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

afterEach(() => {
    standardCleanup();
    mockEnv.keyboardListeners.clear();
    mockEnv.platform = 'ios';
    useKeyboardHandlerMock.mockReset();
    latestAnimatedStyleFactory = null;
    keyboardAnimationState.height.value = -240;
    keyboardAnimationState.progress.value = 1;
});

function buildSimplePanel() {
    return import('./NewSessionSimplePanel').then(({ NewSessionSimplePanel }) => (
        <NewSessionSimplePanel
            popoverBoundaryRef={{ current: null } as any}
            headerHeight={44}
            safeAreaTop={0}
            safeAreaBottom={34}
            newSessionTopPadding={20}
            newSessionSidePadding={16}
            newSessionBottomPadding={8}
            containerStyle={{}}
            promptStore={createNewSessionPromptStore('')}
            setSessionPrompt={() => {}}
            handleCreateSession={() => {}}
            canCreate={true}
            isCreating={false}
            emptyAutocompleteKinds={[]}
            emptyAutocompleteSuggestions={async () => []}
            sessionPromptInputMaxHeight={200}
            agentInputExtraActionChips={[]}
            agentType="codex"
            handleAgentClick={() => {}}
            permissionMode="default"
            handlePermissionModeChange={() => {}}
            modelMode="default"
            setModelMode={() => {}}
            modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
            connectionStatus={undefined}
            machineName={undefined}
            selectedPath=""
            showResumePicker={false}
            resumeSessionId={null}
            isResumeSupportChecking={false}
            useProfiles={false}
            selectedProfileId={null}
        />
    ));
}

function buildWizard() {
    return import('./NewSessionWizard').then(({ NewSessionWizard }) => (
        <NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            layout={{
                theme: {
                    colors: {
                        divider: '#ddd',
                        background: { canvas: '#fff' },
                        shadow: { color: '#000' },
                        groupped: { background: '#fff' },
                        text: '#000',
                        textSecondary: '#666',
                        input: { background: '#fff' },
                        border: { default: '#ddd' },
                        button: { secondary: { tint: '#000' } },
                        warning: '#d97706',
                        state: {
                            warning: { icon: '#d97706', text: '#92400e', background: '#fff8e1', border: '#f5d38f' },
                            neutral: { icon: '#666', text: '#333', background: '#f5f5f5', border: '#ddd' },
                            danger: { icon: '#dc2626', text: '#991b1b', background: '#fee2e2', border: '#fecaca' },
                        },
                        box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                    },
                } as any,
                styles: {
                    container: { flex: 1 },
                } as any,
                safeAreaBottom: 34,
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
                machines: [],
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
            }}
            footer={{
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: true,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                inputMaxHeight: 200,
            }}
        />
    ));
}

describe('new-session native keyboard avoiding', () => {
    it('uses the scaffold keyboard host for the simple panel on iOS', async () => {
        mockEnv.platform = 'ios';
        const screen = await renderScreen(await buildSimplePanel());

        expect(screen.tree.root.findByProps({ testID: 'new-session-composer-keyboard-host' })).toBeTruthy();
        expect(useKeyboardHandlerMock).toHaveBeenCalled();
    });

    it('uses the scaffold keyboard host for the simple panel on Android', async () => {
        mockEnv.platform = 'android';
        const screen = await renderScreen(await buildSimplePanel());

        expect(screen.tree.root.findByProps({ testID: 'new-session-composer-keyboard-host' })).toBeTruthy();
        expect(useKeyboardHandlerMock).toHaveBeenCalled();
    });

    it('translates the simple panel upward on Android keyboard events', async () => {
        mockEnv.platform = 'android';
        await renderScreen(await buildSimplePanel());

        const [handlers] = useKeyboardHandlerMock.mock.calls.at(-1) ?? [];
        act(() => {
            handlers?.onStart?.({ height: 240, progress: 1 });
        });
        const animatedStyle = latestAnimatedStyleFactory?.();
        const translateY = animatedStyle?.transform?.[0]?.translateY;

        expect(translateY).toBeLessThanOrEqual(0);
    });

    it('uses Android native keyboard final-frame events when worklet frames do not arrive', async () => {
        mockEnv.platform = 'android';
        keyboardAnimationState.height.value = 0;
        keyboardAnimationState.progress.value = 0;
        await renderScreen(await buildSimplePanel());

        act(() => {
            mockEnv.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: { height: 320 },
            });
        });

        expect(latestAnimatedStyleFactory?.()?.transform?.[0]?.translateY).toBe(-320);

        act(() => {
            mockEnv.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(latestAnimatedStyleFactory?.()?.transform?.[0]?.translateY).toBe(-34);
    });

    it('uses the scaffold keyboard host for the wizard on iOS', async () => {
        mockEnv.platform = 'ios';
        const screen = await renderScreen(await buildWizard());

        expect(screen.tree.root.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' })).toBeTruthy();
        expect(useKeyboardHandlerMock).toHaveBeenCalled();
    });

    it('uses the scaffold keyboard host for the wizard on Android', async () => {
        mockEnv.platform = 'android';
        const screen = await renderScreen(await buildWizard());

        expect(screen.tree.root.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' })).toBeTruthy();
        expect(useKeyboardHandlerMock).toHaveBeenCalled();
    });
});
