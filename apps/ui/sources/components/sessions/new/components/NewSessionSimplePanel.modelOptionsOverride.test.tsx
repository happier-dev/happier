import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);

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
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                sessionPermissionModeApplyTiming: 'immediate',
            }),
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: AgentInputMock,
}));

describe('NewSessionSimplePanel (modelOptionsOverride)', () => {
    it('passes modelOptions to AgentInput as modelOptionsOverride', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        // Test harness: the implementation only forwards this ref to a View.
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [
                            { value: 'default', label: 'Default', description: '' },
                            { value: 'm1', label: 'Model 1', description: '' },
                        ],
                        connectionStatus: undefined,
                        machineName: undefined,
                        machinePopover: {
                            renderContent: () => null,
                        },
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    }))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const firstCall = AgentInputMock.mock.calls[0];
            expect(firstCall).toBeTruthy();
            const props = (firstCall?.[0] ?? {}) as any;
            expect(props.modelOptionsOverride).toEqual([
                { value: 'default', label: 'Default', description: '' },
                { value: 'm1', label: 'Model 1', description: '' },
            ]);
            expect(typeof props.machinePopover?.renderContent).toBe('function');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the shared profile popover to AgentInput and suppresses separate env/profile click handlers', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: true,
                        selectedProfileId: 'profile-1',
                        profilePopover: {
                            renderContent: () => null,
                        },
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.profileId).toBe('profile-1');
            expect(typeof props.profilePopover?.renderContent).toBe('function');
            expect(props.onProfileClick).toBeUndefined();
            expect(props.envVarsCount).toBeUndefined();
            expect(props.envVarsPopover).toBeUndefined();
            expect(props.onEnvVarsClick).toBeUndefined();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the core machine, path, and resume popover configs through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: 'Builder',
                        machinePopover: { renderContent: () => null },
                        selectedPath: '/repo',
                        pathPopover: { renderContent: () => null },
                        showResumePicker: true,
                        resumeSessionId: 'resume-1',
                        resumePopover: { renderContent: () => null },
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(typeof props.machinePopover?.renderContent).toBe('function');
            expect(typeof props.pathPopover?.renderContent).toBe('function');
            expect(typeof props.resumePopover?.renderContent).toBe('function');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the resume popover config through to AgentInput when resume selection is available', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: true,
                        resumeSessionId: 'resume-42',
                        resumePopover: {
                            renderContent: () => null,
                        },
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.resumeSessionId).toBe('resume-42');
            expect(props.resumePopover).toBeTruthy();
            expect(typeof props.resumePopover?.renderContent).toBe('function');
            expect(props.onResumeClick).toBeUndefined();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes ACP session mode overrides through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'opencode',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        modelOptionsProbe: { phase: 'idle', onRefresh: () => {} },
                        acpSessionModeOptions: [
                            { id: 'default', name: 'Default' },
                            { id: 'plan', name: 'Plan' },
                        ],
                        acpSessionModeProbe: { phase: 'loading', onRefresh: () => {} },
                        acpSessionModeId: null,
                        setAcpSessionModeId: () => {},
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.acpSessionModeOptionsOverride).toEqual([
                { id: 'default', name: 'Default' },
                { id: 'plan', name: 'Plan' },
            ]);
            expect(props.acpSessionModeSelectedIdOverride).toBeNull();
            expect(props.acpSessionModeOptionsOverrideProbe?.phase).toBe('loading');
            expect(typeof props.onAcpSessionModeChange).toBe('function');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes ACP config option overrides through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        const onConfigChange = vi.fn();
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        acpConfigOptions: [
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
                        ],
                        acpConfigOptionsProbe: { phase: 'idle', onRefresh: () => {} },
                        acpConfigOptionOverrides: {
                            v: 1,
                            updatedAt: 123,
                            overrides: {
                                speed: { updatedAt: 123, value: 'fast' },
                            },
                        },
                        setAcpConfigOptionOverride: onConfigChange,
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.acpConfigOptionsOverride).toEqual([
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
            ]);
            expect(props.acpConfigOptionOverridesOverride).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect(props.acpConfigOptionsOverrideProbe).toEqual({ phase: 'idle', onRefresh: expect.any(Function) });
            expect(typeof props.onAcpConfigOptionChange).toBe('function');

            props.onAcpConfigOptionChange('speed', 'standard');
            expect(onConfigChange).toHaveBeenCalledWith('speed', 'standard');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes engine picker popover props through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        const onAgentPickerSelect = vi.fn();
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        sessionPrompt: '',
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompletePrefixes: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'claude',
                        agentPickerTitle: 'Select engine',
                        agentPickerOptions: [
                            { id: 'agent:claude', label: 'Claude' },
                            { id: 'agent:codex', label: 'Codex' },
                        ],
                        agentPickerSelectedOptionId: 'agent:claude',
                        onAgentPickerSelect,
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.agentPickerTitle).toBe('Select engine');
            expect(props.agentPickerSelectedOptionId).toBe('agent:claude');
            expect(props.agentPickerOptions).toEqual([
                { id: 'agent:claude', label: 'Claude' },
                { id: 'agent:codex', label: 'Codex' },
            ]);
            expect(props.onAgentPickerSelect).toBe(onAgentPickerSelect);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

});
