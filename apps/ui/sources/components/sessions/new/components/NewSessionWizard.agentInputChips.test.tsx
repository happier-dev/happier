import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);
const ProfilesListMock = vi.fn((_props: any) => null);
const EnvironmentVariablesPreviewPanelMock = vi.fn((_props: any) => null);

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
    AgentInput: AgentInputMock,
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

vi.mock('@/components/ui/popover', () => ({
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('PopoverPortalTargetProvider', props, props.children),
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('PopoverBoundaryProvider', props, props.children),
    PopoverScope: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: ProfilesListMock,
}));

vi.mock('@/components/sessions/new/components/EnvironmentVariablesPreviewPanel', () => ({
    EnvironmentVariablesPreviewPanel: EnvironmentVariablesPreviewPanelMock,
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: () => null,
}));

function buildProps() {
    const openProfileEnvVarsPreview = vi.fn();
    return {
        layout: {
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
                    status: { connected: '#22c55e' },
                },
            } as any,
            styles: {} as any,
            safeAreaBottom: 0,
            headerHeight: 44,
            newSessionSidePadding: 0,
            newSessionBottomPadding: 0,
        },
        profiles: {
            useProfiles: true,
            profiles: [{ id: 'profile-1', name: 'Work', compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [], isBuiltIn: false }],
            favoriteProfileIds: [],
            setFavoriteProfileIds: () => {},
            selectedProfileId: 'profile-1',
            onPressDefaultEnvironment: () => {},
            onPressProfile: () => {},
            selectedMachineId: 'machine-1',
            getProfileDisabled: () => false,
            getProfileSubtitleExtra: () => null,
            handleAddProfile: () => {},
            openProfileEdit: () => {},
            handleDuplicateProfile: () => {},
            handleDeleteProfile: () => {},
            openProfileEnvVarsPreview,
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
        } as any,
        agent: {
            cliAvailability: { available: true },
            tmuxRequested: false,
            enabledAgentIds: ['codex'],
            isAgentSelectable: () => true,
            isCliBannerDismissed: () => true,
            dismissCliBanner: () => {},
            agentType: 'codex',
            setAgentType: () => {},
            selectedIndicatorColor: '#000',
            profileMap: new Map([['profile-1', { id: 'profile-1', name: 'Work', compatibility: {}, compatibilityByTargetKey: {}, environmentVariables: [], isBuiltIn: false }]]),
            permissionMode: 'default',
            handlePermissionModeChange: () => {},
            modelOptions: [{ value: 'default', label: 'Default', description: '' }],
            modelMode: 'default',
            setModelMode: () => {},
        } as any,
        machine: {
            machines: [],
            serverId: null,
            selectedMachine: { metadata: { displayName: 'Machine 1', host: 'machine-1.local' } } as any,
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
        },
        footer: {
            sessionPrompt: '',
            setSessionPrompt: () => {},
            handleCreateSession: () => {},
            canCreate: true,
            isCreating: false,
            emptyAutocompletePrefixes: [],
            emptyAutocompleteSuggestions: async () => [],
            agentInputExtraActionChips: [],
        } as any,
    };
}

describe('NewSessionWizard agent input chips', () => {
    it('provides a screen-local popover boundary for chip popovers (portal scope comes from the /new screen)', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const popoverBoundaryRef = { current: null } as any;

        const screen = await renderScreen(React.createElement(NewSessionWizard, {
            ...buildProps(),
            popoverBoundaryRef,
        } as any));

        const portalProviders = screen.tree.findAll((node: any) => node?.type === 'PopoverPortalTargetProvider');
        expect(portalProviders.length).toBe(0);

        const boundaryProviders = screen.tree.findAll((node: any) => node?.type === 'PopoverBoundaryProvider');
        expect(boundaryProviders.length).toBe(1);
        expect(boundaryProviders[0]?.props?.boundaryRef).toBe(popoverBoundaryRef);
    });

    it('passes engine picker popover props to AgentInput instead of the legacy agent click handler', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const onAgentPickerSelect = vi.fn();

        AgentInputMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, {
                ...buildProps(),
                agent: {
                    ...buildProps().agent,
                    agentPickerOptions: [
                        { id: 'agent:claude', label: 'Claude' },
                        { id: 'agent:codex', label: 'Codex' },
                    ],
                    agentPickerSelectedOptionId: 'agent:claude',
                    onAgentPickerSelect,
                },
            } as any));

        expect(AgentInputMock).toHaveBeenCalled();
        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;

        expect(props.agentPickerTitle).toBeUndefined();
        expect(props.agentPickerSelectedOptionId).toBe('agent:claude');
        expect(props.agentPickerOptions).toEqual([
            { id: 'agent:claude', label: 'Claude' },
            { id: 'agent:codex', label: 'Codex' },
        ]);
        expect(props.onAgentPickerSelect).toBe(onAgentPickerSelect);
        expect(props.onAgentClick).toBeUndefined();
    });

    it('passes the profile popover to AgentInput and omits the redundant env chip props', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const popoverBoundaryRef = { current: null } as any;

        AgentInputMock.mockClear();
        ProfilesListMock.mockClear();
        EnvironmentVariablesPreviewPanelMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, {
            ...buildProps(),
            popoverBoundaryRef,
        } as any));

        expect(AgentInputMock).toHaveBeenCalled();
        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;

        expect(props.profilePopover).toBeTruthy();
        expect(typeof props.profilePopover?.renderContent).toBe('function');
        expect(props.onProfileClick).toBeUndefined();
        expect(props.envVarsCount).toBeUndefined();
        expect(props.envVarsPopover).toBeUndefined();
        expect(props.onEnvVarsClick).toBeUndefined();

        const profilePopover = props.profilePopover as any;
        const rendered = profilePopover.renderContent({ maxHeight: 420, requestClose: vi.fn() });
        await renderScreen(rendered);
        expect(ProfilesListMock).toHaveBeenCalled();
        const profileListProps = ProfilesListMock.mock.calls[0]?.[0] as any;
        expect(profileListProps.popoverBoundaryRef).toBe(popoverBoundaryRef);
    });

    it('passes machine, path, and resume popover props to AgentInput and drops the legacy chip handlers when provided', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const props = buildProps();
        props.footer.machinePopover = { renderContent: () => null };
        props.footer.pathPopover = { renderContent: () => null };
        props.footer.resumePopover = { renderContent: () => null };
        props.footer.resumeSessionId = 'resume-1';
        props.footer.onResumeClick = () => {};

        AgentInputMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, props as any));

        const agentInputProps = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;

        expect(typeof agentInputProps.machinePopover?.renderContent).toBe('function');
        expect(typeof agentInputProps.pathPopover?.renderContent).toBe('function');
        expect(typeof agentInputProps.resumePopover?.renderContent).toBe('function');
        expect(agentInputProps.onMachineClick).toBeUndefined();
        expect(agentInputProps.onPathClick).toBeUndefined();
        expect(agentInputProps.onResumeClick).toBeUndefined();
    });

    it('passes ACP config probe props through to AgentInput for the wizard action menu popover', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const props = buildProps();
        props.agent.acpConfigOptionsProbe = { phase: 'idle', onRefresh: vi.fn() };
        props.agent.acpConfigOptions = [
            {
                id: 'speed',
                name: 'Speed',
                type: 'select',
                currentValue: 'standard',
                options: [
                    { value: 'standard', name: 'Standard' },
                    { value: 'fast', name: 'Fast' },
                ],
            },
        ];
        props.agent.setAcpConfigOptionOverride = vi.fn();

        AgentInputMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, props as any));

        expect(AgentInputMock).toHaveBeenCalled();
        const agentInputProps = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        expect(agentInputProps.acpConfigOptionsOverrideProbe).toEqual({
            phase: 'idle',
            onRefresh: expect.any(Function),
        });
    });

    it('uses the shared environment preview panel for wizard profile actions instead of the legacy callback', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const props = buildProps();

        ProfilesListMock.mockClear();
        EnvironmentVariablesPreviewPanelMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, props as any));

        const profilesListProps = ProfilesListMock.mock.calls[0]?.[0] as
            | React.ComponentProps<typeof import('@/components/profiles/ProfilesList').ProfilesList>
            | undefined;

        expect(profilesListProps?.onViewEnvironmentVariables).toBeTypeOf('function');

        await act(async () => {
            profilesListProps?.onViewEnvironmentVariables?.(props.profiles.profiles[0]);
        });

        expect(props.profiles.openProfileEnvVarsPreview).not.toHaveBeenCalled();
        expect(EnvironmentVariablesPreviewPanelMock).toHaveBeenCalled();
    });

    it('uses the shared environment preview panel inside profile popover content instead of the legacy callback', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const props = buildProps();

        AgentInputMock.mockClear();
        ProfilesListMock.mockClear();
        EnvironmentVariablesPreviewPanelMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, props as any));

        const agentInputProps = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as {
            profilePopover?: { renderContent?: (args: { maxHeight: number; requestClose: () => void }) => React.ReactNode };
        };
        let popoverTree: renderer.ReactTestRenderer | null = null;

        popoverTree = (await renderScreen(agentInputProps.profilePopover?.renderContent?.({
                    maxHeight: 420,
                    requestClose: () => {},
                }) as React.ReactElement)).tree;

        const popoverProfilesListProps = ProfilesListMock.mock.calls.at(-1)?.[0] as
            | React.ComponentProps<typeof import('@/components/profiles/ProfilesList').ProfilesList>
            | undefined;

        expect(popoverProfilesListProps?.onViewEnvironmentVariables).toBeTypeOf('function');

        await act(async () => {
            popoverProfilesListProps?.onViewEnvironmentVariables?.(props.profiles.profiles[0]);
        });

        expect(props.profiles.openProfileEnvVarsPreview).not.toHaveBeenCalled();
        expect(EnvironmentVariablesPreviewPanelMock).toHaveBeenCalled();

        await act(async () => {
            popoverTree?.unmount();
        });
    });
});
